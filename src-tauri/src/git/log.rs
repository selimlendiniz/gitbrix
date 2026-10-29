use git2::{Oid, Repository, Sort};
use serde::Serialize;

use super::graph::{self, Seg};
use super::refs::{self, RefInfo};
use crate::error::Result;

/// Pseudo-commit id for the uncommitted-changes row on top of HEAD.
pub const WIP_ID: &str = "WIP";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    /// `commit`, `stash` or `wip`.
    pub kind: &'static str,
    pub id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time, seconds since the epoch.
    pub time: i64,
    pub parents: Vec<String>,
    pub lane: u16,
    pub color: u16,
    pub up: Vec<Seg>,
    pub down: Vec<Seg>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Graph {
    pub commits: Vec<CommitRow>,
    pub refs: Vec<RefInfo>,
    pub max_lanes: usize,
    /// More commits exist beyond `limit`.
    pub truncated: bool,
}

/// Which refs the graph walks from. Commits reachable only from hidden
/// refs disappear; with `solo`, only those refs (and HEAD) are walked.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphFilter {
    #[serde(default)]
    pub hidden: Vec<String>,
    #[serde(default)]
    pub solo: Vec<String>,
}

#[cfg(test)]
pub fn graph(repo: &Repository, limit: usize, wip: bool) -> Result<Graph> {
    graph_filtered(repo, limit, wip, &GraphFilter::default())
}

pub fn graph_filtered(repo: &Repository, limit: usize, wip: bool, filter: &GraphFilter) -> Result<Graph> {
    let refs = refs::list(repo)?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    let head = repo.head().ok().and_then(|h| h.target());
    if let Some(h) = head {
        walk.push(h)?;
    }
    let walked = |full: &str| {
        if !filter.solo.is_empty() {
            filter.solo.iter().any(|s| s == full)
        } else {
            !filter.hidden.iter().any(|h| h == full)
        }
    };
    for r in refs.iter().filter(|r| walked(&r.full_name)) {
        // A ref may point at something unreadable (shallow clone edge,
        // corrupt object); skip it rather than failing the whole graph.
        if let Ok(oid) = Oid::from_str(&r.target) {
            let _ = walk.push(oid);
        }
    }

    let mut commits = Vec::new();
    let mut truncated = false;

    for oid in walk {
        if commits.len() >= limit {
            truncated = true;
            break;
        }
        let commit = repo.find_commit(oid?)?;
        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        let author = commit.author();
        commits.push(CommitRow {
            kind: "commit",
            id: commit.id().to_string(),
            summary: commit.summary().ok().flatten().unwrap_or("").to_owned(),
            author_name: author.name().unwrap_or("").to_owned(),
            author_email: author.email().unwrap_or("").to_owned(),
            time: author.when().seconds(),
            parents,
            lane: 0,
            color: 0,
            up: Vec::new(),
            down: Vec::new(),
        });
    }

    insert_stashes(repo, &mut commits)?;

    // Also without HEAD: in a repository with no commits yet, the WIP row
    // is the only way to reach the changes for the first commit.
    let wip_row = wip;
    if wip_row {
        commits.insert(
            0,
            CommitRow {
                kind: "wip",
                id: WIP_ID.to_owned(),
                summary: String::new(),
                author_name: String::new(),
                author_email: String::new(),
                time: 0,
                parents: head.map(|h| vec![h.to_string()]).unwrap_or_default(),
                lane: 0,
                color: 0,
                up: Vec::new(),
                down: Vec::new(),
            },
        );
    }

    let nodes: Vec<(String, Vec<String>)> = commits.iter().map(|c| (c.id.clone(), c.parents.clone())).collect();
    let layout = graph::layout(&nodes);
    for (row, l) in commits.iter_mut().zip(layout.rows) {
        row.lane = l.lane;
        row.color = l.color;
        row.up = l.up;
        row.down = l.down;
    }

    Ok(Graph { commits, refs, max_lanes: layout.max_lanes, truncated })
}

/// Show each stash as a row right above the commit it was made on, with
/// only that commit as parent (its index and untracked-files commits are
/// git internals). Stashes whose base isn't loaded are left out.
fn insert_stashes(repo: &Repository, commits: &mut Vec<CommitRow>) -> Result<()> {
    let Ok(reflog) = repo.reflog("refs/stash") else { return Ok(()) };
    let index: std::collections::HashMap<&str, usize> =
        commits.iter().enumerate().map(|(i, c)| (c.id.as_str(), i)).collect();
    let mut inserts: Vec<(usize, usize, CommitRow)> = Vec::new();
    for (age, entry) in reflog.iter().enumerate() {
        let Ok(stash) = repo.find_commit(entry.id_new()) else { continue };
        let Ok(base) = stash.parent_id(0) else { continue };
        let base = base.to_string();
        let Some(&pos) = index.get(base.as_str()) else { continue };
        let author = stash.author();
        inserts.push((
            pos,
            age,
            CommitRow {
                kind: "stash",
                id: stash.id().to_string(),
                summary: entry.message().ok().flatten().unwrap_or("").to_owned(),
                author_name: author.name().unwrap_or("").to_owned(),
                author_email: author.email().unwrap_or("").to_owned(),
                time: author.when().seconds(),
                parents: vec![base],
                lane: 0,
                color: 0,
                up: Vec::new(),
                down: Vec::new(),
            },
        ));
    }
    // Insert from the bottom up so earlier positions stay valid. On the
    // same base, insert the oldest first so the newest ends up on top.
    inserts.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    for (pos, _, row) in inserts {
        commits.insert(pos, row);
    }
    Ok(())
}
