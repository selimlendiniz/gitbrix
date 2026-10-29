//! Repository-changing operations, all via the `git` CLI.

use std::path::Path;

use super::cli::{literal, run, run_progress, run_with_input};
use crate::error::{Error, Result};

fn with_paths(args: &[&str], paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    out.push("--".into());
    out.extend(paths.iter().map(|p| literal(p)));
    out
}

fn run_owned(repo: &Path, args: &[String]) -> Result<()> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run(repo, &refs)?;
    Ok(())
}

fn has_commits(repo: &Path) -> bool {
    run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
}

/// Ref names come from the UI; refuse anything git would read as an option.
fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(Error::msg(format!("Invalid name: {name:?}")));
    }
    Ok(())
}

pub fn stage(repo: &Path, paths: &[String]) -> Result<()> {
    run_owned(repo, &with_paths(&["add", "-A"], paths))?;
    Ok(())
}

pub fn stage_all(repo: &Path) -> Result<()> {
    run(repo, &["add", "-A"])?;
    Ok(())
}

pub fn unstage(repo: &Path, paths: &[String]) -> Result<()> {
    if has_commits(repo) {
        run_owned(repo, &with_paths(&["restore", "--staged"], paths))?;
    } else {
        run_owned(repo, &with_paths(&["rm", "--cached", "-r", "-q"], paths))?;
    }
    Ok(())
}

pub fn unstage_all(repo: &Path) -> Result<()> {
    if has_commits(repo) {
        run(repo, &["restore", "--staged", "--", "."])?;
    } else {
        run(repo, &["rm", "--cached", "-r", "-q", "--", "."])?;
    }
    Ok(())
}

/// Throw away unstaged changes. Tracked files go back to their index
/// version; untracked files are deleted.
/// Apply a patch built by the UI from part of a diff, to the index
/// (staging / unstaging hunks and lines) or the work tree (discarding).
/// `--recount` lets the UI leave hunk line counts approximate.
pub fn apply_patch(repo: &Path, patch: &str, to_index: bool, reverse: bool) -> Result<()> {
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if to_index {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    run_with_input(repo, &args, Some(patch))?;
    Ok(())
}

/// Record an untracked file in the index as empty, so a patch can stage
/// part of its content.
/// A path from the UI must stay inside the work tree.
pub fn check_path(path: &str) -> Result<()> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(Error::msg(format!("Invalid path: {path:?}")));
    }
    Ok(())
}

pub fn intent_to_add(repo: &Path, path: &str) -> Result<()> {
    check_path(path)?;
    run(repo, &["add", "-N", "--", &literal(path)])?;
    Ok(())
}

/// Resolve a conflicted file by writing `content` to it and staging it.
pub fn resolve_with_content(repo: &Path, path: &str, content: &str) -> Result<()> {
    check_path(path)?;
    std::fs::write(repo.join(path), content)?;
    run(repo, &["add", "--", &literal(path)])?;
    Ok(())
}

/// Resolve a conflicted file by taking one side whole. If that side
/// deleted the file, the resolution is the deletion.
pub fn resolve_with_side(repo: &Path, path: &str, side: &str, side_exists: bool) -> Result<()> {
    check_path(path)?;
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(Error::msg(format!("Unknown side {other}"))),
    };
    let lit = literal(path);
    if side_exists {
        run(repo, &["checkout", flag, "--", &lit])?;
        run(repo, &["add", "--", &lit])?;
    } else {
        run(repo, &["rm", "-q", "--", &lit])?;
    }
    Ok(())
}

/// Append `pattern` to the repository's top-level .gitignore.
pub fn ignore(repo: &Path, pattern: &str) -> Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.contains('\n') {
        return Err(Error::msg("Invalid ignore pattern"));
    }
    let file = repo.join(".gitignore");
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(pattern);
    text.push('\n');
    std::fs::write(file, text)?;
    Ok(())
}

pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    if !tracked.is_empty() {
        run_owned(repo, &with_paths(&["restore", "--worktree"], tracked))?;
    }
    if !untracked.is_empty() {
        run_owned(repo, &with_paths(&["clean", "-f", "-q"], untracked))?;
    }
    Ok(())
}

pub fn commit(repo: &Path, message: &str, amend: bool) -> Result<()> {
    if message.trim().is_empty() {
        return Err(Error::msg("Commit message is empty"));
    }
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    run_with_input(repo, &args, Some(message))?;
    Ok(())
}

pub fn checkout_branch(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    run(repo, &["switch", name])?;
    Ok(())
}

/// Check out a remote branch: switch to the local branch tracking it,
/// creating one if needed.
pub fn checkout_remote(repo: &Path, remote_branch: &str, local: &str) -> Result<()> {
    check_name(remote_branch)?;
    check_name(local)?;
    let exists = run(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{local}")]).is_ok();
    if exists {
        run(repo, &["switch", local])?;
    } else {
        run(repo, &["switch", "-c", local, "--track", remote_branch])?;
    }
    Ok(())
}

pub fn checkout_detached(repo: &Path, rev: &str) -> Result<()> {
    check_name(rev)?;
    run(repo, &["switch", "--detach", rev])?;
    Ok(())
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
    check_name(name)?;
    let mut args = if checkout { vec!["switch", "-c", name] } else { vec!["branch", name] };
    if let Some(s) = start {
        check_name(s)?;
        args.push(s);
    }
    run(repo, &args)?;
    Ok(())
}

pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<()> {
    check_name(name)?;
    run(repo, &["branch", if force { "-D" } else { "-d" }, name])?;
    Ok(())
}

pub fn rename_branch(repo: &Path, old: &str, new: &str) -> Result<()> {
    check_name(old)?;
    check_name(new)?;
    run(repo, &["branch", "-m", old, new])?;
    Ok(())
}

pub fn delete_remote_branch(repo: &Path, remote: &str, branch: &str) -> Result<()> {
    check_name(remote)?;
    check_name(branch)?;
    run(repo, &["push", remote, "--delete", branch])?;
    Ok(())
}

pub fn create_tag(repo: &Path, name: &str, target: &str, message: Option<&str>) -> Result<()> {
    check_name(name)?;
    check_name(target)?;
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => run_with_input(repo, &["tag", "-a", name, "-F", "-", target], Some(m))?,
        None => run(repo, &["tag", name, target])?,
    };
    Ok(())
}

pub fn delete_tag(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    run(repo, &["tag", "-d", name])?;
    Ok(())
}

/// Progress callback for long-running network operations.
pub type Progress<'a> = &'a mut dyn FnMut(&str);

pub fn fetch(repo: &Path, progress: Progress) -> Result<()> {
    run_progress(repo, &["fetch", "--all", "--prune", "--tags", "--progress"], progress)?;
    Ok(())
}

pub fn pull(repo: &Path, mode: &str, progress: Progress) -> Result<()> {
    let flag = match mode {
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        other => return Err(Error::msg(format!("Unknown pull mode {other}"))),
    };
    run_progress(repo, &["pull", flag, "--progress"], progress)?;
    Ok(())
}

/// Clone `url` into `parent/name`. Returns the new work tree path.
pub fn clone(parent: &Path, url: &str, name: &str, progress: Progress) -> Result<std::path::PathBuf> {
    if url.starts_with('-') || name.is_empty() || name.starts_with('-') || name.contains('/') {
        return Err(Error::msg("Invalid URL or folder name"));
    }
    let dest = parent.join(name);
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Error::msg(format!("{} already exists and is not empty", dest.display())));
    }
    run_progress(parent, &["clone", "--progress", "--", url, name], progress)?;
    Ok(dest)
}

/// Create a new repository at `path` (created if missing).
pub fn init(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    run(path, &["init", "-q"])?;
    Ok(())
}

/// Push the current branch. Without an upstream, publish it to `origin`
/// (or the only remote) under the same name and start tracking it.
pub fn push(repo: &Path, force: bool, progress: Progress) -> Result<()> {
    let upstream = run(repo, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    let mut args = vec!["push", "--progress"];
    if force {
        args.push("--force-with-lease");
    }
    if upstream.is_err() {
        let remotes = run(repo, &["remote"])?.stdout;
        let remotes: Vec<&str> = remotes.lines().collect();
        let remote = if remotes.contains(&"origin") {
            "origin"
        } else if let [only] = remotes.as_slice() {
            only
        } else if remotes.is_empty() {
            return Err(Error::msg("This repository has no remotes"));
        } else {
            return Err(Error::msg("No upstream set and no 'origin' remote"));
        };
        let remote = remote.to_owned();
        let mut full = args.clone();
        full.extend(["-u", remote.as_str(), "HEAD"]);
        run_progress(repo, &full, progress)?;
        return Ok(());
    }
    run_progress(repo, &args, progress)?;
    Ok(())
}

pub fn add_remote(repo: &Path, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_name(url)?;
    run(repo, &["remote", "add", name, url])?;
    Ok(())
}

pub fn remove_remote(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    run(repo, &["remote", "remove", name])?;
    Ok(())
}

pub fn rename_remote(repo: &Path, old: &str, new: &str) -> Result<()> {
    check_name(old)?;
    check_name(new)?;
    run(repo, &["remote", "rename", old, new])?;
    Ok(())
}

pub fn set_remote_url(repo: &Path, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_name(url)?;
    run(repo, &["remote", "set-url", name, url])?;
    Ok(())
}

pub fn fetch_remote(repo: &Path, remote: &str, progress: Progress) -> Result<()> {
    check_name(remote)?;
    run_progress(repo, &["fetch", "--prune", "--tags", "--progress", remote], progress)?;
    Ok(())
}

/// Push a local branch to `remote` under the same name and track it.
pub fn push_branch(repo: &Path, remote: &str, branch: &str, force: bool, progress: Progress) -> Result<()> {
    check_name(remote)?;
    check_name(branch)?;
    let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let mut args = vec!["push", "--progress", "-u"];
    if force {
        args.push("--force-with-lease");
    }
    args.extend([remote, spec.as_str()]);
    run_progress(repo, &args, progress)?;
    Ok(())
}

pub fn set_upstream(repo: &Path, branch: &str, upstream: Option<&str>) -> Result<()> {
    check_name(branch)?;
    match upstream {
        Some(u) => {
            check_name(u)?;
            run(repo, &["branch", "--set-upstream-to", u, branch])?
        }
        None => run(repo, &["branch", "--unset-upstream", branch])?,
    };
    Ok(())
}

pub fn push_tag(repo: &Path, remote: &str, tag: &str, delete: bool, progress: Progress) -> Result<()> {
    check_name(remote)?;
    check_name(tag)?;
    let spec = if delete { format!(":refs/tags/{tag}") } else { format!("refs/tags/{tag}") };
    run_progress(repo, &["push", "--progress", remote, &spec], progress)?;
    Ok(())
}

/// Initialise and check out submodules at the recorded commits.
pub fn submodule_update(repo: &Path, progress: Progress) -> Result<()> {
    run_progress(repo, &["submodule", "update", "--init", "--recursive", "--progress"], progress)?;
    Ok(())
}

pub fn stash_save(repo: &Path, message: Option<&str>, include_untracked: bool) -> Result<()> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
        args.extend(["-m", m]);
    }
    run(repo, &args)?;
    Ok(())
}

pub fn stash_apply(repo: &Path, index: usize, pop: bool) -> Result<()> {
    let r = format!("stash@{{{index}}}");
    run(repo, &["stash", if pop { "pop" } else { "apply" }, &r])?;
    Ok(())
}

pub fn stash_drop(repo: &Path, index: usize) -> Result<()> {
    let r = format!("stash@{{{index}}}");
    run(repo, &["stash", "drop", &r])?;
    Ok(())
}

/// Put a dropped stash commit back on the stash list (undo of drop).
pub fn stash_store(repo: &Path, id: &str, message: &str) -> Result<()> {
    check_name(id)?;
    run(repo, &["stash", "store", "-m", message, id])?;
    Ok(())
}

pub fn cherry_pick(repo: &Path, oid: &str) -> Result<()> {
    check_name(oid)?;
    run(repo, &["cherry-pick", oid])?;
    Ok(())
}

pub fn revert(repo: &Path, oid: &str) -> Result<()> {
    check_name(oid)?;
    run(repo, &["revert", "--no-edit", oid])?;
    Ok(())
}

pub fn reset(repo: &Path, oid: &str, mode: &str) -> Result<()> {
    check_name(oid)?;
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        // Moves HEAD but refuses to overwrite local changes: used by undo.
        "keep" => "--keep",
        other => return Err(Error::msg(format!("Unknown reset mode {other}"))),
    };
    run(repo, &["reset", flag, oid])?;
    Ok(())
}

pub fn merge(repo: &Path, rev: &str) -> Result<()> {
    check_name(rev)?;
    run(repo, &["merge", "--no-edit", rev])?;
    Ok(())
}

pub fn rebase(repo: &Path, onto: &str) -> Result<()> {
    check_name(onto)?;
    run(repo, &["rebase", onto])?;
    Ok(())
}

/// `--continue`, `--abort` or `--skip` for whatever operation is in
/// progress (`merge`, `rebase`, `cherry-pick`, `revert`).
pub fn sequencer(repo: &Path, op: &str, action: &str) -> Result<()> {
    if !matches!(op, "merge" | "rebase" | "cherry-pick" | "revert") {
        return Err(Error::msg(format!("Unknown operation {op}")));
    }
    if !matches!(action, "continue" | "abort" | "skip") {
        return Err(Error::msg(format!("Unknown action {action}")));
    }
    let flag = format!("--{action}");
    // `--continue` may open an editor for the message; accept it as is.
    run(repo, &["-c", "core.editor=true", op, &flag])?;
    Ok(())
}
