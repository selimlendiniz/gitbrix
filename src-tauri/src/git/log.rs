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

pub fn graph(repo: &Repository, limit: usize, wip: bool) -> Result<Graph> {
    let refs = refs::list(repo)?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    let head = repo.head().ok().and_then(|h| h.target());
    if let Some(h) = head {
        walk.push(h)?;
    }
    for r in &refs {
        // A ref may point at something unreadable (shallow clone edge,
        // corrupt object); skip it rather than failing the whole graph.
        if let Ok(oid) = Oid::from_str(&r.target) {
            let _ = walk.push(oid);
        }
    }

    let mut commits = Vec::new();
    let mut nodes: Vec<(String, Vec<String>)> = Vec::new();
    let mut truncated = false;

    let wip_row = wip && head.is_some();
    if wip_row {
        nodes.push((WIP_ID.to_owned(), vec![head.unwrap().to_string()]));
    }

    for oid in walk {
        if commits.len() >= limit {
            truncated = true;
            break;
        }
        let commit = repo.find_commit(oid?)?;
        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        let author = commit.author();
        nodes.push((commit.id().to_string(), parents.clone()));
        commits.push(CommitRow {
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

    if wip_row {
        commits.insert(
            0,
            CommitRow {
                id: WIP_ID.to_owned(),
                summary: String::new(),
                author_name: String::new(),
                author_email: String::new(),
                time: 0,
                parents: vec![head.unwrap().to_string()],
                lane: 0,
                color: 0,
                up: Vec::new(),
                down: Vec::new(),
            },
        );
    }

    let layout = graph::layout(&nodes);
    for (row, l) in commits.iter_mut().zip(layout.rows) {
        row.lane = l.lane;
        row.color = l.color;
        row.up = l.up;
        row.down = l.down;
    }

    Ok(Graph { commits, refs, max_lanes: layout.max_lanes, truncated })
}
