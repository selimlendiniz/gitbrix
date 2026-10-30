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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    /// Content on the current branch (`None` if deleted there).
    pub ours: Option<String>,
    /// Content on the branch being merged in (`None` if deleted there).
    pub theirs: Option<String>,
    /// Common ancestor content, if there is one.
    pub base: Option<String>,
    /// Work tree file with conflict markers (`None` if missing).
    pub working: Option<String>,
    pub binary: bool,
    /// The three versions merged again with each conflict's base shown
    /// (diff3 style), whatever style the work tree file was written in.
    pub merged: Option<String>,
}

/// `ours` and `theirs` merged over `base`, conflicts in diff3 style.
fn diff3(base: Option<&str>, ours: &str, theirs: &str) -> Option<String> {
    let (mut b, mut o, mut t) = (git2::MergeFileInput::new(), git2::MergeFileInput::new(), git2::MergeFileInput::new());
    b.content(base.unwrap_or("").as_bytes());
    o.content(ours.as_bytes());
    t.content(theirs.as_bytes());
    let mut opts = git2::MergeFileOptions::new();
    opts.style_diff3(true).ancestor_label("base").our_label("ours").their_label("theirs");
    let merged = git2::merge_file(&b, &o, &t, Some(&mut opts)).ok()?;
    String::from_utf8(merged.content().to_vec()).ok()
}

pub fn conflict_file(repo: &Repository, path: &str) -> Result<ConflictFile> {
    let index = repo.index()?;
    let mut entry = None;
    for c in index.conflicts()? {
        let c = c?;
        let p = c
            .our
            .as_ref()
            .or(c.their.as_ref())
            .or(c.ancestor.as_ref())
            .map(|e| String::from_utf8_lossy(&e.path).into_owned());
        if p.as_deref() == Some(path) {
            entry = Some(c);
            break;
        }
    }
    let c = entry.ok_or_else(|| crate::error::Error::msg(format!("{path} is not in conflict")))?;

    let mut binary = false;
    let mut blob = |e: &Option<git2::IndexEntry>| -> Result<Option<String>> {
        let Some(e) = e else { return Ok(None) };
        let b = repo.find_blob(e.id)?;
        binary |= b.is_binary();
        Ok(Some(String::from_utf8_lossy(b.content()).into_owned()))
    };
    let ours = blob(&c.our)?;
    let theirs = blob(&c.their)?;
    let base = blob(&c.ancestor)?;
    let wd = repo.workdir().expect("non-bare").join(path);
    let working = std::fs::read(&wd).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let merged = match (&ours, &theirs) {
        (Some(o), Some(t)) if !binary => diff3(base.as_deref(), o, t),
        _ => None,
    };
    Ok(ConflictFile { path: path.to_owned(), ours, theirs, base, working, binary, merged })
}
