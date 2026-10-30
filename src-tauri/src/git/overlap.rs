//! Work that may clash with other branches before anyone merges: for each
//! remote branch, the files that would conflict if it and HEAD were merged
//! now (an in-memory merge, nothing is touched), and the files changed in
//! the work tree that it changed too.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

use git2::{BranchType, Commit, Delta, Diff, Oid, Repository, Status, StatusOptions, Tree};
use serde::Serialize;

use crate::error::Result;

/// Remote branches looked at, newest tips first; older ones are left out.
const BRANCH_LIMIT: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlap {
    /// `origin/feature/login`.
    pub branch: String,
    /// The branch's tip.
    pub target: String,
    /// Files that would conflict merging the branch and HEAD.
    pub conflicts: Vec<String>,
    /// Uncommitted changes to files the branch changed too (and that aren't
    /// already conflicts).
    pub edited: Vec<String>,
    pub author: String,
    /// The tip's commit time, seconds since the epoch.
    pub time: i64,
}

fn paths(diff: &Diff) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for d in diff.deltas() {
        if d.status() == Delta::Unmodified {
            continue;
        }
        for f in [d.old_file(), d.new_file()] {
            if let Some(p) = f.path() {
                out.insert(p.to_string_lossy().into_owned());
            }
        }
    }
    out
}

fn changed(r: &Repository, from: &Tree, to: &Tree) -> Result<BTreeSet<String>> {
    Ok(paths(&r.diff_tree_to_tree(Some(from), Some(to), None)?))
}

/// Paths with uncommitted changes, untracked files included.
fn uncommitted(r: &Repository) -> Result<BTreeSet<String>> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    Ok(r.statuses(Some(&mut opts))?
        .iter()
        .filter(|e| e.status() != Status::CURRENT && !e.status().is_ignored())
        .filter_map(|e| e.path().ok().map(str::to_owned))
        .collect())
}

fn conflicts(r: &Repository, base: &Tree, ours: &Tree, theirs: &Tree) -> Result<Vec<String>> {
    let index = r.merge_trees(base, ours, theirs, None)?;
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let mut out = BTreeSet::new();
    for c in index.conflicts()? {
        let c = c?;
        if let Some(e) = c.our.or(c.their).or(c.ancestor) {
            out.insert(String::from_utf8_lossy(&e.path).into_owned());
        }
    }
    Ok(out.into_iter().collect())
}

/// What a branch changed since it parted from HEAD, and what merging the
/// two would conflict on.
struct Clash {
    theirs: BTreeSet<String>,
    conflicts: Vec<String>,
}

type Cache = Mutex<HashMap<(Oid, Oid), Arc<Clash>>>;

/// By (HEAD, tip): commits never change, so neither does the answer; the
/// work tree is checked often while files are edited.
fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn clash(r: &Repository, head: &Commit, tip: &Commit) -> Result<Option<Arc<Clash>>> {
    let key = (head.id(), tip.id());
    if let Some(c) = cache().lock().unwrap().get(&key) {
        return Ok(Some(c.clone()));
    }
    let Ok(base_id) = r.merge_base(head.id(), tip.id()) else { return Ok(None) };
    // Already in HEAD: nothing of its own left to clash.
    if base_id == tip.id() {
        return Ok(None);
    }
    let base = r.find_commit(base_id)?.tree()?;
    let tip_tree = tip.tree()?;
    let head_tree = head.tree()?;
    let theirs = changed(r, &base, &tip_tree)?;
    // Only a merge of files both sides changed can conflict.
    let conflicts = if !theirs.is_empty() && base_id != head.id() && !changed(r, &base, &head_tree)?.is_disjoint(&theirs) {
        conflicts(r, &base, &head_tree, &tip_tree)?
    } else {
        Vec::new()
    };
    let c = Arc::new(Clash { theirs, conflicts });
    let mut cache = cache().lock().unwrap();
    if cache.len() > 2000 {
        cache.clear();
    }
    cache.insert(key, c.clone());
    Ok(Some(c))
}

/// Remote branches that clash with HEAD or the work tree, most conflicts first.
pub fn check(r: &Repository) -> Result<Vec<Overlap>> {
    let Ok(head) = r.head().and_then(|h| h.peel_to_commit()) else {
        return Ok(Vec::new());
    };
    // HEAD's own upstream is the same work, not someone else's.
    let upstream = r
        .head()
        .ok()
        .filter(|h| h.is_branch())
        .and_then(|h| h.shorthand().ok().map(str::to_owned))
        .and_then(|name| r.find_branch(&name, BranchType::Local).ok())
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.name().ok().flatten().map(str::to_owned));
    let mut branches: Vec<(String, Commit)> = r
        .branches(Some(BranchType::Remote))?
        .flatten()
        .filter_map(|(b, _)| {
            let name = b.name().ok().flatten()?.to_owned();
            // `origin/HEAD` points at another branch.
            if name.ends_with("/HEAD") || Some(&name) == upstream.as_ref() {
                return None;
            }
            Some((name, b.get().peel_to_commit().ok()?))
        })
        .collect();
    branches.sort_by_key(|(_, c)| -c.time().seconds());
    branches.truncate(BRANCH_LIMIT);

    let edited = uncommitted(r)?;
    let mut out = Vec::new();
    for (name, tip) in branches {
        if tip.id() == head.id() {
            continue;
        }
        let Some(c) = clash(r, &head, &tip)? else { continue };
        let conflicts = c.conflicts.clone();
        let edited: Vec<String> = edited
            .iter()
            .filter(|p| c.theirs.contains(*p) && !conflicts.contains(p))
            .cloned()
            .collect();
        if conflicts.is_empty() && edited.is_empty() {
            continue;
        }
        out.push(Overlap {
            branch: name,
            target: tip.id().to_string(),
            conflicts,
            edited,
            author: tip.author().name().unwrap_or("").to_owned(),
            time: tip.time().seconds(),
        });
    }
    out.sort_by(|a, b| b.conflicts.len().cmp(&a.conflicts.len()).then(b.time.cmp(&a.time)));
    Ok(out)
}
