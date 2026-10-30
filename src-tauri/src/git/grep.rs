//! Searching the work tree's text: tracked files and untracked ones git
//! doesn't ignore, as they are on disk now.

use std::path::Path;

use git2::{Repository, Status, StatusOptions};
use regex::RegexBuilder;
use serde::Serialize;

use crate::error::{Error, Result};

const HIT_LIMIT: usize = 2000;
const FILE_SIZE_LIMIT: u64 = 2 * 1024 * 1024;
const LINE_SHOWN: usize = 240;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// The line, cut around the match when long.
    pub text: String,
    /// Where the match is in `text`, in characters.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub hits: Vec<Hit>,
    pub files: usize,
    /// More matched than `hits` holds.
    pub truncated: bool,
}

/// The files to look in: the index's, then untracked ones not ignored.
fn files(r: &Repository) -> Result<Vec<String>> {
    let mut out: Vec<String> = r.index()?.iter().map(|e| String::from_utf8_lossy(&e.path).into_owned()).collect();
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true).include_ignored(false);
    for e in r.statuses(Some(&mut opts))?.iter() {
        if e.status().contains(Status::WT_NEW)
            && let Ok(p) = e.path()
        {
            out.push(p.to_owned());
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// `text`'s characters `[from, to)` as a byte range.
fn chars_to_bytes(text: &str, from: usize, to: usize) -> (usize, usize) {
    let mut idx = text.char_indices().map(|(i, _)| i).chain(std::iter::once(text.len()));
    let a = idx.by_ref().nth(from).unwrap_or(text.len());
    let b = if to > from { idx.nth(to - from - 1).unwrap_or(text.len()) } else { a };
    (a, b)
}

/// A long line cut around the match, the match's place in characters.
fn shown(line: &str, start: usize, end: usize) -> (String, usize, usize) {
    let s_char = line[..start].chars().count();
    let e_char = s_char + line[start..end].chars().count();
    let total = line.chars().count();
    if total <= LINE_SHOWN {
        return (line.trim_end().to_owned(), s_char, e_char);
    }
    let from = s_char.saturating_sub(LINE_SHOWN / 3);
    let to = (from + LINE_SHOWN).min(total);
    let (a, b) = chars_to_bytes(line, from, to);
    let lead = if from > 0 { "…" } else { "" };
    let n = lead.chars().count();
    (format!("{lead}{}{}", &line[a..b], if to < total { "…" } else { "" }), s_char - from + n, (e_char - from + n).min(to - from + n))
}

pub fn search(repo: &Path, query: &str, regex: bool, case_sensitive: bool) -> Result<Found> {
    if query.is_empty() {
        return Ok(Found::default());
    }
    let pattern = if regex { query.to_owned() } else { regex::escape(query) };
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| Error::msg(format!("Not a valid pattern: {}", e.to_string().lines().last().unwrap_or(""))))?;
    let r = Repository::open(repo)?;
    let root = r.workdir().ok_or_else(|| Error::msg("A bare repository has no files to search"))?.to_path_buf();
    let mut found = Found::default();
    for path in files(&r)? {
        let full = root.join(&path);
        let Ok(meta) = std::fs::metadata(&full) else { continue };
        if !meta.is_file() || meta.len() > FILE_SIZE_LIMIT {
            continue;
        }
        let Ok(bytes) = std::fs::read(&full) else { continue };
        if bytes[..bytes.len().min(8000)].contains(&0) {
            continue;
        }
        found.files += 1;
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                if found.hits.len() >= HIT_LIMIT {
                    found.truncated = true;
                    return Ok(found);
                }
                let (text, start, end) = shown(line, m.start(), m.end());
                found.hits.push(Hit { path: path.clone(), line: i + 1, text, start, end });
            }
        }
    }
    Ok(found)
}
