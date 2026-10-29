//! Tauri command surface. Every command takes the repository path from the
//! frontend and reopens the repository: `git2::Repository` is not `Sync`,
//! and opening is cheap compared with the work each command does.
//!
//! All commands are `async` so git work never blocks the UI thread.

use std::path::{Path, PathBuf};

use git2::Oid;

use crate::error::{Error, Result};
use crate::git::{diff, log, ops, refs, repo, status};

fn open(path: &str) -> Result<git2::Repository> {
    repo::open(Path::new(path))
}

fn workdir(path: &str) -> Result<PathBuf> {
    Ok(repo::workdir(&open(path)?))
}

fn oid(s: &str) -> Result<Oid> {
    Oid::from_str(s).map_err(|_| Error::msg(format!("Not a commit id: {s}")))
}

/// Repository given on the command line (`gitbrix ~/code/project`), if any.
#[tauri::command]
pub fn initial_repo() -> Option<String> {
    let arg = std::env::args_os().skip(1).find(|a| !a.to_string_lossy().starts_with('-'))?;
    let path = std::fs::canonicalize(arg).ok()?;
    Some(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn open_repo(path: String) -> Result<repo::RepoInfo> {
    repo::info(&open(&path)?)
}

#[tauri::command(async)]
pub fn repo_info(repo: String) -> Result<repo::RepoInfo> {
    repo::info(&open(&repo)?)
}

#[tauri::command(async)]
pub fn get_graph(repo: String, limit: usize) -> Result<log::Graph> {
    let r = open(&repo)?;
    let dirty = status::status(&r)?.is_dirty();
    log::graph(&r, limit, dirty)
}

#[tauri::command(async)]
pub fn get_status(repo: String) -> Result<status::WorkingStatus> {
    status::status(&open(&repo)?)
}

#[tauri::command(async)]
pub fn get_stashes(repo: String) -> Result<Vec<refs::StashInfo>> {
    refs::stashes(&mut open(&repo)?)
}

#[tauri::command(async)]
pub fn commit_details(repo: String, id: String) -> Result<diff::CommitDetails> {
    diff::commit_details(&open(&repo)?, oid(&id)?)
}

#[tauri::command(async)]
pub fn commit_file_diff(repo: String, id: String, path: String, old_path: Option<String>) -> Result<diff::FileDiff> {
    diff::commit_file_diff(&open(&repo)?, oid(&id)?, &path, old_path.as_deref())
}

#[tauri::command(async)]
pub fn workdir_file_diff(repo: String, path: String, staged: bool) -> Result<diff::FileDiff> {
    diff::workdir_file_diff(&open(&repo)?, &path, staged)
}

#[tauri::command(async)]
pub fn head_message(repo: String) -> Result<String> {
    let r = open(&repo)?;
    let head = r.head()?.peel_to_commit()?;
    Ok(head.message().unwrap_or("").to_owned())
}

#[tauri::command(async)]
pub fn stage(repo: String, paths: Vec<String>) -> Result<()> {
    ops::stage(&workdir(&repo)?, &paths)
}

#[tauri::command(async)]
pub fn stage_all(repo: String) -> Result<()> {
    ops::stage_all(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn unstage(repo: String, paths: Vec<String>) -> Result<()> {
    ops::unstage(&workdir(&repo)?, &paths)
}

#[tauri::command(async)]
pub fn unstage_all(repo: String) -> Result<()> {
    ops::unstage_all(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn discard(repo: String, paths: Vec<String>) -> Result<()> {
    let r = open(&repo)?;
    let st = status::status(&r)?;
    let (untracked, tracked): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| {
        st.unstaged.iter().any(|e| &e.path == p && e.status == "untracked")
    });
    ops::discard(&repo::workdir(&r), &tracked, &untracked)
}

#[tauri::command(async)]
pub fn commit(repo: String, message: String, amend: bool) -> Result<()> {
    ops::commit(&workdir(&repo)?, &message, amend)
}

#[tauri::command(async)]
pub fn checkout_branch(repo: String, name: String) -> Result<()> {
    ops::checkout_branch(&workdir(&repo)?, &name)
}

#[tauri::command(async)]
pub fn checkout_remote(repo: String, remote_branch: String, local: String) -> Result<()> {
    ops::checkout_remote(&workdir(&repo)?, &remote_branch, &local)
}

#[tauri::command(async)]
pub fn checkout_detached(repo: String, rev: String) -> Result<()> {
    ops::checkout_detached(&workdir(&repo)?, &rev)
}

#[tauri::command(async)]
pub fn create_branch(repo: String, name: String, start: Option<String>, checkout: bool) -> Result<()> {
    ops::create_branch(&workdir(&repo)?, &name, start.as_deref(), checkout)
}

#[tauri::command(async)]
pub fn delete_branch(repo: String, name: String, force: bool) -> Result<()> {
    ops::delete_branch(&workdir(&repo)?, &name, force)
}

#[tauri::command(async)]
pub fn rename_branch(repo: String, old: String, new: String) -> Result<()> {
    ops::rename_branch(&workdir(&repo)?, &old, &new)
}

#[tauri::command(async)]
pub fn delete_remote_branch(repo: String, remote: String, branch: String) -> Result<()> {
    ops::delete_remote_branch(&workdir(&repo)?, &remote, &branch)
}

#[tauri::command(async)]
pub fn create_tag(repo: String, name: String, target: String, message: Option<String>) -> Result<()> {
    ops::create_tag(&workdir(&repo)?, &name, &target, message.as_deref())
}

#[tauri::command(async)]
pub fn delete_tag(repo: String, name: String) -> Result<()> {
    ops::delete_tag(&workdir(&repo)?, &name)
}

#[tauri::command(async)]
pub fn fetch(repo: String) -> Result<()> {
    ops::fetch(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn pull(repo: String, mode: String) -> Result<()> {
    ops::pull(&workdir(&repo)?, &mode)
}

#[tauri::command(async)]
pub fn push(repo: String, force: bool) -> Result<()> {
    ops::push(&workdir(&repo)?, force)
}

#[tauri::command(async)]
pub fn stash_save(repo: String, message: Option<String>, include_untracked: bool) -> Result<()> {
    ops::stash_save(&workdir(&repo)?, message.as_deref(), include_untracked)
}

#[tauri::command(async)]
pub fn stash_apply(repo: String, index: usize, pop: bool) -> Result<()> {
    ops::stash_apply(&workdir(&repo)?, index, pop)
}

#[tauri::command(async)]
pub fn stash_drop(repo: String, index: usize) -> Result<()> {
    ops::stash_drop(&workdir(&repo)?, index)
}

#[tauri::command(async)]
pub fn cherry_pick(repo: String, id: String) -> Result<()> {
    ops::cherry_pick(&workdir(&repo)?, &id)
}

#[tauri::command(async)]
pub fn revert(repo: String, id: String) -> Result<()> {
    ops::revert(&workdir(&repo)?, &id)
}

#[tauri::command(async)]
pub fn reset(repo: String, id: String, mode: String) -> Result<()> {
    ops::reset(&workdir(&repo)?, &id, &mode)
}

#[tauri::command(async)]
pub fn merge(repo: String, rev: String) -> Result<()> {
    ops::merge(&workdir(&repo)?, &rev)
}

#[tauri::command(async)]
pub fn rebase(repo: String, onto: String) -> Result<()> {
    ops::rebase(&workdir(&repo)?, &onto)
}

#[tauri::command(async)]
pub fn sequencer(repo: String, op: String, action: String) -> Result<()> {
    ops::sequencer(&workdir(&repo)?, &op, &action)
}
