//! Linked work trees, through libgit2's worktree API.

use std::path::{Path, PathBuf};

use git2::{Repository, Status, StatusOptions, WorktreeAddOptions, WorktreeLockStatus, WorktreePruneOptions};
use serde::Serialize;

use super::repo as repos;
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
    /// Its directory is gone; pruning would drop it.
    pub prunable: bool,
}

/// The main repository, also when `repo` is a linked work tree.
fn main_repo(repo: &Path) -> Result<Repository> {
    let r = repos::open(repo)?;
    if r.is_worktree() {
        return Ok(Repository::open(r.commondir())?);
    }
    Ok(r)
}

fn clean(p: &Path) -> String {
    let s = p.to_string_lossy();
    let t = s.trim_end_matches('/');
    if t.is_empty() { "/".into() } else { t.to_owned() }
}

/// HEAD of a work tree from its admin directory: (commit, branch).
fn head_of(gitdir: &Path, r: &Repository) -> (Option<String>, Option<String>) {
    let text = std::fs::read_to_string(gitdir.join("HEAD")).unwrap_or_default();
    let text = text.trim();
    match text.strip_prefix("ref: ") {
        Some(refname) => (
            r.refname_to_id(refname).ok().map(|o| o.to_string()),
            Some(refname.trim_start_matches("refs/heads/").to_owned()),
        ),
        None => (Some(text.to_owned()).filter(|t| !t.is_empty()), None),
    }
}

pub fn list(repo: &Path) -> Result<Vec<Worktree>> {
    let r = main_repo(repo)?;
    let (head, branch) = head_of(r.path(), &r);
    let mut out = vec![Worktree {
        path: clean(&repos::workdir(&r)),
        head,
        branch,
        main: true,
        locked: false,
        prunable: false,
    }];
    for name in r.worktrees()?.iter().flatten().flatten() {
        let wt = r.find_worktree(name)?;
        let (head, branch) = head_of(&r.path().join("worktrees").join(name), &r);
        out.push(Worktree {
            path: clean(wt.path()),
            head,
            branch,
            main: false,
            locked: matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_))),
            prunable: wt.validate().is_err(),
        });
    }
    // Like git: linked work trees sorted by path after the main one.
    out[1..].sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// A name for the admin directory: the folder's name, made unique.
fn unique_name(r: &Repository, path: &Path) -> Result<String> {
    let base: String = path
        .file_name()
        .map(|n| n.to_string_lossy().chars().map(|c| if c.is_alphanumeric() || "-_.".contains(c) { c } else { '-' }).collect())
        .unwrap_or_else(|| "worktree".into());
    let taken: Vec<String> = r.worktrees()?.iter().flatten().flatten().map(str::to_owned).collect();
    let mut name = base.clone();
    let mut n = 1;
    while taken.contains(&name) || r.path().join("worktrees").join(&name).exists() {
        name = format!("{base}-{n}");
        n += 1;
    }
    Ok(name)
}

/// New work tree at `path`: on an existing branch, or a new branch
/// created from `start` when `new_branch` is set.
pub fn add(repo: &Path, path: &str, branch: &str, new_branch: bool, start: Option<&str>) -> Result<()> {
    if path.is_empty() || path.starts_with('-') || branch.is_empty() || branch.starts_with('-') {
        return Err(Error::msg("Invalid path or branch"));
    }
    let r = main_repo(repo)?;
    let dest = repos::expand_home(Path::new(path));
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Error::msg(format!("{} already exists and is not empty", dest.display())));
    }
    let refname = format!("refs/heads/{branch}");
    if new_branch {
        super::ops::create_branch(repo, branch, start, false)?;
    }
    let result = (|| -> Result<()> {
        let reference = r.find_reference(&refname).map_err(|_| Error::msg(format!("No branch named '{branch}'")))?;
        let checked_out = git2::Branch::wrap(r.find_reference(&refname)?).is_head()
            || list(repo)?.iter().any(|w| w.branch.as_deref() == Some(branch));
        if checked_out {
            return Err(Error::msg(format!("'{branch}' is already checked out in another work tree")));
        }
        let mut opts = WorktreeAddOptions::new();
        opts.reference(Some(&reference));
        r.worktree(&unique_name(&r, &dest)?, &dest, Some(&opts))?;
        Ok(())
    })();
    if result.is_err() && new_branch {
        if let Ok(mut b) = r.find_branch(branch, git2::BranchType::Local) {
            let _ = b.delete();
        }
    }
    result
}

fn status_entries(path: &Path, ignored: bool) -> Result<Vec<(String, Status)>> {
    let r = Repository::open(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).include_ignored(ignored).recurse_ignored_dirs(false);
    let statuses = r.statuses(Some(&mut opts))?;
    Ok(statuses.iter().map(|e| (e.path().unwrap_or("").to_owned(), e.status())).collect())
}

/// Ignored files in a work tree (`.env`, `node_modules`, build output):
/// removing the work tree deletes them without counting them as changes.
pub fn ignored(path: &Path) -> Result<Vec<String>> {
    Ok(status_entries(path, true)?
        .into_iter()
        .filter(|(_, s)| s.contains(Status::IGNORED))
        .map(|(p, _)| p)
        .collect())
}

fn find(r: &Repository, path: &str) -> Result<(git2::Worktree, PathBuf)> {
    let want = std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    for name in r.worktrees()?.iter().flatten().flatten() {
        let wt = r.find_worktree(name)?;
        let p = wt.path().to_path_buf();
        let canon = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
        if canon == want || clean(&p) == clean(Path::new(path)) {
            return Ok((wt, p));
        }
    }
    Err(Error::msg(format!("{path} is not a linked work tree of this repository")))
}

/// Delete a linked work tree. Without `force` it must have no changes
/// (untracked files count; ignored ones don't).
pub fn remove(repo: &Path, path: &str, force: bool) -> Result<()> {
    let r = main_repo(repo)?;
    let (wt, dir) = find(&r, path)?;
    if matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_))) {
        return Err(Error::msg("That work tree is locked"));
    }
    if dir.exists() {
        // Like git: submodule repositories inside may hold the only copy
        // of their commits.
        let has_submodules = Repository::open(&dir)
            .map(|w| w.submodules().map(|subs| subs.iter().any(|s| s.open().is_ok())).unwrap_or(false))
            .unwrap_or(false);
        if has_submodules {
            return Err(Error::msg("That work tree has checked-out submodules; remove it from a terminal or delete it by hand"));
        }
        if !force && !status_entries(&dir, false)?.is_empty() {
            return Err(Error::msg("That work tree has changes; remove it anyway to discard them"));
        }
        std::fs::remove_dir_all(&dir)?;
    }
    wt.prune(Some(WorktreePruneOptions::new().valid(true).working_tree(false)))?;
    Ok(())
}

/// Forget work trees whose directories are gone.
pub fn prune(repo: &Path) -> Result<()> {
    let r = main_repo(repo)?;
    for name in r.worktrees()?.iter().flatten().flatten() {
        let wt = r.find_worktree(name)?;
        if wt.validate().is_err() && !matches!(wt.is_locked(), Ok(WorktreeLockStatus::Locked(_))) {
            wt.prune(None)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_paths() {
        assert_eq!(clean(Path::new("/a/b/")), "/a/b");
        assert_eq!(clean(Path::new("/")), "/");
    }
}
