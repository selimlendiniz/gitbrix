//! File history (following renames), history search, reflog and blame,
//! all read with libgit2.

use std::collections::HashMap;
use std::path::Path;

use git2::{BlameOptions, DiffOptions, Oid, Repository, Tree};
use serde::Serialize;

use super::repo as repos;
use crate::error::{Error, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub author_name: String,
    pub time: i64,
    pub summary: String,
    /// The file's path in this commit (differs from today's after a rename).
    pub path: String,
}

fn blob_at(tree: &Tree, path: &str) -> Option<Oid> {
    tree.get_path(Path::new(path)).ok().filter(|e| e.kind() == Some(git2::ObjectType::Blob)).map(|e| e.id())
}

/// Commits that changed `path`, newest first, following it back through
/// renames like `git log --follow`. A merge is listed only when the file
/// differs from every parent.
pub fn file_history(repo: &Path, path: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
    let r = repos::open(repo)?;
    let mut walk = r.revwalk()?;
    if walk.push_head().is_err() {
        return Ok(Vec::new());
    }
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    let mut current = path.to_owned();
    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= limit {
            break;
        }
        let c = r.find_commit(oid?)?;
        let tree = c.tree()?;
        let Some(blob) = blob_at(&tree, &current) else { continue };
        let parents: Vec<_> = c.parents().collect();
        let unchanged = parents.iter().any(|p| p.tree().ok().and_then(|t| blob_at(&t, &current)) == Some(blob));
        if unchanged {
            continue;
        }
        out.push(HistoryEntry {
            id: c.id().to_string(),
            author_name: c.author().name().unwrap_or("").to_owned(),
            time: c.author().when().seconds(),
            summary: c.summary().ok().flatten().unwrap_or("").to_owned(),
            path: current.clone(),
        });
        // Added here: was it renamed from somewhere?
        if let [parent] = parents.as_slice() {
            let ptree = parent.tree()?;
            if blob_at(&ptree, &current).is_none() {
                let mut diff = r.diff_tree_to_tree(Some(&ptree), Some(&tree), None)?;
                diff.find_similar(Some(git2::DiffFindOptions::new().renames(true)))?;
                let renamed_from = diff.deltas().find_map(|d| {
                    let to = d.new_file().path()?.to_string_lossy();
                    (d.status() == git2::Delta::Renamed && to == current.as_str())
                        .then(|| d.old_file().path().map(|p| p.to_string_lossy().into_owned()))
                        .flatten()
                });
                match renamed_from {
                    Some(old) => current = old,
                    None => break,
                }
            }
        }
    }
    Ok(out)
}

fn glob_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| if matches!(c, '*' | '?' | '[' | ']' | '\\') { vec!['\\', c] } else { vec![c] })
        .collect()
}

fn count(hay: &[u8], needle: &str) -> usize {
    match std::str::from_utf8(hay) {
        Ok(text) => text.matches(needle).count(),
        Err(_) => hay.windows(needle.len()).filter(|w| *w == needle.as_bytes()).count(),
    }
}

/// Commits in all history (every ref) matching `query`: `files` — touching
/// a path containing it (case-insensitive); `code` — changing how often
/// that text occurs in a file, like `git log -S`. Newest first, at most
/// `limit`. Merges are skipped.
pub fn search(repo: &Path, mode: &str, query: &str, limit: usize) -> Result<Vec<String>> {
    if !matches!(mode, "files" | "code") {
        return Err(Error::msg(format!("Unknown search mode {mode}")));
    }
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let r = repos::open(repo)?;
    let mut walk = r.revwalk()?;
    let _ = walk.push_head();
    walk.push_glob("*")?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    // A search over a huge history returns what it found in this time.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let pattern = format!("*{}*", glob_escape(query));
    let mut out = Vec::new();
    for oid in walk {
        if out.len() >= limit || std::time::Instant::now() > deadline {
            break;
        }
        let c = r.find_commit(oid?)?;
        if c.parent_count() > 1 {
            continue;
        }
        let tree = c.tree()?;
        let ptree = c.parent(0).ok().map(|p| p.tree()).transpose()?;
        let hit = if mode == "files" {
            let mut opts = DiffOptions::new();
            opts.pathspec(&pattern).ignore_case(true);
            r.diff_tree_to_tree(ptree.as_ref(), Some(&tree), Some(&mut opts))?.deltas().len() > 0
        } else {
            let diff = r.diff_tree_to_tree(ptree.as_ref(), Some(&tree), None)?;
            let blob = |id: Oid| -> usize {
                if id.is_zero() {
                    return 0;
                }
                r.find_blob(id).map(|b| if b.is_binary() { 0 } else { count(b.content(), query) }).unwrap_or(0)
            };
            diff.deltas().any(|d| blob(d.old_file().id()) != blob(d.new_file().id()))
        };
        if hit {
            out.push(c.id().to_string());
        }
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    pub index: usize,
    /// Where HEAD went.
    pub id: String,
    /// Where it was before (all zeros for the first entry).
    pub old_id: String,
    pub message: String,
    pub time: i64,
    /// Summary of `id`, if that commit still exists.
    pub summary: Option<String>,
}

/// HEAD's reflog, newest first: every place HEAD has been, including
/// commits no branch points to anymore.
pub fn reflog(repo: &git2::Repository, limit: usize) -> Result<Vec<ReflogEntry>> {
    let log = repo.reflog("HEAD")?;
    Ok(log
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, e)| ReflogEntry {
            index,
            id: e.id_new().to_string(),
            old_id: e.id_old().to_string(),
            message: e.message().ok().flatten().unwrap_or("").to_owned(),
            time: e.committer().when().seconds(),
            summary: repo
                .find_commit(e.id_new())
                .ok()
                .and_then(|c| c.summary().ok().flatten().map(str::to_owned)),
        })
        .collect())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    pub id: String,
    pub author_name: String,
    pub author_email: String,
    pub time: i64,
    pub summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub id: String,
    pub line: u32,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub path: String,
    pub lines: Vec<BlameLine>,
    pub commits: HashMap<String, BlameCommit>,
}

/// Blame `path` as of `rev` (a commit id), or the work tree when `None`.
pub fn blame(repo: &Path, path: &str, rev: Option<&str>) -> Result<Blame> {
    super::ops::check_path(path)?;
    let r = repos::open(repo)?;
    let mut opts = BlameOptions::new();
    match rev {
        Some(rev) => {
            let id = Oid::from_str(rev).map_err(|_| Error::msg(format!("Invalid revision {rev}")))?;
            let commit = r.find_commit(id)?;
            opts.newest_commit(id);
            let blob = commit.tree()?.get_path(Path::new(path))?.to_object(&r)?.peel_to_blob()?;
            let blame = r.blame_file(Path::new(path), Some(&mut opts))?;
            Ok(collect_blame(&r, path, &blame, blob.content()))
        }
        None => {
            let content = std::fs::read(repos::workdir(&r).join(path))?;
            let committed = r.blame_file(Path::new(path), Some(&mut opts))?;
            let blame = committed.blame_buffer(&content)?;
            Ok(collect_blame(&r, path, &blame, &content))
        }
    }
}

fn collect_blame(r: &Repository, path: &str, blame: &git2::Blame, content: &[u8]) -> Blame {
    let text = String::from_utf8_lossy(content);
    let mut texts: Vec<&str> = text.split('\n').collect();
    if texts.last() == Some(&"") {
        texts.pop();
    }
    let mut lines = Vec::with_capacity(texts.len());
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    for hunk in blame.iter() {
        let id = hunk.final_commit_id();
        let key = id.to_string();
        if !id.is_zero() && !commits.contains_key(&key) {
            if let Ok(c) = r.find_commit(id) {
                let a = c.author();
                commits.insert(
                    key.clone(),
                    BlameCommit {
                        id: key.clone(),
                        author_name: a.name().unwrap_or("").to_owned(),
                        author_email: a.email().unwrap_or("").to_owned(),
                        time: a.when().seconds(),
                        summary: c.summary().ok().flatten().unwrap_or("").to_owned(),
                    },
                );
            }
        }
        let start = hunk.final_start_line();
        for n in start..start + hunk.lines_in_hunk() {
            let text = texts.get(n - 1).copied().unwrap_or("");
            lines.push(BlameLine { id: key.clone(), line: n as u32, text: text.to_owned() });
        }
    }
    Blame { path: path.to_owned(), lines, commits }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_occurrences() {
        assert_eq!(count(b"a fn b fn", "fn"), 2);
        assert_eq!(count(b"\xff fn \xfe", "fn"), 1);
        assert_eq!(glob_escape("a*b?[c]"), "a\\*b\\?\\[c\\]");
    }
}
