//! File history (following renames), history search, reflog and blame,
//! all read with libgit2.

use std::collections::HashMap;
use std::path::Path;

use git2::{BlameOptions, Oid, Repository, Tree};
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
    // Paths in a tree always use `/`, and a Windows file name can't hold `\`.
    let needle = if cfg!(windows) { query.replace('\\', "/") } else { query.to_owned() }.to_lowercase();
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
        let diff = r.diff_tree_to_tree(ptree.as_ref(), Some(&tree), None)?;
        let hit = if mode == "files" {
            let matches = |p: Option<&[u8]>| p.is_some_and(|p| String::from_utf8_lossy(p).to_lowercase().contains(&needle));
            diff.deltas().any(|d| matches(d.old_file().path_bytes()) || matches(d.new_file().path_bytes()))
        } else {
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
    }
}

/// Release notes for `tag`: one line per commit since the newest older tag
/// it contains (or since the beginning), newest first, merges left out.
pub fn release_notes(repo: &Repository, tag: &str) -> Result<String> {
    let target = repo
        .revparse_single(&format!("refs/tags/{tag}"))
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| Error::msg(format!("No tag named {tag}")))?;
    // The previous release: the closest other tag the target contains (one
    // no other such tag comes after).
    let mut previous: Option<git2::Oid> = None;
    for name in repo.tag_names(None)?.iter().flatten().flatten() {
        if name == tag {
            continue;
        }
        let Ok(c) = repo.revparse_single(&format!("refs/tags/{name}")).and_then(|o| o.peel_to_commit()) else { continue };
        if c.id() == target.id() || !repo.graph_descendant_of(target.id(), c.id()).unwrap_or(false) {
            continue;
        }
        if previous.is_none_or(|p| repo.graph_descendant_of(c.id(), p).unwrap_or(false)) {
            previous = Some(c.id());
        }
    }
    let mut walk = repo.revwalk()?;
    walk.push(target.id())?;
    if let Some(p) = previous {
        walk.hide(p)?;
    }
    let mut lines = Vec::new();
    for id in walk.take(500) {
        let c = repo.find_commit(id?)?;
        if c.parent_count() > 1 {
            continue;
        }
        lines.push(format!("- {}", c.summary().ok().flatten().unwrap_or("")));
    }
    Ok(lines.join("\n"))
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    /// From the repository root.
    pub path: String,
    /// `dir`, `file`, `link` or `submodule`.
    pub kind: &'static str,
    pub size: Option<u64>,
}

/// The entries of folder `dir` ("" for the root) at commit `rev`: folders
/// first, then files, each by name.
pub fn tree_at(repo: &Repository, rev: &str, dir: &str) -> Result<Vec<TreeEntry>> {
    let commit = repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).map_err(|_| Error::msg(format!("Unknown revision {rev}")))?;
    let root = commit.tree()?;
    let tree = if dir.is_empty() {
        root
    } else {
        let entry = root.get_path(Path::new(dir)).map_err(|_| Error::msg(format!("No folder {dir} in that commit")))?;
        repo.find_tree(entry.id()).map_err(|_| Error::msg(format!("{dir} isn't a folder")))?
    };
    let mut out: Vec<TreeEntry> = tree
        .iter()
        .map(|e| {
            let name = e.name().unwrap_or("?").to_owned();
            let path = if dir.is_empty() { name.clone() } else { format!("{dir}/{name}") };
            let (kind, size) = match (e.kind(), e.filemode()) {
                (Some(git2::ObjectType::Tree), _) => ("dir", None),
                (Some(git2::ObjectType::Commit), _) => ("submodule", None),
                (_, 0o120000) => ("link", None),
                _ => ("file", repo.find_blob(e.id()).ok().map(|b| b.size() as u64)),
            };
            TreeEntry { name, path, kind, size }
        })
        .collect();
    out.sort_by(|a, b| (a.kind != "dir").cmp(&(b.kind != "dir")).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Every file at commit `rev` (`HEAD` in a repository without commits: the
/// index), for finding one by name. At most `FILE_LIMIT`.
pub fn list_files(repo: &Repository, rev: &str) -> Result<Vec<String>> {
    const FILE_LIMIT: usize = 200_000;
    let mut out = Vec::new();
    match repo.revparse_single(rev).and_then(|o| o.peel_to_commit()) {
        Ok(commit) => {
            commit.tree()?.walk(git2::TreeWalkMode::PreOrder, |dir, e| {
                if out.len() >= FILE_LIMIT {
                    return git2::TreeWalkResult::Abort;
                }
                if e.kind() == Some(git2::ObjectType::Blob) {
                    out.push(format!("{dir}{}", e.name().unwrap_or("")));
                }
                git2::TreeWalkResult::Ok
            })?;
        }
        Err(_) if rev == "HEAD" => {
            for e in repo.index()?.iter().take(FILE_LIMIT) {
                out.push(String::from_utf8_lossy(&e.path).into_owned());
            }
        }
        Err(_) => return Err(Error::msg(format!("Unknown revision {rev}"))),
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAt {
    /// None for binary files and ones too big to show.
    pub text: Option<String>,
    pub binary: bool,
    pub size: u64,
}

const MAX_TEXT: usize = 2 * 1024 * 1024;

/// A file's content at commit `rev`, as text when it is text (LFS
/// pointers show their content when it's here).
pub fn file_at(repo: &Repository, rev: &str, path: &str) -> Result<FileAt> {
    let commit = repo.revparse_single(rev).and_then(|o| o.peel_to_commit()).map_err(|_| Error::msg(format!("Unknown revision {rev}")))?;
    let entry = commit.tree()?.get_path(Path::new(path)).map_err(|_| Error::msg(format!("No file {path} in that commit")))?;
    let blob = repo.find_blob(entry.id()).map_err(|_| Error::msg(format!("{path} isn't a file")))?;
    let data = super::lfs::display_content(repo, blob.content()).unwrap_or_else(|| blob.content().to_vec());
    let size = data.len() as u64;
    let binary = data.iter().take(8000).any(|b| *b == 0);
    let text = (!binary && data.len() <= MAX_TEXT).then(|| String::from_utf8_lossy(&data).into_owned());
    Ok(FileAt { text, binary, size })
}
