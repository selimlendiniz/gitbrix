use git2::{BranchType, Repository};
use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefInfo {
    /// Full name, e.g. `refs/heads/main`.
    pub full_name: String,
    /// Display name, e.g. `main`, `origin/main`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// Commit the ref points at (tags are peeled).
    pub target: String,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: usize,
    pub message: String,
    pub id: String,
    /// Commit the stash was made on top of.
    pub base: Option<String>,
}

pub fn list(repo: &Repository) -> Result<Vec<RefInfo>> {
    let mut out = Vec::new();

    for b in repo.branches(Some(BranchType::Local))? {
        let (branch, _) = b?;
        let Some(name) = branch.name()?.map(str::to_owned) else { continue };
        let Some(target) = branch.get().target() else { continue };
        let (mut upstream, mut ahead, mut behind) = (None, 0, 0);
        if let Ok(up) = branch.upstream() {
            upstream = up.name().ok().flatten().map(str::to_owned);
            if let Some(u) = up.get().target() {
                (ahead, behind) = repo.graph_ahead_behind(target, u).unwrap_or((0, 0));
            }
        }
        out.push(RefInfo {
            full_name: format!("refs/heads/{name}"),
            name,
            kind: RefKind::Local,
            target: target.to_string(),
            is_head: branch.is_head(),
            upstream,
            ahead,
            behind,
        });
    }

    for b in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = b?;
        let Some(name) = branch.name()?.map(str::to_owned) else { continue };
        // `origin/HEAD` is a symbolic alias, not a branch of its own.
        if name.ends_with("/HEAD") {
            continue;
        }
        let Some(target) = branch.get().target() else { continue };
        out.push(RefInfo {
            full_name: format!("refs/remotes/{name}"),
            name,
            kind: RefKind::Remote,
            target: target.to_string(),
            is_head: false,
            upstream: None,
            ahead: 0,
            behind: 0,
        });
    }

    for name in repo.tag_names(None)?.iter().filter_map(|n| n.ok().flatten()) {
        let full = format!("refs/tags/{name}");
        let Ok(r) = repo.find_reference(&full) else { continue };
        let Ok(commit) = r.peel_to_commit() else { continue };
        out.push(RefInfo {
            full_name: full,
            name: name.to_owned(),
            kind: RefKind::Tag,
            target: commit.id().to_string(),
            is_head: false,
            upstream: None,
            ahead: 0,
            behind: 0,
        });
    }

    Ok(out)
}

pub fn stashes(repo: &mut Repository) -> Result<Vec<StashInfo>> {
    let mut raw = Vec::new();
    repo.stash_foreach(|index, message, id| {
        raw.push((index, message.to_owned(), *id));
        true
    })?;
    Ok(raw
        .into_iter()
        .map(|(index, message, id)| StashInfo {
            index,
            message,
            id: id.to_string(),
            base: repo
                .find_commit(id)
                .ok()
                .and_then(|c| c.parent_id(0).ok())
                .map(|o| o.to_string()),
        })
        .collect())
}
