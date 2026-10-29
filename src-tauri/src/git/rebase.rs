//! Rebases, plain and interactive, done by replaying commits with libgit2.
//!
//! The state of a running rebase lives in `.git/rebase-merge/` like git's
//! own (so libgit2 and git both report "rebase in progress"), with our
//! plan in `gitbrix.json`. Each step cherry-picks one commit onto HEAD
//! (detached while the rebase runs); a conflict stops the rebase with the
//! conflict in the work tree, and `continue` / `skip` / `abort` pick it up
//! from there. Local changes are stashed first and restored at the end.

use std::path::PathBuf;

use git2::build::CheckoutBuilder;
use git2::{Commit, Oid, Repository, RepositoryState, StashFlags};
use serde::{Deserialize, Serialize};

use super::{ops, sign, status};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// `pick`, `reword`, `squash`, `fixup` or `drop`.
    pub action: String,
    pub id: String,
    /// New message for `reword`.
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// The branch being rebased (`refs/heads/x`); `None` when detached.
    head_name: Option<String>,
    orig_head: String,
    onto: String,
    /// Steps still to do, in order.
    todo: Vec<RebaseStep>,
    /// The step that stopped on conflicts, and HEAD at that moment.
    current: Option<RebaseStep>,
    stopped_at: Option<String>,
    /// Stash commit holding the local changes from before the rebase.
    autostash: Option<String>,
    /// Some commit of the range is on top of `onto` already; until then a
    /// squash has nothing of ours to fold into.
    #[serde(default)]
    replayed: bool,
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
    let mut out = Vec::new();
    for c in range(repo, base, head)? {
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

/// Commits reachable from `head` but not from `base`, oldest first.
fn range(repo: &Repository, base: Oid, head: Oid) -> Result<Vec<Commit<'_>>> {
    let mut walk = repo.revwalk()?;
    walk.push(head)?;
    walk.hide(base)?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::REVERSE)?;
    walk.map(|oid| Ok(repo.find_commit(oid?)?)).collect()
}

/// Check a plan from the UI: known actions, valid ids, something to fold
/// squashes into.
pub fn validate(steps: &[RebaseStep]) -> Result<()> {
    for s in steps {
        if Oid::from_str(&s.id).is_err() {
            return Err(Error::msg(format!("Invalid commit id {}", s.id)));
        }
        match s.action.as_str() {
            "pick" | "drop" | "fixup" | "squash" => {}
            "reword" => {
                if s.message.as_deref().unwrap_or("").trim().is_empty() {
                    return Err(Error::msg("A reworded commit needs a message"));
                }
            }
            other => return Err(Error::msg(format!("Unknown action {other}"))),
        }
    }
    let first_kept = steps.iter().position(|s| s.action != "drop");
    if let Some(i) = first_kept {
        if matches!(steps[i].action.as_str(), "squash" | "fixup") {
            return Err(Error::msg("The first commit can't be squashed or fixed up into nothing"));
        }
    }
    Ok(())
}

fn state_dir(r: &Repository) -> PathBuf {
    r.path().join("rebase-merge")
}

fn state_file(r: &Repository) -> PathBuf {
    state_dir(r).join("gitbrix.json")
}

/// A rebase is stopped, ours or one started by git in a terminal.
pub fn in_progress(r: &Repository) -> bool {
    state_dir(r).exists() || r.path().join("rebase-apply").exists()
}

fn load(r: &Repository) -> Result<State> {
    let text = std::fs::read_to_string(state_file(r)).map_err(|_| {
        Error::msg("This rebase was started outside gitbrix; finish it with the tool that started it")
    })?;
    serde_json::from_str(&text).map_err(|e| Error::msg(format!("Unreadable rebase state: {e}")))
}

fn save(r: &Repository, s: &State) -> Result<()> {
    let dir = state_dir(r);
    std::fs::create_dir_all(&dir)?;
    // The files git and libgit2 look at to know a rebase is going on.
    std::fs::write(dir.join("head-name"), format!("{}\n", s.head_name.as_deref().unwrap_or("detached HEAD")))?;
    std::fs::write(dir.join("orig-head"), format!("{}\n", s.orig_head))?;
    std::fs::write(dir.join("onto"), format!("{}\n", s.onto))?;
    std::fs::write(dir.join("interactive"), "")?;
    let json = serde_json::to_string_pretty(s).map_err(|e| Error::msg(e.to_string()))?;
    std::fs::write(state_file(r), json)?;
    Ok(())
}

/// Leftovers of a single cherry-pick that must not outlive its step.
fn clear_pick_files(r: &Repository) {
    for f in ["CHERRY_PICK_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        let _ = std::fs::remove_file(r.path().join(f));
    }
}

fn head(r: &Repository) -> Result<Commit<'_>> {
    ops::head_commit(r).ok_or_else(|| Error::msg("No commit to rebase"))
}

fn summary(c: &Commit) -> String {
    c.summary().ok().flatten().unwrap_or("").to_owned()
}

/// Start rebasing: stash local changes, detach at `onto`, replay `steps`.
fn start(r: &Repository, onto: Oid, steps: Vec<RebaseStep>) -> Result<()> {
    if in_progress(r) || r.state() != RepositoryState::Clean {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    let head_ref = r.head()?;
    let head_name = head_ref.is_branch().then(|| head_ref.name().map(str::to_owned)).transpose()?;
    let orig = head_ref.peel_to_commit()?.id();
    drop(head_ref);

    let autostash = stash_local_changes(r)?;
    let onto_commit = r.find_commit(onto)?;
    if let Err(e) = ops::safe_checkout(r, onto_commit.as_object()) {
        restore_autostash(r, autostash.as_deref());
        return Err(e);
    }
    r.set_head_detached(onto)?;
    let state = State {
        head_name,
        orig_head: orig.to_string(),
        onto: onto.to_string(),
        todo: steps,
        current: None,
        stopped_at: None,
        autostash,
        replayed: false,
    };
    save(r, &state)?;
    proceed(r, state)
}

fn stash_local_changes(r: &Repository) -> Result<Option<String>> {
    let st = status::status(r)?;
    let tracked_changes = !st.staged.is_empty() || st.unstaged.iter().any(|e| e.status != "untracked");
    if !tracked_changes {
        return Ok(None);
    }
    // libgit2's stash needs a mutable handle of its own.
    let mut own = Repository::open(r.path())?;
    let who = ops::committer(r)?;
    let id = own.stash_save2(&who, Some("gitbrix: autostash before rebase"), Some(StashFlags::DEFAULT))?;
    Ok(Some(id.to_string()))
}

/// Re-apply the autostash. On conflict it stays in the stash list.
fn restore_autostash(r: &Repository, id: Option<&str>) -> Option<String> {
    let id = id?;
    let mut own = Repository::open(r.path()).ok()?;
    let mut index = None;
    let _ = own.stash_foreach(|i, _, oid| {
        if oid.to_string() == id {
            index = Some(i);
            return false;
        }
        true
    });
    let index = index?;
    match ops::apply_stash(&mut own, index, true) {
        Ok(()) => None,
        Err(_) => Some("Your local changes couldn't be put back cleanly; they are kept in the stash list".into()),
    }
}

/// Run the remaining steps; stop on the first conflict.
fn proceed(r: &Repository, mut state: State) -> Result<()> {
    while !state.todo.is_empty() {
        let step = state.todo.remove(0);
        if step.action == "drop" {
            continue;
        }
        let commit = r.find_commit(Oid::from_str(&step.id).map_err(|_| Error::msg("Invalid commit id"))?)?;
        let tip = head(r)?;

        // Unchanged history stays as it is: a plain pick of a commit
        // whose parent is already HEAD just moves HEAD.
        if step.action == "pick" && commit.parent_count() == 1 && commit.parent_id(0)? == tip.id() {
            ops::safe_checkout(r, commit.as_object())?;
            r.set_head_detached(commit.id())?;
            state.replayed = true;
            continue;
        }

        let mut opts = git2::CherrypickOptions::new();
        let mut cb = CheckoutBuilder::new();
        cb.safe().allow_conflicts(true).conflict_style_merge(true);
        opts.checkout_builder(cb);
        if commit.parent_count() > 1 {
            opts.mainline(1);
        }
        r.cherrypick(&commit, Some(&mut opts))?;
        if r.index()?.has_conflicts() {
            state.stopped_at = Some(tip.id().to_string());
            state.current = Some(step);
            save(r, &state)?;
            let files = conflicted(r)?;
            return Err(Error::msg(format!(
                "Rebase stopped at \"{}\": conflicts in {}. Resolve them, then continue.",
                summary(&commit),
                files.join(", ")
            )));
        }
        state.replayed |= commit_step(r, &step, &commit, state.replayed)?;
        save(r, &state)?;
    }
    finish(r, state)
}

fn conflicted(r: &Repository) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for c in r.index()?.conflicts()? {
        let c = c?;
        if let Some(e) = c.our.or(c.their).or(c.ancestor) {
            out.push(String::from_utf8_lossy(&e.path).into_owned());
        }
    }
    Ok(out)
}

/// Record the index as the result of `step` (replaying `original`).
/// Returns whether a commit of the range now sits on HEAD.
fn commit_step(r: &Repository, step: &RebaseStep, original: &Commit, replayed: bool) -> Result<bool> {
    let mut index = r.index()?;
    let tree = r.find_tree(index.write_tree()?)?;
    let tip = head(r)?;
    let committer = ops::committer(r)?;
    clear_pick_files(r);
    let original_message = original.message().unwrap_or("");

    let (oid, kind) = match step.action.as_str() {
        // Folding needs one of our commits underneath, never `onto`.
        "squash" | "fixup" if replayed => {
            // Fold into the commit before: same parents, combined message.
            let message = if step.action == "squash" {
                format!("{}\n\n{}", tip.message().unwrap_or("").trim_end(), original_message.trim())
            } else {
                tip.message().unwrap_or("").to_owned()
            };
            let message = git2::message_prettify(message, None)?;
            let parents: Vec<Commit> = tip.parents().collect();
            let refs: Vec<&Commit> = parents.iter().collect();
            (sign::commit(r, &tip.author(), &committer, &message, &tree, &refs)?, step.action.as_str())
        }
        _ => {
            if tree.id() == tip.tree_id() {
                // Its changes are already there: drop it, as git does.
                return Ok(false);
            }
            let message = match step.action.as_str() {
                "reword" => git2::message_prettify(step.message.as_deref().unwrap_or(""), None)?,
                _ => original_message.to_owned(),
            };
            (sign::commit(r, &original.author(), &committer, &message, &tree, &[&tip])?, "pick")
        }
    };
    let new = r.find_commit(oid)?;
    r.reference("HEAD", oid, true, &format!("rebase ({kind}): {}", summary(&new)))?;
    Ok(true)
}

/// The commit a stopped rebase step is replaying, if one is stopped.
pub fn stopped_commit(r: &Repository) -> Option<Oid> {
    let state = load(r).ok()?;
    Oid::from_str(&state.current?.id).ok()
}

fn finish(r: &Repository, state: State) -> Result<()> {
    let tip = head(r)?.id();
    if let Some(name) = &state.head_name {
        r.reference(name, tip, true, &format!("rebase (finish): {name} onto {}", state.onto))?;
        r.set_head(name)?;
    }
    let _ = std::fs::remove_dir_all(state_dir(r));
    clear_pick_files(r);
    match restore_autostash(r, state.autostash.as_deref()) {
        Some(problem) => Err(Error::msg(format!("Rebase finished. {problem}"))),
        None => Ok(()),
    }
}

/// Put HEAD and the work tree back to the step's starting point.
fn drop_current_pick(r: &Repository) -> Result<()> {
    // Not `reset --hard`: libgit2's reset also deletes the rebase state.
    let mut cb = CheckoutBuilder::new();
    cb.force();
    r.checkout_head(Some(&mut cb))?;
    let tree = head(r)?.tree()?;
    let mut index = r.index()?;
    index.read_tree(&tree)?;
    index.write()?;
    clear_pick_files(r);
    Ok(())
}

/// `continue`, `skip` or `abort` for a stopped rebase.
pub fn sequence(r: &Repository, action: &str) -> Result<()> {
    if action == "abort" {
        return abort(r);
    }
    let mut state = load(r)?;
    match action {
        "continue" => {
            if r.index()?.has_conflicts() {
                return Err(Error::msg("Resolve all conflicts first"));
            }
            if let Some(step) = state.current.take() {
                let moved = state.stopped_at.as_deref() != Some(head(r)?.id().to_string().as_str());
                // If the user committed the resolution themselves, that
                // commit stands for the step.
                if moved {
                    state.replayed = true;
                } else {
                    let original = r.find_commit(Oid::from_str(&step.id).map_err(|_| Error::msg("Invalid commit id"))?)?;
                    state.replayed |= commit_step(r, &step, &original, state.replayed)?;
                }
                clear_pick_files(r);
            }
        }
        "skip" => {
            state.current = None;
            drop_current_pick(r)?;
        }
        other => return Err(Error::msg(format!("Unknown action {other}"))),
    }
    state.stopped_at = None;
    save(r, &state)?;
    proceed(r, state)
}

fn abort(r: &Repository) -> Result<()> {
    let dir = state_dir(r);
    // Works for rebases git started too: both write head-name and orig-head.
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).map(|s| s.trim().to_owned());
    let orig = read("orig-head").map_err(|_| Error::msg("No rebase to abort"))?;
    let orig = r.find_commit(Oid::from_str(&orig).map_err(|_| Error::msg("Unreadable rebase state"))?)?;
    let autostash = load(r).ok().and_then(|s| s.autostash);
    // Read before resetting: libgit2's reset deletes the state directory.
    let head_name = read("head-name");
    let mut cb = CheckoutBuilder::new();
    cb.force();
    r.reset(orig.as_object(), git2::ResetType::Hard, Some(&mut cb))?;
    match head_name {
        Ok(name) if name.starts_with("refs/heads/") => {
            r.reference(&name, orig.id(), true, "rebase (abort)")?;
            r.set_head(&name)?;
        }
        _ => r.set_head_detached(orig.id())?,
    }
    let _ = std::fs::remove_dir_all(&dir);
    clear_pick_files(r);
    match restore_autostash(r, autostash.as_deref()) {
        Some(problem) => Err(Error::msg(format!("Rebase aborted. {problem}"))),
        None => Ok(()),
    }
}

/// Interactive rebase of the commits after `base` following `steps`.
pub fn run(repo: &Repository, base: &str, steps: &[RebaseStep]) -> Result<()> {
    if base.starts_with('-') || Oid::from_str(base).is_err() {
        return Err(Error::msg("Invalid base commit"));
    }
    if in_progress(repo) || repo.state() != RepositoryState::Clean {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    validate(steps)?;
    let expected: Vec<String> = commits(repo, base)?.into_iter().map(|c| c.id).collect();
    let mut planned: Vec<String> = steps.iter().map(|s| s.id.clone()).collect();
    planned.sort();
    let mut sorted = expected.clone();
    sorted.sort();
    if planned != sorted {
        return Err(Error::msg("The plan doesn't match the commits being rebased; refresh and try again"));
    }
    start(repo, Oid::from_str(base).expect("checked above"), steps.to_vec())
}

/// `git rebase <onto>`: replay the current branch's own commits (not
/// merges) on top of `onto`.
pub fn onto(r: &Repository, rev: &str) -> Result<()> {
    ops::check_name(rev)?;
    let onto = r
        .revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| Error::msg(format!("Unknown revision {rev}")))?;
    let tip = head(r)?;
    if tip.id() == onto.id() || r.graph_descendant_of(tip.id(), onto.id())? {
        return Ok(());
    }
    if in_progress(r) || r.state() != RepositoryState::Clean {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    if r.graph_descendant_of(onto.id(), tip.id())? {
        // Nothing of ours to replay: fast-forward.
        ops::safe_checkout(r, onto.as_object())?;
        ops::update_head(r, onto.id(), &format!("rebase: fast-forward to {rev}"))?;
        return Ok(());
    }
    let steps = range(r, onto.id(), tip.id())?
        .into_iter()
        .filter(|c| c.parent_count() < 2)
        .map(|c| RebaseStep { action: "pick".into(), id: c.id().to_string(), message: None })
        .collect();
    start(r, onto.id(), steps)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(action: &str, id: &str) -> RebaseStep {
        RebaseStep { action: action.into(), id: id.into(), message: None }
    }

    #[test]
    fn rejects_bad_plans() {
        let a = "a".repeat(40);
        assert!(validate(&[step("squash", &a)]).is_err());
        assert!(validate(&[step("drop", &a), step("fixup", &a)]).is_err());
        assert!(validate(&[step("edit", &a)]).is_err());
        assert!(validate(&[step("pick", "nothex")]).is_err());
        assert!(validate(&[step("reword", &a)]).is_err());
        assert!(validate(&[step("pick", &a), step("squash", &a)]).is_ok());
    }
}
