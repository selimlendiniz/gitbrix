//! File history (`git log --follow`) and blame (`git blame --porcelain`).
//! Both go through the CLI: rename following and blame heuristics are
//! where libgit2 differs most from what users see in a terminal.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;

use super::cli::{literal, run};
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

const RS: char = '\x1e';
const US: char = '\x1f';

pub fn file_history(repo: &Path, path: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
    let limit = format!("-n{limit}");
    let out = run(
        repo,
        &["log", &limit, "--follow", "--name-only", "--format=%x1e%H%x1f%an%x1f%at%x1f%s", "--", &literal(path)],
    )?;
    Ok(parse_history(&out.stdout))
}

pub fn parse_history(text: &str) -> Vec<HistoryEntry> {
    text.split(RS)
        .filter(|r| !r.trim().is_empty())
        .filter_map(|record| {
            let mut lines = record.lines();
            let header = lines.next()?;
            let mut f = header.splitn(4, US);
            let id = f.next()?.to_owned();
            let author_name = f.next()?.to_owned();
            let time = f.next()?.parse().ok()?;
            let summary = f.next().unwrap_or("").to_owned();
            let path = lines.find(|l| !l.trim().is_empty())?.to_owned();
            Some(HistoryEntry { id, author_name, time, summary, path })
        })
        .collect()
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
    let mut args = vec!["blame", "--porcelain"];
    if let Some(r) = rev {
        if r.starts_with('-') {
            return Err(Error::msg(format!("Invalid revision {r}")));
        }
        args.push(r);
    }
    args.extend(["--", path]);
    let out = run(repo, &args)?;
    Ok(parse_blame(path, &out.stdout))
}

pub fn parse_blame(path: &str, text: &str) -> Blame {
    let mut lines = Vec::new();
    let mut commits: HashMap<String, BlameCommit> = HashMap::new();
    let mut current: Option<(String, u32)> = None;

    for l in text.lines() {
        if let Some(content) = l.strip_prefix('\t') {
            if let Some((id, line)) = current.take() {
                lines.push(BlameLine { id, line, text: content.to_owned() });
            }
            continue;
        }
        let mut parts = l.split(' ');
        let first = parts.next().unwrap_or("");
        if first.len() == 40 && first.bytes().all(|b| b.is_ascii_hexdigit()) {
            // "<sha> <orig-line> <final-line> [<group-size>]"
            let final_line = parts.nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
            commits.entry(first.to_owned()).or_insert_with(|| BlameCommit {
                id: first.to_owned(),
                author_name: String::new(),
                author_email: String::new(),
                time: 0,
                summary: String::new(),
            });
            current = Some((first.to_owned(), final_line));
            continue;
        }
        let Some((id, _)) = &current else { continue };
        let Some(c) = commits.get_mut(id) else { continue };
        let rest = l.split_once(' ').map(|(_, v)| v).unwrap_or("");
        match first {
            "author" => c.author_name = rest.to_owned(),
            "author-mail" => c.author_email = rest.trim_matches(['<', '>']).to_owned(),
            "author-time" => c.time = rest.parse().unwrap_or(0),
            "summary" => c.summary = rest.to_owned(),
            _ => {}
        }
    }

    Blame { path: path.to_owned(), lines, commits }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_blame() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let text = format!(
            "{a} 1 1 2\nauthor Ada\nauthor-mail <ada@x>\nauthor-time 100\nsummary first\nfilename f\n\tline one\n\
             {a} 2 2\n\tline two\n\
             {b} 1 3 1\nauthor Bob\nauthor-mail <bob@x>\nauthor-time 200\nsummary second\nfilename f\n\t\tindented\n"
        );
        let bl = parse_blame("f", &text);
        let got: Vec<(&str, u32, &str)> = bl.lines.iter().map(|l| (&l.id[..1], l.line, l.text.as_str())).collect();
        assert_eq!(got, vec![("a", 1, "line one"), ("a", 2, "line two"), ("b", 3, "\tindented")]);
        assert_eq!(bl.commits[&a].author_name, "Ada");
        assert_eq!(bl.commits[&a].author_email, "ada@x");
        assert_eq!(bl.commits[&b].time, 200);
        assert_eq!(bl.commits[&b].summary, "second");
    }

    #[test]
    fn parses_history_records() {
        let text = "\x1eaaa\x1fAda\x1f100\x1fRename it\n\nnew.txt\n\x1ebbb\x1fBob\x1f50\x1fCreate\n\nold.txt\n";
        let h = parse_history(text);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].id.as_str(), h[0].path.as_str(), h[0].time), ("aaa", "new.txt", 100));
        assert_eq!((h[1].summary.as_str(), h[1].path.as_str()), ("Create", "old.txt"));
    }
}
