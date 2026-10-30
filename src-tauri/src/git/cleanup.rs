//! Branches that can go: local ones already merged into the checked-out or
//! main branch, local ones whose upstream was deleted on the remote
//! ("gone"), and remote branches merged into the remote's main branch.

use git2::{BranchType, Oid, Repository};
use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stale {
    /// `feature/x`, or `origin/feature/x` for a remote branch.
    pub name: String,
    pub remote: bool,
    /// `merged` or `gone`.
    pub reason: &'static str,
    /// What it is merged into (`main`, `origin/main`); for `gone`, the
    /// upstream that disappeared.
    pub into: String,
    /// Merged, so deleting loses no commits.
    pub merged: bool,
    /// Commit time of its tip.
    pub time: i64,
}

fn contains(r: &Repository, base: Oid, tip: Oid) -> bool {
    base == tip || r.graph_descendant_of(base, tip).unwrap_or(false)
}

/// The branches others are merged into: the checked-out one, local `main`
/// / `master`, and each remote's default (`origin/HEAD`, else main/master).
fn bases(r: &Repository) -> Vec<(String, Oid)> {
    let mut out = Vec::new();
    if let Ok(head) = r.head() {
        if let (true, Some(id), Ok(name)) = (head.is_branch(), head.target(), head.shorthand()) {
            out.push((name.to_owned(), id));
        }
    }
    for name in ["main", "master", "develop"] {
        if let Ok(b) = r.find_branch(name, BranchType::Local) {
            if let Some(id) = b.get().target() {
                if !out.iter().any(|(n, _)| n == name) {
                    out.push((name.to_owned(), id));
                }
            }
        }
    }
    out
}

fn remote_default(r: &Repository, remote: &str) -> Option<(String, Oid)> {
    if let Ok(head) = r.find_reference(&format!("refs/remotes/{remote}/HEAD")) {
        if let Ok(resolved) = head.resolve() {
            if let (Some(name), Some(id)) = (resolved.shorthand().ok(), resolved.target()) {
                return Some((name.to_owned(), id));
            }
        }
    }
    ["main", "master"].iter().find_map(|b| {
        let name = format!("{remote}/{b}");
        r.find_branch(&name, BranchType::Remote).ok()?.get().target().map(|id| (name, id))
    })
}

pub fn stale(r: &Repository) -> Result<Vec<Stale>> {
    let bases = bases(r);
    let head_name = r.head().ok().filter(|h| h.is_branch()).and_then(|h| h.shorthand().ok().map(str::to_owned));
    let cfg = r.config()?;
    let mut out = Vec::new();

    for b in r.branches(Some(BranchType::Local))? {
        let (b, _) = b?;
        let Some(name) = b.name().ok().flatten().map(str::to_owned) else { continue };
        let Some(tip) = b.get().target() else { continue };
        if Some(&name) == head_name.as_ref() || bases.iter().any(|(n, _)| *n == name) {
            continue;
        }
        let time = r.find_commit(tip).map(|c| c.time().seconds()).unwrap_or(0);
        let merged_into = bases.iter().find(|(_, id)| contains(r, *id, tip)).map(|(n, _)| n.clone());
        // Configured upstream whose remote-tracking branch is gone.
        let remote = cfg.get_string(&format!("branch.{name}.remote")).ok();
        let merge = cfg.get_string(&format!("branch.{name}.merge")).ok();
        let gone = match (&remote, &merge) {
            (Some(remote), Some(merge)) if remote != "." => {
                let short = merge.trim_start_matches("refs/heads/");
                r.find_reference(&format!("refs/remotes/{remote}/{short}")).is_err().then(|| format!("{remote}/{short}"))
            }
            _ => None,
        };
        match (merged_into, gone) {
            (Some(into), _) => out.push(Stale { name, remote: false, reason: "merged", into, merged: true, time }),
            (None, Some(upstream)) => out.push(Stale { name, remote: false, reason: "gone", into: upstream, merged: false, time }),
            _ => {}
        }
    }

    for remote in r.remotes()?.iter().flatten().flatten() {
        let Some((default_name, default_id)) = remote_default(r, remote) else { continue };
        for b in r.branches(Some(BranchType::Remote))? {
            let (b, _) = b?;
            let Some(name) = b.name().ok().flatten().map(str::to_owned) else { continue };
            if !name.starts_with(&format!("{remote}/")) || name == default_name || name.ends_with("/HEAD") {
                continue;
            }
            let Some(tip) = b.get().target() else { continue };
            if !contains(r, default_id, tip) {
                continue;
            }
            let time = r.find_commit(tip).map(|c| c.time().seconds()).unwrap_or(0);
            out.push(Stale { name, remote: true, reason: "merged", into: default_name.clone(), merged: true, time });
        }
    }
    Ok(out)
}
