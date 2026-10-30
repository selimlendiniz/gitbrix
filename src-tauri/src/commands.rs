//! Tauri command surface. Every command takes the repository path from the
//! frontend and reopens the repository: `git2::Repository` is not `Sync`,
//! and opening is cheap compared with the work each command does.
//!
//! All commands are `async` so git work never blocks the UI thread.

use std::path::{Path, PathBuf};

use git2::Oid;

use crate::error::{Error, Result};
use crate::accounts;
use crate::forge;
use crate::profiles;
use crate::terminal::{self, Terminals};
use crate::git::{bisect, cleanup, diff, history, lfs, log, net, ops, patch, rebase, refs, repo, stats, status, workspace, worktree};
use crate::watch::{self, WatchState};

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

#[tauri::command]
pub fn watch_repo(app: tauri::AppHandle, state: tauri::State<WatchState>, repo: String) -> Result<()> {
    watch::watch(app, &state, &repo)
}

#[tauri::command]
pub fn unwatch_repo(state: tauri::State<WatchState>) {
    watch::unwatch(&state);
}

#[tauri::command(async)]
pub fn repo_info(repo: String) -> Result<repo::RepoInfo> {
    repo::info(&open(&repo)?)
}

#[tauri::command(async)]
pub fn get_graph(repo: String, limit: usize, filter: Option<log::GraphFilter>) -> Result<log::Graph> {
    let r = open(&repo)?;
    let dirty = status::status(&r)?.is_dirty();
    log::graph_filtered(&r, limit, dirty, &filter.unwrap_or_default())
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
pub fn commit_file_diff(
    repo: String,
    id: String,
    path: String,
    old_path: Option<String>,
    ignore_ws: Option<bool>,
) -> Result<diff::FileDiff> {
    diff::commit_file_diff(&open(&repo)?, oid(&id)?, &path, old_path.as_deref(), ignore_ws.unwrap_or(false))
}

#[tauri::command(async)]
pub fn compare_commits(repo: String, from: String, to: String) -> Result<Vec<diff::FileChange>> {
    diff::compare(&open(&repo)?, oid(&from)?, oid(&to)?)
}

#[tauri::command(async)]
pub fn compare_file_diff(
    repo: String,
    from: String,
    to: String,
    path: String,
    old_path: Option<String>,
    ignore_ws: Option<bool>,
) -> Result<diff::FileDiff> {
    diff::compare_file_diff(&open(&repo)?, oid(&from)?, oid(&to)?, &path, old_path.as_deref(), ignore_ws.unwrap_or(false))
}

/// `rev`: commit id, `<id>^`, `:` (index) or none (work tree).
#[tauri::command(async)]
pub fn file_base64(repo: String, rev: Option<String>, path: String) -> Result<Option<String>> {
    ops::check_path(&path)?;
    if let Some(r) = &rev {
        let id = r.trim_end_matches('^');
        if r != ":" && Oid::from_str(id).is_err() {
            return Err(Error::msg("Invalid revision"));
        }
    }
    diff::file_base64(&open(&repo)?, rev.as_deref(), &path)
}

#[tauri::command(async)]
pub fn workdir_file_diff(repo: String, path: String, staged: bool) -> Result<diff::FileDiff> {
    diff::workdir_file_diff(&open(&repo)?, &path, staged)
}

#[tauri::command(async)]
pub fn file_history(repo: String, path: String, limit: usize) -> Result<Vec<history::HistoryEntry>> {
    history::file_history(&workdir(&repo)?, &path, limit)
}

#[tauri::command(async)]
pub fn search_history(repo: String, mode: String, query: String, limit: usize) -> Result<Vec<String>> {
    history::search(&workdir(&repo)?, &mode, &query, limit)
}

#[tauri::command(async)]
pub fn reflog(repo: String, limit: usize) -> Result<Vec<history::ReflogEntry>> {
    history::reflog(&open(&repo)?, limit)
}

#[tauri::command(async)]
pub fn blame(repo: String, path: String, rev: Option<String>) -> Result<history::Blame> {
    history::blame(&workdir(&repo)?, &path, rev.as_deref())
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

/// `target` is `index` or `worktree`. `intent_to_add` names an untracked
/// file that must be known to the index before part of it can be staged.
#[tauri::command(async)]
pub fn apply_patch(repo: String, patch: String, target: String, reverse: bool, intent_to_add: Option<String>) -> Result<()> {
    let wd = workdir(&repo)?;
    if let Some(p) = intent_to_add {
        ops::intent_to_add(&wd, &p)?;
    }
    ops::apply_patch(&wd, &patch, target == "index", reverse)
}

#[tauri::command(async)]
pub fn conflict_file(repo: String, path: String) -> Result<status::ConflictFile> {
    status::conflict_file(&open(&repo)?, &path)
}

#[tauri::command(async)]
pub fn resolve_conflict(repo: String, path: String, content: Option<String>, side: Option<String>) -> Result<()> {
    let r = open(&repo)?;
    let wd = repo::workdir(&r);
    match (content, side) {
        (Some(c), None) => ops::resolve_with_content(&wd, &path, &c),
        (None, Some(side)) => {
            let cf = status::conflict_file(&r, &path)?;
            let exists = if side == "ours" { cf.ours.is_some() } else { cf.theirs.is_some() };
            ops::resolve_with_side(&wd, &path, &side, exists)
        }
        _ => Err(Error::msg("Give either content or a side")),
    }
}

#[tauri::command(async)]
pub fn ignore(repo: String, pattern: String) -> Result<()> {
    ops::ignore(&workdir(&repo)?, &pattern)
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

/// Change the last commit's message only; staged changes stay staged.
#[tauri::command(async)]
pub fn reword_head(repo: String, message: String) -> Result<()> {
    ops::reword_head(&workdir(&repo)?, &message)
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
pub fn move_branch(repo: String, name: String, target: String) -> Result<()> {
    ops::move_branch(&workdir(&repo)?, &name, &target)
}

#[tauri::command(async)]
pub fn rename_branch(repo: String, old: String, new: String) -> Result<()> {
    ops::rename_branch(&workdir(&repo)?, &old, &new)
}

#[tauri::command(async)]
pub fn delete_remote_branch(repo: String, remote: String, branch: String) -> Result<()> {
    net::delete_remote_branch(&workdir(&repo)?, &remote, &branch)
}

#[tauri::command(async)]
pub fn create_tag(repo: String, name: String, target: String, message: Option<String>) -> Result<()> {
    ops::create_tag(&workdir(&repo)?, &name, &target, message.as_deref())
}

#[tauri::command(async)]
pub fn delete_tag(repo: String, name: String) -> Result<()> {
    ops::delete_tag(&workdir(&repo)?, &name)
}

/// Emits `git-progress` events with progress lines.
fn progress(app: &tauri::AppHandle) -> impl FnMut(&str) + '_ {
    use tauri::Emitter;
    let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
    move |line: &str| {
        // Git redraws progress very often; the UI needs a few per second.
        if last.elapsed() >= std::time::Duration::from_millis(100) || line.contains("done") {
            last = std::time::Instant::now();
            let _ = app.emit("git-progress", line);
        }
    }
}

#[tauri::command(async)]
pub fn fetch(app: tauri::AppHandle, repo: String) -> Result<()> {
    net::fetch(&workdir(&repo)?, &mut progress(&app))
}

#[tauri::command(async)]
pub fn pull(app: tauri::AppHandle, repo: String, mode: String) -> Result<()> {
    net::pull(&workdir(&repo)?, &mode, &mut progress(&app))
}

#[tauri::command(async)]
pub fn push(app: tauri::AppHandle, repo: String, force: bool) -> Result<()> {
    net::push(&workdir(&repo)?, force, &mut progress(&app))
}

#[tauri::command(async)]
pub fn get_remotes(repo: String) -> Result<Vec<refs::RemoteInfo>> {
    refs::remotes(&open(&repo)?)
}

#[tauri::command(async)]
pub fn add_remote(repo: String, name: String, url: String) -> Result<()> {
    ops::add_remote(&workdir(&repo)?, name.trim(), url.trim())
}

#[tauri::command(async)]
pub fn remove_remote(repo: String, name: String) -> Result<()> {
    ops::remove_remote(&workdir(&repo)?, &name)
}

#[tauri::command(async)]
pub fn rename_remote(repo: String, old: String, new: String) -> Result<()> {
    ops::rename_remote(&workdir(&repo)?, &old, new.trim())
}

#[tauri::command(async)]
pub fn set_remote_url(repo: String, name: String, url: String) -> Result<()> {
    ops::set_remote_url(&workdir(&repo)?, &name, url.trim())
}

#[tauri::command(async)]
pub fn fetch_remote(app: tauri::AppHandle, repo: String, remote: String) -> Result<()> {
    net::fetch_remote(&workdir(&repo)?, &remote, &mut progress(&app))
}

#[tauri::command(async)]
pub fn push_branch(app: tauri::AppHandle, repo: String, remote: String, branch: String, force: bool) -> Result<()> {
    net::push_branch(&workdir(&repo)?, &remote, &branch, force, &mut progress(&app))
}

#[tauri::command(async)]
pub fn set_upstream(repo: String, branch: String, upstream: Option<String>) -> Result<()> {
    ops::set_upstream(&workdir(&repo)?, &branch, upstream.as_deref())
}

#[tauri::command(async)]
pub fn push_tag(app: tauri::AppHandle, repo: String, remote: String, tag: String, delete: bool) -> Result<()> {
    net::push_tag(&workdir(&repo)?, &remote, &tag, delete, &mut progress(&app))
}

#[tauri::command(async)]
pub fn get_submodules(repo: String) -> Result<Vec<refs::SubmoduleInfo>> {
    refs::submodules(&open(&repo)?)
}

#[tauri::command(async)]
pub fn submodule_update(app: tauri::AppHandle, repo: String) -> Result<()> {
    net::submodule_update(&workdir(&repo)?, &mut progress(&app))
}

#[tauri::command(async)]
pub fn get_worktrees(repo: String) -> Result<Vec<worktree::Worktree>> {
    worktree::list(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn add_worktree(repo: String, path: String, branch: String, new_branch: bool, start: Option<String>) -> Result<()> {
    worktree::add(&workdir(&repo)?, path.trim(), branch.trim(), new_branch, start.as_deref())
}

#[tauri::command(async)]
pub fn remove_worktree(repo: String, path: String, force: bool) -> Result<()> {
    worktree::remove(&workdir(&repo)?, &path, force)
}

#[tauri::command(async)]
pub fn worktree_ignored(path: String) -> Result<Vec<String>> {
    worktree::ignored(Path::new(&path))
}

#[tauri::command(async)]
pub fn prune_worktrees(repo: String) -> Result<()> {
    worktree::prune(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn clone_repo(app: tauri::AppHandle, url: String, parent: String, name: String) -> Result<String> {
    let parent = repo::expand_home(Path::new(parent.trim()));
    let dest = net::clone(&parent, url.trim(), name.trim(), &mut progress(&app))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn init_repo(path: String) -> Result<String> {
    let p = repo::expand_home(Path::new(path.trim()));
    ops::init(&p)?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn stash_save(repo: String, message: Option<String>, include_untracked: bool) -> Result<()> {
    ops::stash_save(&workdir(&repo)?, message.as_deref(), include_untracked)
}

/// The UI's stash list can be stale (a `git stash` in a terminal shifts
/// the indices). With `id`, act on that stash wherever it is now.
fn stash_index(repo: &str, index: usize, id: Option<String>) -> Result<usize> {
    let Some(id) = id else { return Ok(index) };
    refs::stashes(&mut open(repo)?)?
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.index)
        .ok_or_else(|| Error::msg("That stash no longer exists"))
}

#[tauri::command(async)]
pub fn stash_apply(repo: String, index: usize, pop: bool, id: Option<String>) -> Result<()> {
    let index = stash_index(&repo, index, id)?;
    ops::stash_apply(&workdir(&repo)?, index, pop)
}

#[tauri::command(async)]
pub fn stash_drop(repo: String, index: usize, id: Option<String>) -> Result<()> {
    let index = stash_index(&repo, index, id)?;
    ops::stash_drop(&workdir(&repo)?, index)
}

#[tauri::command(async)]
pub fn stash_store(repo: String, id: String, message: String) -> Result<()> {
    ops::stash_store(&workdir(&repo)?, &id, &message)
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
    rebase::onto(&open(&repo)?, &onto)
}

#[tauri::command(async)]
pub fn rebase_commits(repo: String, base: String) -> Result<Vec<rebase::RebaseCommit>> {
    rebase::commits(&open(&repo)?, &base)
}

#[tauri::command(async)]
pub fn interactive_rebase(repo: String, base: String, steps: Vec<rebase::RebaseStep>) -> Result<()> {
    rebase::run(&open(&repo)?, &base, &steps)
}

#[tauri::command(async)]
pub fn sequencer(repo: String, op: String, action: String) -> Result<()> {
    ops::sequencer(&workdir(&repo)?, &op, &action)
}

#[tauri::command(async)]
pub fn get_accounts() -> Result<Vec<accounts::Account>> {
    accounts::list()
}

/// Checks the token with the service before saving it.
#[tauri::command(async)]
pub fn add_account(provider: String, url: String, token: String) -> Result<accounts::Account> {
    accounts::add(&provider, &url, &token)
}

#[tauri::command(async)]
pub fn remove_account(id: String) -> Result<()> {
    accounts::remove(&id)
}

#[tauri::command(async)]
pub fn pull_requests(repo: String) -> Result<forge::PullRequests> {
    forge::list(&workdir(&repo)?)
}

/// Requests involving the user across every account.
#[tauri::command(async)]
pub fn pull_request_inbox() -> Result<forge::Inbox> {
    forge::inbox()
}

#[tauri::command(async)]
pub fn approve_pull_request(account: String, project: String, number: u64) -> Result<()> {
    forge::approve(&account, &project, number)
}

/// For requests from forks; same-repository ones check out their branch.
#[tauri::command(async)]
pub fn checkout_pull_request(app: tauri::AppHandle, repo: String, remote: String, number: u64) -> Result<String> {
    let path = workdir(&repo)?;
    let provider = forge::provider_of_remote(&path, &remote)?;
    net::checkout_pull_request(&path, &remote, &provider, number, &mut progress(&app))
}

#[tauri::command(async)]
pub fn repo_summaries(paths: Vec<String>) -> Vec<workspace::Summary> {
    workspace::summaries(&paths)
}

#[tauri::command(async)]
pub fn find_repos(dir: String) -> Vec<String> {
    workspace::find(Path::new(&dir), 3)
}

#[tauri::command]
pub fn get_profiles() -> profiles::Profiles {
    profiles::load()
}

#[tauri::command]
pub fn save_profiles(profiles: profiles::Profiles) -> Result<profiles::Profiles> {
    profiles::save(profiles)
}

/// Who commits in the repository, and where that comes from.
#[tauri::command(async)]
pub fn identity(repo: String) -> Result<profiles::Identity> {
    Ok(profiles::identity(&open(&repo)?))
}

/// A shell in the repository's folder; returns the session id.
#[tauri::command]
pub fn terminal_open(app: tauri::AppHandle, state: tauri::State<Terminals>, repo: String, cols: u16, rows: u16) -> Result<u32> {
    terminal::open(app, &state, &workdir(&repo)?.to_string_lossy(), cols, rows)
}

#[tauri::command]
pub fn terminal_write(state: tauri::State<Terminals>, id: u32, data: String) -> Result<()> {
    terminal::write(&state, id, &data)
}

#[tauri::command]
pub fn terminal_resize(state: tauri::State<Terminals>, id: u32, cols: u16, rows: u16) -> Result<()> {
    terminal::resize(&state, id, cols, rows)
}

#[tauri::command]
pub fn terminal_close(state: tauri::State<Terminals>, id: u32) -> Result<()> {
    terminal::close(&state, id)
}

/// Default target branch and possible reviewers for a new request.
#[tauri::command(async)]
pub fn pull_request_form(repo: String, remote: String) -> Result<forge::RequestForm> {
    forge::request_form(&workdir(&repo)?, &remote)
}

#[tauri::command(async)]
pub fn create_pull_request(repo: String, remote: String, request: forge::NewRequest) -> Result<forge::Created> {
    forge::create(&workdir(&repo)?, &remote, &request)
}

/// Fetch a request and its target branch; the commits to compare.
#[tauri::command(async)]
pub fn pull_request_range(app: tauri::AppHandle, repo: String, remote: String, number: u64, target: String) -> Result<net::RequestRange> {
    let dir = workdir(&repo)?;
    let provider = forge::provider_of_remote(&dir, &remote)?;
    net::pull_request_range(&dir, &remote, &provider, number, &target, &mut progress(&app))
}

#[tauri::command(async)]
pub fn pull_request_conversation(repo: String, remote: String, number: u64) -> Result<forge::Conversation> {
    forge::conversation(&workdir(&repo)?, &remote, number)
}

#[tauri::command(async)]
pub fn comment_pull_request(repo: String, remote: String, number: u64, body: String) -> Result<()> {
    forge::comment(&workdir(&repo)?, &remote, number, &body)
}

#[tauri::command(async)]
pub fn merge_pull_request(repo: String, remote: String, number: u64, method: String, delete_branch: bool) -> Result<()> {
    forge::merge(&workdir(&repo)?, &remote, number, &method, delete_branch)
}

/// CI status of commits (only those that have one).
#[tauri::command(async)]
pub fn ci_statuses(repo: String, shas: Vec<String>) -> Result<std::collections::HashMap<String, forge::Ci>> {
    forge::ci_statuses(&workdir(&repo)?, &shas)
}

/// How many LFS files in the work tree are still pointers.
#[tauri::command(async)]
pub fn lfs_pending(repo: String) -> Result<usize> {
    Ok(lfs::pending(&open(&repo)?)?.len())
}

/// Download LFS content for the files that are still pointers.
#[tauri::command(async)]
pub fn lfs_pull(app: tauri::AppHandle, repo: String) -> Result<usize> {
    lfs::pull(&workdir(&repo)?, &mut progress(&app))
}

/// Track files matching `pattern` with LFS (.gitattributes).
#[tauri::command(async)]
pub fn lfs_track(repo: String, pattern: String) -> Result<()> {
    lfs::track(&workdir(&repo)?, &pattern)
}

/// Commits as a mailbox of patches (`git format-patch`), oldest first.
/// With `from`, the commits after it up to the single id in `ids`.
#[tauri::command(async)]
pub fn format_patch(repo: String, ids: Vec<String>, from: Option<String>) -> Result<String> {
    let r = open(&repo)?;
    let ids: Vec<Oid> = match (&from, ids.as_slice()) {
        (Some(f), [to]) => patch::range(&r, oid(f)?, oid(to)?)?,
        _ => ids.iter().map(|i| oid(i)).collect::<Result<_>>()?,
    };
    patch::format(&r, &ids)
}

/// Write `text` to `path` (a file the user picked in a save dialog).
#[tauri::command(async)]
pub fn save_text_file(path: String, text: String) -> Result<()> {
    Ok(std::fs::write(path, text)?)
}

/// Apply a patch file: to the work tree, or as commits (`git am`).
#[tauri::command(async)]
pub fn apply_patch_file(repo: String, path: String, commit: bool) -> Result<usize> {
    let text = std::fs::read(&path).map_err(|e| Error::msg(format!("Can't read {path}: {e}")))?;
    patch::apply(&workdir(&repo)?, &String::from_utf8_lossy(&text), commit)
}

/// What a patch file holds: each patch's subject (empty for a plain diff).
#[tauri::command(async)]
pub fn read_patch_file(path: String) -> Result<Vec<String>> {
    let text = std::fs::read(&path).map_err(|e| Error::msg(format!("Can't read {path}: {e}")))?;
    Ok(patch::parse(&String::from_utf8_lossy(&text)).into_iter().map(|m| m.subject).collect())
}

/// Cherry-pick commits onto HEAD in the given order (oldest first).
#[tauri::command(async)]
pub fn cherry_pick_many(repo: String, ids: Vec<String>) -> Result<()> {
    rebase::pick_onto_head(&open(&repo)?, &ids)
}

/// Revert commits in the given order (newest first).
#[tauri::command(async)]
pub fn revert_many(repo: String, ids: Vec<String>) -> Result<usize> {
    ops::revert_many(&workdir(&repo)?, &ids)
}

/// Branches that can be deleted: merged, or whose upstream is gone.
#[tauri::command(async)]
pub fn stale_branches(repo: String) -> Result<Vec<cleanup::Stale>> {
    cleanup::stale(&open(&repo)?)
}

#[tauri::command(async)]
pub fn bisect_status(repo: String) -> Result<bisect::Status> {
    bisect::status(&open(&repo)?)
}

#[tauri::command(async)]
pub fn bisect_start(repo: String, bad: String, good: String) -> Result<bisect::Status> {
    bisect::start(&workdir(&repo)?, &bad, &good)
}

/// `good`, `bad` or `skip` for `rev`, or for the commit being tested.
#[tauri::command(async)]
pub fn bisect_mark(repo: String, verdict: String, rev: Option<String>) -> Result<bisect::Status> {
    bisect::verdict(&workdir(&repo)?, &verdict, rev.as_deref())
}

#[tauri::command(async)]
pub fn bisect_reset(repo: String) -> Result<()> {
    bisect::reset(&workdir(&repo)?)
}

#[tauri::command(async)]
pub fn bisect_run(app: tauri::AppHandle, repo: String, command: String) -> Result<bisect::Status> {
    bisect::run(&workdir(&repo)?, &command, &mut progress(&app))
}

/// Comment on a line of a request's diff.
#[tauri::command(async)]
pub fn comment_pull_request_line(repo: String, remote: String, number: u64, at: forge::LineRef, body: String) -> Result<()> {
    forge::line_comment(&workdir(&repo)?, &remote, number, &at, &body)
}

/// Commits since the previous tag, as release notes.
#[tauri::command(async)]
pub fn release_notes(repo: String, tag: String) -> Result<String> {
    ops::check_name(&tag)?;
    history::release_notes(&open(&repo)?, &tag)
}

/// Make a GitHub/GitLab release of a tag already pushed to `remote`.
#[tauri::command(async)]
pub fn create_release(repo: String, remote: String, release: forge::NewRelease) -> Result<String> {
    forge::release(&workdir(&repo)?, &remote, &release)
}

/// One folder of a commit's file tree.
#[tauri::command(async)]
pub fn tree_at(repo: String, rev: String, dir: String) -> Result<Vec<history::TreeEntry>> {
    if !dir.is_empty() {
        ops::check_path(&dir)?;
    }
    history::tree_at(&open(&repo)?, &rev, &dir)
}

/// A file's content at a commit.
#[tauri::command(async)]
pub fn file_at(repo: String, rev: String, path: String) -> Result<history::FileAt> {
    ops::check_path(&path)?;
    history::file_at(&open(&repo)?, &rev, &path)
}

/// Who commits, when, and which files change most, on the current branch.
#[tauri::command(async)]
pub fn repo_stats(repo: String) -> Result<stats::Stats> {
    stats::stats(&open(&repo)?)
}
