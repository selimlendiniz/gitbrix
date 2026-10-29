use git2::{Repository, Status, StatusOptions};
use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub status: &'static str,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
}

impl WorkingStatus {
    pub fn is_dirty(&self) -> bool {
        !(self.staged.is_empty() && self.unstaged.is_empty() && self.conflicted.is_empty())
    }
}

fn index_status(s: Status) -> Option<&'static str> {
    if s.is_index_new() {
        Some("added")
    } else if s.is_index_modified() {
        Some("modified")
    } else if s.is_index_deleted() {
        Some("deleted")
    } else if s.is_index_renamed() {
        Some("renamed")
    } else if s.is_index_typechange() {
        Some("typechange")
    } else {
        None
    }
}

fn worktree_status(s: Status) -> Option<&'static str> {
    if s.is_wt_new() {
        Some("untracked")
    } else if s.is_wt_modified() {
        Some("modified")
    } else if s.is_wt_deleted() {
        Some("deleted")
    } else if s.is_wt_renamed() {
        Some("renamed")
    } else if s.is_wt_typechange() {
        Some("typechange")
    } else {
        None
    }
}

pub fn status(repo: &Repository) -> Result<WorkingStatus> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .renames_head_to_index(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut out = WorkingStatus::default();
    for e in statuses.iter() {
        let s = e.status();
        let Some(path) = e.path().ok().map(str::to_owned) else { continue };
        if s.is_conflicted() {
            out.conflicted.push(StatusEntry { path, old_path: None, status: "conflicted" });
            continue;
        }
        if let Some(st) = index_status(s) {
            let old_path = e
                .head_to_index()
                .filter(|_| s.is_index_renamed())
                .and_then(|d| d.old_file().path().map(|p| p.to_string_lossy().into_owned()));
            out.staged.push(StatusEntry { path: path.clone(), old_path, status: st });
        }
        if let Some(st) = worktree_status(s) {
            out.unstaged.push(StatusEntry { path, old_path: None, status: st });
        }
    }
    Ok(out)
}
