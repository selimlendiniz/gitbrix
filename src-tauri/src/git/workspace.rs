//! Workspaces: many repositories at a glance. Each one is summed up (branch,
//! ahead/behind, local changes) without loading its graph, and folders can
//! be scanned for the repositories inside them.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{repo, status};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// The path as asked for, so the frontend can match answers to rows.
    pub path: String,
    pub info: Option<repo::RepoInfo>,
    /// Changed files (staged, unstaged and untracked together).
    pub changes: usize,
    pub conflicts: usize,
    /// Seconds since the epoch of the last fetch (FETCH_HEAD), if any.
    pub fetched: Option<i64>,
    pub error: Option<String>,
}

fn summarize(path: &str) -> Summary {
    let mut out = Summary { path: path.to_owned(), info: None, changes: 0, conflicts: 0, fetched: None, error: None };
    let r = match repo::open(Path::new(path)) {
        Ok(r) => r,
        Err(e) => {
            out.error = Some(e.to_string());
            return out;
        }
    };
    match status::status(&r) {
        Ok(st) => {
            let mut paths: Vec<&str> = st.staged.iter().chain(&st.unstaged).map(|e| e.path.as_str()).collect();
            paths.sort_unstable();
            paths.dedup();
            out.changes = paths.len();
            out.conflicts = st.conflicted.len();
        }
        Err(e) => out.error = Some(e.to_string()),
    }
    out.fetched = std::fs::metadata(r.path().join("FETCH_HEAD"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    match repo::info(&r) {
        Ok(info) => out.info = Some(info),
        Err(e) => out.error = Some(e.to_string()),
    }
    out
}

/// Summaries in the order asked, worked out a few at a time.
pub fn summaries(paths: &[String]) -> Vec<Summary> {
    let mut out: Vec<Option<Summary>> = paths.iter().map(|_| None).collect();
    for (chunk, slots) in paths.chunks(8).zip(out.chunks_mut(8)) {
        std::thread::scope(|s| {
            for (path, slot) in chunk.iter().zip(slots.iter_mut()) {
                s.spawn(move || *slot = Some(summarize(path)));
            }
        });
    }
    out.into_iter().flatten().collect()
}

/// Folders that never hold repositories worth listing, and are slow to walk.
const SKIP: &[&str] = &["node_modules", "target", "build", "dist", "vendor", "venv", ".venv", "__pycache__"];

/// Working directories of the repositories under `dir`, at most `depth`
/// folders down. A repository's own subfolders are not searched further
/// (submodules and nested checkouts belong to it).
pub fn find(dir: &Path, depth: usize) -> Vec<String> {
    let mut found = Vec::new();
    walk(&repo::expand_home(dir), depth, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<String>) {
    if dir.join(".git").exists() {
        found.push(dir.to_string_lossy().into_owned());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && !SKIP.contains(&name.as_ref())
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        walk(&d, depth - 1, found);
    }
}
