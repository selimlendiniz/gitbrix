use std::path::Path;

use git2::{Delta, Diff, DiffFindOptions, DiffOptions, Oid, Patch, Repository};
use serde::Serialize;

use crate::error::{Error, Result};

/// Above this many lines a file diff is cut off; the UI says so.
const MAX_DIFF_LINES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: &'static str,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// `add`, `del` or `ctx`.
    pub kind: &'static str,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    /// The line has no newline at the end of the file. Needed to rebuild
    /// an applicable patch from these lines.
    pub no_eol: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: &'static str,
    pub binary: bool,
    pub truncated: bool,
    /// Some line isn't valid UTF-8, so its text here is approximate and
    /// must not be used to build a patch.
    pub lossy: bool,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub name: String,
    pub email: String,
    pub time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub id: String,
    pub message: String,
    pub author: Signature,
    pub committer: Signature,
    pub parents: Vec<String>,
    pub files: Vec<FileChange>,
    /// Has a GPG/SSH signature (not verified).
    pub signed: bool,
}

pub fn status_name(d: Delta) -> &'static str {
    match d {
        Delta::Added => "added",
        Delta::Deleted => "deleted",
        Delta::Modified => "modified",
        Delta::Renamed => "renamed",
        Delta::Copied => "copied",
        Delta::Typechange => "typechange",
        Delta::Untracked => "untracked",
        Delta::Conflicted => "conflicted",
        Delta::Ignored => "ignored",
        Delta::Unreadable => "unreadable",
        Delta::Unmodified => "unmodified",
    }
}

fn sig(s: git2::Signature) -> Signature {
    Signature {
        name: s.name().unwrap_or("").to_owned(),
        email: s.email().unwrap_or("").to_owned(),
        time: s.when().seconds(),
    }
}

fn path_of(f: git2::DiffFile) -> Option<String> {
    f.path().map(|p| p.to_string_lossy().into_owned())
}

fn find_renames(diff: &mut Diff) -> Result<()> {
    let mut opts = DiffFindOptions::new();
    opts.renames(true).copies(false);
    diff.find_similar(Some(&mut opts))?;
    Ok(())
}

/// File list with line counts for every delta in `diff`.
pub fn changes(diff: &Diff) -> Result<Vec<FileChange>> {
    let mut out = Vec::with_capacity(diff.deltas().len());
    for (i, delta) in diff.deltas().enumerate() {
        let new = path_of(delta.new_file());
        let old = path_of(delta.old_file());
        let path = new.clone().or_else(|| old.clone()).unwrap_or_default();
        let old_path = match delta.status() {
            Delta::Renamed | Delta::Copied => old,
            _ => None,
        };
        let (mut additions, mut deletions, mut binary) = (0, 0, delta.flags().is_binary());
        if let Some(patch) = Patch::from_diff(diff, i)? {
            let (_, a, d) = patch.line_stats()?;
            additions = a;
            deletions = d;
            binary |= patch.delta().flags().is_binary();
        }
        out.push(FileChange {
            path,
            old_path,
            status: status_name(delta.status()),
            additions,
            deletions,
            binary,
        });
    }
    Ok(out)
}

/// Full hunks for the single file in `diff` whose new or old path is `path`.
pub fn file_diff(diff: &Diff, path: &str) -> Result<FileDiff> {
    for (i, delta) in diff.deltas().enumerate() {
        let new = path_of(delta.new_file());
        let old = path_of(delta.old_file());
        if new.as_deref() != Some(path) && old.as_deref() != Some(path) {
            continue;
        }
        let status = status_name(delta.status());
        let old_path = match delta.status() {
            Delta::Renamed | Delta::Copied => old.clone(),
            _ => None,
        };
        let mut fd = FileDiff {
            path: new.or(old).unwrap_or_default(),
            old_path,
            status,
            binary: delta.flags().is_binary(),
            truncated: false,
            lossy: false,
            hunks: Vec::new(),
        };
        let Some(patch) = Patch::from_diff(diff, i)? else {
            fd.binary = true;
            return Ok(fd);
        };
        fd.binary |= patch.delta().flags().is_binary();
        let mut total = 0;
        'hunks: for h in 0..patch.num_hunks() {
            let (hunk, n) = patch.hunk(h)?;
            let mut out = Hunk {
                header: String::from_utf8_lossy(hunk.header()).trim_end().to_owned(),
                old_start: hunk.old_start(),
                old_lines: hunk.old_lines(),
                new_start: hunk.new_start(),
                new_lines: hunk.new_lines(),
                lines: Vec::with_capacity(n),
            };
            for l in 0..n {
                if total >= MAX_DIFF_LINES {
                    fd.truncated = true;
                    fd.hunks.push(out);
                    break 'hunks;
                }
                let line = patch.line_in_hunk(h, l)?;
                let kind = match line.origin() {
                    '+' => "add",
                    '-' => "del",
                    ' ' => "ctx",
                    // '=', '>', '<': "\ No newline at end of file" for the
                    // line just before.
                    '=' | '>' | '<' => {
                        if let Some(prev) = out.lines.last_mut() {
                            prev.no_eol = true;
                        }
                        continue;
                    }
                    _ => continue,
                };
                let text = String::from_utf8_lossy(line.content());
                fd.lossy |= matches!(text, std::borrow::Cow::Owned(_));
                out.lines.push(Line {
                    kind,
                    old_no: line.old_lineno(),
                    new_no: line.new_lineno(),
                    text: text.strip_suffix('\n').unwrap_or(&text).to_owned(),
                    no_eol: false,
                });
                total += 1;
            }
            fd.hunks.push(out);
        }
        return Ok(fd);
    }
    Err(Error::msg(format!("No changes for {path}")))
}

/// Diff of a commit against its first parent (or the empty tree for a
/// root commit). Merge commits are shown relative to the first parent,
/// which is what "what did this merge bring in" usually means.
pub fn commit_diff<'r>(repo: &'r Repository, oid: Oid, pathspec: Option<&str>, ignore_ws: bool) -> Result<Diff<'r>> {
    let commit = repo.find_commit(oid)?;
    let tree = commit.tree()?;
    let parent_tree = match commit.parent(0) {
        Ok(p) => Some(p.tree()?),
        Err(_) => None,
    };
    let mut opts = DiffOptions::new();
    if let Some(p) = pathspec {
        opts.pathspec(p).disable_pathspec_match(true);
    }
    opts.ignore_whitespace(ignore_ws);
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))?;
    if pathspec.is_none() {
        find_renames(&mut diff)?;
    }
    Ok(diff)
}

pub fn commit_details(repo: &Repository, oid: Oid) -> Result<CommitDetails> {
    let commit = repo.find_commit(oid)?;
    let diff = commit_diff(repo, oid, None, false)?;
    Ok(CommitDetails {
        id: commit.id().to_string(),
        message: commit.message().unwrap_or("").to_owned(),
        author: sig(commit.author()),
        committer: sig(commit.committer()),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        files: changes(&diff)?,
        signed: commit.header_field_bytes("gpgsig").is_ok(),
    })
}

/// `ignore_ws`: hide whitespace-only changes (view only; never used for
/// working-tree diffs, whose hunks must match the files exactly to stage).
pub fn commit_file_diff(repo: &Repository, oid: Oid, path: &str, old_path: Option<&str>, ignore_ws: bool) -> Result<FileDiff> {
    // For a rename both sides are needed, so diff the whole commit and
    // pick the file; otherwise restrict to the path to keep it cheap.
    if old_path.is_some() {
        let diff = commit_diff(repo, oid, None, ignore_ws)?;
        return file_diff(&diff, path);
    }
    let diff = commit_diff(repo, oid, Some(path), ignore_ws)?;
    file_diff(&diff, path)
}

/// Diff of one file in the working tree: staged (HEAD → index) or
/// unstaged (index → workdir, including untracked content).
pub fn workdir_file_diff(repo: &Repository, path: &str, staged: bool) -> Result<FileDiff> {
    let mut opts = DiffOptions::new();
    opts.pathspec(path).disable_pathspec_match(true);
    let diff = if staged {
        let head = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_index(head.as_ref(), None, Some(&mut opts))?
    } else {
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true);
        repo.diff_index_to_workdir(None, Some(&mut opts))?
    };
    file_diff(&diff, path)
}

/// Changes between two commits (`from` → `to`), as `git diff from to`.
fn range_diff<'r>(repo: &'r Repository, from: Oid, to: Oid, pathspec: Option<&str>, ignore_ws: bool) -> Result<Diff<'r>> {
    let a = repo.find_commit(from)?.tree()?;
    let b = repo.find_commit(to)?.tree()?;
    let mut opts = DiffOptions::new();
    if let Some(p) = pathspec {
        opts.pathspec(p).disable_pathspec_match(true);
    }
    opts.ignore_whitespace(ignore_ws);
    let mut diff = repo.diff_tree_to_tree(Some(&a), Some(&b), Some(&mut opts))?;
    if pathspec.is_none() {
        find_renames(&mut diff)?;
    }
    Ok(diff)
}

pub fn compare(repo: &Repository, from: Oid, to: Oid) -> Result<Vec<FileChange>> {
    changes(&range_diff(repo, from, to, None, false)?)
}

pub fn compare_file_diff(
    repo: &Repository,
    from: Oid,
    to: Oid,
    path: &str,
    old_path: Option<&str>,
    ignore_ws: bool,
) -> Result<FileDiff> {
    let diff = range_diff(repo, from, to, if old_path.is_some() { None } else { Some(path) }, ignore_ws)?;
    file_diff(&diff, path)
}

/// Largest image shown in an image diff.
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// Contents of `path` as base64, for showing images. `rev` is a commit
/// (`<id>` or `<id>^` for its first parent), `:` for the index, or `None`
/// for the work tree. `Ok(None)` when the file doesn't exist there.
pub fn file_base64(repo: &Repository, rev: Option<&str>, path: &str) -> Result<Option<String>> {
    use base64::Engine;
    let bytes = match rev {
        None => match std::fs::read(repo.workdir().expect("non-bare").join(path)) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        },
        Some(":") => {
            // libgit2's revparse has no ":path" (index) form.
            let index = repo.index()?;
            match index.get_path(Path::new(path), 0) {
                Some(entry) => repo.find_blob(entry.id)?.content().to_vec(),
                None => return Ok(None),
            }
        }
        Some(r) => {
            let spec = format!("{r}:{path}");
            match repo.revparse_single(&spec) {
                Ok(obj) => match obj.into_blob() {
                    Ok(blob) => blob.content().to_vec(),
                    Err(_) => return Ok(None),
                },
                Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            }
        }
    };
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(Error::msg("Image too large to show"));
    }
    Ok(Some(base64::engine::general_purpose::STANDARD.encode(bytes)))
}
