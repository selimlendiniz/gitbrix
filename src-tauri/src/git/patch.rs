//! Patch files: commits written out as mail-style patches (as
//! `git format-patch` does) and patches applied back, either to the work
//! tree (`git apply`) or as commits with their author and message
//! (`git am`).

use std::path::Path;

use git2::{ApplyLocation, Commit, Diff, EmailCreateOptions, Oid, Repository, Signature, Sort, Time};

use super::{ops, repo as repos, sign};
use crate::error::{Error, Result};

fn diff_of<'r>(r: &'r Repository, c: &Commit) -> Result<Diff<'r>> {
    let parent = c.parents().next().map(|p| p.tree()).transpose()?;
    Ok(r.diff_tree_to_tree(parent.as_ref(), Some(&c.tree()?), None)?)
}

/// The commits as one mailbox of patches, oldest first, numbered
/// `[PATCH n/m]` when there are several. Merge commits are left out, as
/// format-patch does.
pub fn format(r: &Repository, ids: &[Oid]) -> Result<String> {
    let commits: Vec<Commit> = ids
        .iter()
        .map(|id| r.find_commit(*id).map_err(|_| Error::msg(format!("Unknown commit {id}"))))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .filter(|c| c.parent_count() <= 1)
        .collect();
    if commits.is_empty() {
        return Err(Error::msg("No commits to write (merge commits are left out)"));
    }
    let mut out = String::new();
    let n = commits.len();
    for (i, c) in commits.iter().enumerate() {
        let diff = diff_of(r, c)?;
        let summary = c.summary().ok().flatten().unwrap_or("").to_owned();
        let body = c.body().ok().flatten().unwrap_or("").trim().to_owned();
        let mut opts = EmailCreateOptions::new();
        let email = git2::Email::from_diff(&diff, i + 1, n, &c.id(), summary.as_str(), body.as_str(), &c.author(), &mut opts)?;
        out.push_str(&String::from_utf8_lossy(email.as_slice()));
    }
    Ok(out)
}

/// Commits after `from` up to `to`, oldest first.
pub fn range(r: &Repository, from: Oid, to: Oid) -> Result<Vec<Oid>> {
    let mut walk = r.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
    walk.push(to)?;
    walk.hide(from)?;
    Ok(walk.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// One patch of a mailbox: who wrote it, the message and the diff.
#[derive(Debug, Default, PartialEq)]
pub struct Mail {
    pub author: Option<(String, String)>,
    /// Seconds since the epoch and the offset in minutes.
    pub date: Option<(i64, i32)>,
    pub subject: String,
    pub body: String,
    pub diff: String,
}

fn is_mbox_start(line: &str) -> bool {
    line.strip_prefix("From ").is_some_and(|rest| rest.len() > 40 && rest.as_bytes()[..40].iter().all(u8::is_ascii_hexdigit))
}

fn decode_q(text: &str) -> Vec<u8> {
    let t = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < t.len() {
        match t[i] {
            b'_' => out.push(b' '),
            b'=' if i + 2 < t.len() => match u8::from_str_radix(&text[i + 1..i + 3], 16) {
                Ok(v) => {
                    out.push(v);
                    i += 2;
                }
                Err(_) => out.push(b'='),
            },
            c => out.push(c),
        }
        i += 1;
    }
    out
}

/// Decode RFC 2047 words (`=?UTF-8?q?Sel=C3=A7uk?=`) in a header.
fn decode_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut after_word = false;
    while let Some(start) = rest.find("=?") {
        let Some(len) = rest[start + 2..].find("?=") else { break };
        let end = start + 2 + len;
        let mut parts = rest[start + 2..end].splitn(3, '?');
        let (_charset, enc, text) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let decoded = match enc.to_ascii_lowercase().as_str() {
            "q" => Some(decode_q(text)),
            "b" => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(text).ok()
            }
            _ => None,
        };
        let between = &rest[..start];
        // Whitespace between two encoded words isn't part of the text.
        if !(after_word && between.trim().is_empty()) {
            out.push_str(between);
        }
        match decoded {
            Some(b) => out.push_str(&String::from_utf8_lossy(&b)),
            None => out.push_str(&rest[start..end + 2]),
        }
        after_word = true;
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    out
}

/// `Thu, 1 Jan 2026 10:20:30 +0300` → (seconds since the epoch, offset).
fn parse_date(s: &str) -> Option<(i64, i32)> {
    let s = s.split_once(',').map_or(s, |(_, rest)| rest).trim();
    let mut t = s.split_whitespace();
    let day: i64 = t.next()?.parse().ok()?;
    let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
        .iter()
        .position(|m| t.clone().next().is_some_and(|x| x.to_ascii_lowercase().starts_with(m)))? as i64
        + 1;
    t.next();
    let year: i64 = t.next()?.parse().ok()?;
    let mut hms = t.next()?.split(':').map(|x| x.parse::<i64>().ok());
    let (h, m, sec) = (hms.next()??, hms.next()??, hms.next().flatten().unwrap_or(0));
    let zone = t.next().unwrap_or("+0000");
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let digits = zone.trim_start_matches(['+', '-']);
    let offset = if digits.len() == 4 {
        sign * (digits[..2].parse::<i32>().ok()? * 60 + digits[2..].parse::<i32>().ok()?)
    } else {
        0
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y, mo) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * mo + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let local = days * 86400 + h * 3600 + m * 60 + sec;
    Some((local - offset as i64 * 60, offset))
}

/// Split a mailbox (or a plain diff) into its patches.
pub fn parse(text: &str) -> Vec<Mail> {
    let text = text.replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    if !lines.iter().any(|l| is_mbox_start(l)) && !lines.iter().any(|l| l.starts_with("Subject:")) {
        return vec![Mail { diff: text.clone(), ..Mail::default() }];
    }
    let mut mails = Vec::new();
    let mut chunks: Vec<Vec<&str>> = Vec::new();
    for l in &lines {
        if is_mbox_start(l) || chunks.is_empty() {
            chunks.push(Vec::new());
            if is_mbox_start(l) {
                continue;
            }
        }
        chunks.last_mut().expect("pushed").push(l);
    }
    for chunk in chunks {
        let mut mail = Mail::default();
        let mut i = 0;
        // Headers, with folded continuation lines.
        let mut headers: Vec<(String, String)> = Vec::new();
        while i < chunk.len() && !chunk[i].is_empty() {
            let l = chunk[i];
            if (l.starts_with(' ') || l.starts_with('\t')) && !headers.is_empty() {
                let last = headers.last_mut().expect("checked");
                last.1.push(' ');
                last.1.push_str(l.trim());
            } else if let Some((k, v)) = l.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
            }
            i += 1;
        }
        for (k, v) in &headers {
            match k.as_str() {
                "from" => {
                    let v = decode_words(v);
                    mail.author = match v.rsplit_once('<') {
                        Some((name, email)) => Some((name.trim().trim_matches('"').to_owned(), email.trim_end_matches('>').trim().to_owned())),
                        None => Some((v.trim().to_owned(), v.trim().to_owned())),
                    };
                }
                "date" => mail.date = parse_date(v),
                "subject" => {
                    let v = decode_words(v);
                    let v = v.trim();
                    // "[PATCH 2/3] Fix it" → "Fix it"
                    mail.subject = match v.strip_prefix('[').and_then(|r| r.split_once(']')) {
                        Some((tag, rest)) if tag.to_ascii_uppercase().contains("PATCH") => rest.trim().to_owned(),
                        _ => v.to_owned(),
                    };
                }
                _ => {}
            }
        }
        // Message body up to "---", then the diff up to the signature.
        let rest = &chunk[i.min(chunk.len())..];
        let sep = rest.iter().position(|l| *l == "---");
        let diff_start = rest.iter().position(|l| l.starts_with("diff --git ")).unwrap_or(rest.len());
        let body_end = sep.filter(|s| *s < diff_start).unwrap_or(diff_start);
        mail.body = rest[..body_end].join("\n").trim().to_owned();
        let diff_end = rest[diff_start..].iter().position(|l| *l == "-- ").map_or(rest.len(), |e| diff_start + e);
        mail.diff = rest[diff_start..diff_end].join("\n");
        if !mail.diff.ends_with('\n') {
            mail.diff.push('\n');
        }
        if mail.diff.trim().is_empty() && mail.subject.is_empty() {
            continue;
        }
        mails.push(mail);
    }
    mails
}

fn apply_error(e: git2::Error, which: &str) -> Error {
    Error::msg(format!("{which} doesn't apply to your files: {}", e.message()))
}

/// Apply a patch file. As commits (`commit`): each patch is applied to the
/// index and work tree and committed with its author, date and message.
/// Otherwise the changes land in the work tree only, uncommitted. Returns
/// how many commits were made.
pub fn apply(repo: &Path, text: &str, commit: bool) -> Result<usize> {
    let r = repos::open(repo)?;
    let mails = parse(text);
    if mails.iter().all(|m| m.diff.trim().is_empty()) {
        return Err(Error::msg("There's no diff in that file"));
    }
    if !commit {
        for (n, m) in mails.iter().enumerate() {
            let diff = Diff::from_buffer(m.diff.as_bytes()).map_err(|e| Error::msg(format!("Not a patch: {}", e.message())))?;
            r.apply(&diff, ApplyLocation::WorkDir, None).map_err(|e| apply_error(e, &format!("Patch {}", n + 1)))?;
        }
        return Ok(0);
    }
    if r.index()?.has_conflicts() {
        return Err(Error::msg("Resolve the conflicts first"));
    }
    let head = ops::head_commit(&r);
    let staged = r.diff_tree_to_index(head.as_ref().map(|h| h.tree()).transpose()?.as_ref(), None, None)?;
    if staged.deltas().len() > 0 {
        return Err(Error::msg("Commit or unstage your staged changes first; patches are committed on their own"));
    }
    let total = mails.len();
    for (n, m) in mails.iter().enumerate() {
        let which = if total > 1 { format!("Patch {} of {total} (“{}”)", n + 1, m.subject) } else { format!("“{}”", m.subject) };
        let done = |e: Error| if n == 0 { e } else { Error::msg(format!("Committed {n} of {total}; {e}")) };
        let diff = Diff::from_buffer(m.diff.as_bytes()).map_err(|e| done(Error::msg(format!("Not a patch: {}", e.message()))))?;
        r.apply(&diff, ApplyLocation::Both, None).map_err(|e| done(apply_error(e, &which)))?;
        let mut index = r.index()?;
        index.read(false)?;
        let tree = r.find_tree(index.write_tree()?)?;
        let committer = ops::committer(&r)?;
        let author = match (&m.author, m.date) {
            (Some((name, email)), Some((t, off))) => Signature::new(name, email, &Time::new(t, off))?,
            (Some((name, email)), None) => Signature::now(name, email)?,
            _ => committer.clone(),
        };
        let subject = if m.subject.is_empty() { "Applied patch".to_owned() } else { m.subject.clone() };
        let message = if m.body.is_empty() { format!("{subject}\n") } else { format!("{subject}\n\n{}\n", m.body) };
        let parent = ops::head_commit(&r);
        let parents: Vec<&Commit> = parent.iter().collect();
        let oid = sign::commit(&r, &author, &committer, &message, &tree, &parents)?;
        ops::update_head(&r, oid, &format!("am: {subject}"))?;
    }
    Ok(total)
}
