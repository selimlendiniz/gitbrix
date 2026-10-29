//! Interactive rebase driven by a plan from the UI instead of an editor.
//!
//! The plan becomes a todo file that `GIT_SEQUENCE_EDITOR` copies into
//! place. Rewording uses an `exec git commit --amend -F <file>` line after
//! the pick, so no editor is needed; squash keeps git's combined message.

use std::path::{Path, PathBuf};

use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};

use super::cli::run_with_env;
use crate::error::{Error, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseCommit {
    pub id: String,
    pub summary: String,
    pub message: String,
    pub author_name: String,
    pub time: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// `pick`, `reword`, `squash`, `fixup` or `drop`.
    pub action: String,
    pub id: String,
    /// New message for `reword`.
    pub message: Option<String>,
}

/// Commits that an interactive rebase onto `base` would replay, oldest
/// first. Fails if `base` isn't an ancestor of HEAD or the range contains
/// merges (a plain todo list would flatten them).
pub fn commits(repo: &Repository, base: &str) -> Result<Vec<RebaseCommit>> {
    let base = Oid::from_str(base).map_err(|_| Error::msg("Invalid base commit"))?;
    let head = repo.head()?.peel_to_commit()?.id();
    if head != base && !repo.graph_descendant_of(head, base)? {
        return Err(Error::msg("That commit is not an ancestor of HEAD"));
    }
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    walk.hide(base)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
    let mut out = Vec::new();
    for oid in walk {
        let c = repo.find_commit(oid?)?;
        if c.parent_count() > 1 {
            return Err(Error::msg("The range contains merge commits; interactive rebase would flatten them"));
        }
        out.push(RebaseCommit {
            id: c.id().to_string(),
            summary: c.summary().ok().flatten().unwrap_or("").to_owned(),
            message: c.message().ok().unwrap_or("").to_owned(),
            author_name: c.author().name().unwrap_or("").to_owned(),
            time: c.author().when().seconds(),
        });
    }
    Ok(out)
}

fn shell_quote(p: &Path) -> String {
    format!("'{}'", p.to_string_lossy().replace('\'', r"'\''"))
}

/// Our scratch space for one rebase: todo file and reword messages.
fn scratch_dir(repo: &Repository) -> PathBuf {
    repo.path().join("gitbrix-rebase")
}

pub fn todo(steps: &[RebaseStep], scratch: &Path) -> Result<(String, Vec<(PathBuf, String)>)> {
    let mut lines = Vec::new();
    let mut messages = Vec::new();
    for (i, s) in steps.iter().enumerate() {
        if Oid::from_str(&s.id).is_err() {
            return Err(Error::msg(format!("Invalid commit id {}", s.id)));
        }
        match s.action.as_str() {
            "pick" | "drop" | "fixup" | "squash" => lines.push(format!("{} {}", s.action, s.id)),
            "reword" => {
                let msg = s.message.as_deref().unwrap_or("").trim();
                if msg.is_empty() {
                    return Err(Error::msg("A reworded commit needs a message"));
                }
                let file = scratch.join(format!("msg-{i}"));
                lines.push(format!("pick {}", s.id));
                lines.push(format!("exec git commit --amend --allow-empty --no-verify -q -F {}", shell_quote(&file)));
                messages.push((file, format!("{msg}\n")));
            }
            other => return Err(Error::msg(format!("Unknown action {other}"))),
        }
    }
    // Squash/fixup need something earlier to fold into.
    let first_kept = steps.iter().position(|s| s.action != "drop");
    if let Some(i) = first_kept {
        if matches!(steps[i].action.as_str(), "squash" | "fixup") {
            return Err(Error::msg("The first commit can't be squashed or fixed up into nothing"));
        }
    }
    Ok((lines.join("\n") + "\n", messages))
}

pub fn run(repo: &Repository, workdir: &Path, base: &str, steps: &[RebaseStep]) -> Result<()> {
    if base.starts_with('-') || Oid::from_str(base).is_err() {
        return Err(Error::msg("Invalid base commit"));
    }
    // A stopped rebase may still need the message files in our scratch dir.
    if repo.state() != git2::RepositoryState::Clean {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    let expected: Vec<String> = commits(repo, base)?.into_iter().map(|c| c.id).collect();
    let mut planned: Vec<String> = steps.iter().map(|s| s.id.clone()).collect();
    planned.sort();
    let mut sorted = expected.clone();
    sorted.sort();
    if planned != sorted {
        return Err(Error::msg("The plan doesn't match the commits being rebased; refresh and try again"));
    }

    let scratch = scratch_dir(repo);
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch)?;
    let (todo_text, messages) = todo(steps, &scratch)?;
    for (file, msg) in &messages {
        std::fs::write(file, msg)?;
    }
    let todo_file = scratch.join("todo");
    std::fs::write(&todo_file, todo_text)?;

    let seq_editor = format!("cp {}", shell_quote(&todo_file));
    run_with_env(
        workdir,
        &["rebase", "-i", "--autostash", base],
        &[("GIT_SEQUENCE_EDITOR", seq_editor.as_str()), ("GIT_EDITOR", "true")],
    )?;
    // Message files are still needed if the rebase stopped on a conflict;
    // they are cleared at the start of the next rebase.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: &str, id: &str) -> RebaseStep {
        RebaseStep { action: action.into(), id: id.into(), message: None }
    }

    #[test]
    fn builds_todo_with_reword_exec() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let mut r = step("reword", &b);
        r.message = Some("New title\n\nbody".into());
        let (todo, msgs) = todo(&[step("pick", &a), r], Path::new("/x/y z")).unwrap();
        assert_eq!(
            todo,
            format!("pick {a}\npick {b}\nexec git commit --amend --allow-empty --no-verify -q -F '/x/y z/msg-1'\n")
        );
        assert_eq!(msgs[0].1, "New title\n\nbody\n");
    }

    #[test]
    fn rejects_bad_plans() {
        let a = "a".repeat(40);
        assert!(todo(&[step("squash", &a)], Path::new("/t")).is_err());
        assert!(todo(&[step("drop", &a), step("fixup", &a)], Path::new("/t")).is_err());
        assert!(todo(&[step("edit", &a)], Path::new("/t")).is_err());
        assert!(todo(&[step("pick", "nothex")], Path::new("/t")).is_err());
        assert!(todo(&[step("reword", &a)], Path::new("/t")).is_err());
    }
}
