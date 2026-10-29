//! Linked work trees (`git worktree`).

use std::path::Path;

use serde::Serialize;

use super::cli::run;
use crate::error::{Error, Result};

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub head: Option<String>,
    /// Short branch name; `None` when detached.
    pub branch: Option<String>,
    /// The main work tree (the first entry).
    pub main: bool,
    pub locked: bool,
    /// Its directory is gone; `git worktree prune` would drop it.
    pub prunable: bool,
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    Ok(parse(&run(repo, &["worktree", "list", "--porcelain"])?.stdout))
}

pub fn parse(text: &str) -> Vec<Worktree> {
    let mut out = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut wt = Worktree { path: String::new(), head: None, branch: None, main: out.is_empty(), locked: false, prunable: false };
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => wt.path = value.to_owned(),
                "HEAD" => wt.head = Some(value.to_owned()),
                "branch" => wt.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
                "locked" => wt.locked = true,
                "prunable" => wt.prunable = true,
                _ => {}
            }
        }
        if !wt.path.is_empty() {
            out.push(wt);
        }
    }
    out
}

/// New work tree at `path`: on an existing branch, or a new branch
/// created from `start` when `new_branch` is set.
pub fn add(repo: &Path, path: &str, branch: &str, new_branch: bool, start: Option<&str>) -> Result<()> {
    if path.starts_with('-') || branch.is_empty() || branch.starts_with('-') {
        return Err(Error::msg("Invalid path or branch"));
    }
    let mut args = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, "--", path]);
        if let Some(s) = start {
            if s.starts_with('-') {
                return Err(Error::msg("Invalid start point"));
            }
            args.push(s);
        }
    } else {
        args.extend(["--", path, branch]);
    }
    run(repo, &args)?;
    Ok(())
}

/// Ignored files in a work tree (`.env`, `node_modules`, build output):
/// `git worktree remove` deletes them without counting them as changes.
pub fn ignored(path: &Path) -> Result<Vec<String>> {
    let out = run(path, &["status", "--ignored", "--porcelain", "--untracked-files=normal"])?;
    Ok(out.stdout.lines().filter_map(|l| l.strip_prefix("!! ")).map(str::to_owned).collect())
}

pub fn remove(repo: &Path, path: &str, force: bool) -> Result<()> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", path]);
    run(repo, &args)?;
    Ok(())
}

pub fn prune(repo: &Path) -> Result<()> {
    run(repo, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain() {
        let text = "worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD bbb\ndetached\nlocked reason\n\nworktree /gone\nHEAD ccc\nbranch refs/heads/feature/x\nprunable gitdir file points to non-existent location\n";
        let w = parse(text);
        assert_eq!(w.len(), 3);
        assert!(w[0].main && w[0].branch.as_deref() == Some("main"));
        assert!(!w[1].main && w[1].branch.is_none() && w[1].locked);
        assert_eq!(w[2].branch.as_deref(), Some("feature/x"));
        assert!(w[2].prunable);
    }
}
