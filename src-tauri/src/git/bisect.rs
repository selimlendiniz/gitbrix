//! Bisect: find the commit that introduced a problem by halving the range
//! between a good and a bad commit. State is kept where git keeps it
//! (`BISECT_START`, `BISECT_LOG`, `refs/bisect/*`), so `git bisect` sees
//! the same session and libgit2 reports the repository as bisecting.

use std::collections::HashSet;
use std::path::Path;

use git2::{Oid, Repository};
use serde::Serialize;

use super::{ops, repo as repos};
use crate::error::{Error, Result};

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub active: bool,
    pub bad: Option<String>,
    pub good: Vec<String>,
    pub skipped: Vec<String>,
    /// The commit being tested (HEAD while bisecting).
    pub current: Option<String>,
    /// Commits that may still be the first bad one.
    pub remaining: usize,
    /// Roughly how many more verdicts are needed.
    pub steps: u32,
    /// The first bad commit, once found.
    pub found: Option<String>,
}

fn git_dir(r: &Repository) -> &Path {
    r.path()
}

fn active(r: &Repository) -> bool {
    git_dir(r).join("BISECT_START").exists()
}

fn refs(r: &Repository, prefix: &str) -> Vec<Oid> {
    r.references_glob(&format!("refs/bisect/{prefix}*"))
        .map(|it| it.flatten().filter_map(|rf| rf.target()).collect())
        .unwrap_or_default()
}

fn bad(r: &Repository) -> Option<Oid> {
    r.refname_to_id("refs/bisect/bad").ok()
}

fn log(r: &Repository, line: &str) -> Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(git_dir(r).join("BISECT_LOG"))?;
    writeln!(f, "{line}")?;
    Ok(())
}

fn mark(r: &Repository, verdict: &str, id: Oid) -> Result<()> {
    let name = match verdict {
        "bad" => "refs/bisect/bad".to_owned(),
        "good" | "skip" => format!("refs/bisect/{verdict}-{id}"),
        other => return Err(Error::msg(format!("Unknown verdict {other}"))),
    };
    r.reference(&name, id, true, "bisect")?;
    let summary = r.find_commit(id).ok().and_then(|c| c.summary().ok().flatten().map(str::to_owned)).unwrap_or_default();
    log(r, &format!("# {verdict}: [{id}] {summary}"))?;
    log(r, &format!("git bisect {verdict} {id}"))
}

/// Commits that may be the first bad one: reachable from bad, not from any
/// good commit. Newest first.
fn candidates(r: &Repository) -> Result<Vec<Oid>> {
    let Some(bad) = bad(r) else { return Ok(Vec::new()) };
    let mut walk = r.revwalk()?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL)?;
    walk.push(bad)?;
    for g in refs(r, "good-") {
        walk.hide(g)?;
    }
    Ok(walk.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// The candidate that splits the rest most evenly: as many candidates
/// reachable from it as not. Skipped commits aren't chosen.
fn midpoint(r: &Repository, cands: &[Oid], skipped: &HashSet<Oid>) -> Result<Option<Oid>> {
    let set: HashSet<Oid> = cands.iter().copied().collect();
    let n = cands.len();
    let mut best: Option<(usize, Oid)> = None;
    // Exact counts are quadratic; past a few hundred, the topological
    // middle is close enough for one step.
    if n > 400 {
        let mid = cands.iter().skip(n / 2).chain(cands.iter()).find(|c| !skipped.contains(c));
        return Ok(mid.copied());
    }
    for &c in cands {
        if skipped.contains(&c) {
            continue;
        }
        let mut walk = r.revwalk()?;
        walk.push(c)?;
        for g in refs(r, "good-") {
            walk.hide(g)?;
        }
        let below = walk.flatten().filter(|o| set.contains(o)).count();
        let score = below.min(n - below);
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, c));
        }
    }
    Ok(best.map(|(_, c)| c))
}

pub fn status(r: &Repository) -> Result<Status> {
    if !active(r) {
        return Ok(Status::default());
    }
    let bad_id = bad(r);
    let good = refs(r, "good-");
    let skipped = refs(r, "skip-");
    let cands = candidates(r)?;
    let skip_set: HashSet<Oid> = skipped.iter().copied().collect();
    let open: Vec<Oid> = cands.iter().copied().filter(|c| !skip_set.contains(c)).collect();
    // Found once nothing but the bad commit is left (skipped commits still
    // count: the culprit could be one of them).
    let found = match (bad_id, good.is_empty()) {
        (Some(b), false) if cands == [b] => Some(b.to_string()),
        _ => None,
    };
    let remaining = open.len();
    Ok(Status {
        active: true,
        bad: bad_id.map(|o| o.to_string()),
        good: good.iter().map(Oid::to_string).collect(),
        skipped: skipped.iter().map(Oid::to_string).collect(),
        current: r.head().ok().and_then(|h| h.target()).map(|o| o.to_string()),
        remaining,
        steps: if found.is_some() || remaining <= 1 { 0 } else { (remaining as f64).log2().ceil() as u32 },
        found,
    })
}

/// Check out the next commit to test, unless the culprit is known.
fn next(r: &Repository) -> Result<Status> {
    let st = status(r)?;
    if st.found.is_some() || st.bad.is_none() || st.good.is_empty() {
        return Ok(st);
    }
    let skipped: HashSet<Oid> = refs(r, "skip-").into_iter().collect();
    let bad_id = bad(r).expect("checked");
    let cands: Vec<Oid> = candidates(r)?.into_iter().filter(|c| *c != bad_id).collect();
    let Some(pick) = midpoint(r, &cands, &skipped)? else {
        return Err(Error::msg("Only skipped commits are left; the first bad commit is one of them"));
    };
    let commit = r.find_commit(pick)?;
    ops::safe_checkout(r, commit.as_object())?;
    r.set_head_detached(pick)?;
    status(r)
}

fn resolve(r: &Repository, rev: &str) -> Result<Oid> {
    ops::check_name(rev)?;
    r.revparse_single(rev).and_then(|o| o.peel_to_commit()).map(|c| c.id()).map_err(|_| Error::msg(format!("Unknown revision {rev}")))
}

/// Start with a known bad and a known good commit; checks out the first
/// commit to test.
pub fn start(repo: &Path, bad_rev: &str, good_rev: &str) -> Result<Status> {
    let r = repos::open(repo)?;
    if active(&r) {
        return Err(Error::msg("A bisect is already running; stop it first"));
    }
    if r.state() != git2::RepositoryState::Clean {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    let (b, g) = (resolve(&r, bad_rev)?, resolve(&r, good_rev)?);
    if b == g {
        return Err(Error::msg("The good and the bad commit are the same"));
    }
    if !r.graph_descendant_of(b, g)? {
        return Err(Error::msg("The good commit must be older than the bad one (an ancestor of it)"));
    }
    // Where to go back to: the branch, or the commit when detached.
    let head = r.head()?;
    let back = if head.is_branch() { head.shorthand()?.to_owned() } else { head.target().map(|o| o.to_string()).unwrap_or_default() };
    drop(head);
    std::fs::write(git_dir(&r).join("BISECT_START"), format!("{back}\n"))?;
    log(&r, "git bisect start")?;
    mark(&r, "bad", b)?;
    mark(&r, "good", g)?;
    next(&r)
}

/// Record a verdict for `rev` (the commit being tested by default) and
/// move on.
pub fn verdict(repo: &Path, verdict: &str, rev: Option<&str>) -> Result<Status> {
    let r = repos::open(repo)?;
    if !active(&r) {
        return Err(Error::msg("No bisect is running"));
    }
    let id = match rev {
        Some(rev) => resolve(&r, rev)?,
        None => ops::head_commit(&r).ok_or_else(|| Error::msg("No commit checked out"))?.id(),
    };
    mark(&r, verdict, id)?;
    next(&r)
}

/// Stop: back to where the bisect started, state removed.
pub fn reset(repo: &Path) -> Result<()> {
    let r = repos::open(repo)?;
    let start = git_dir(&r).join("BISECT_START");
    let back = std::fs::read_to_string(&start).map_err(|_| Error::msg("No bisect is running"))?;
    let back = back.trim();
    if let Ok(b) = r.find_branch(back, git2::BranchType::Local) {
        let target = b.get().peel_to_commit()?;
        ops::safe_checkout(&r, target.as_object())?;
        r.set_head(&format!("refs/heads/{back}"))?;
    } else if let Ok(id) = Oid::from_str(back) {
        let target = r.find_commit(id)?;
        ops::safe_checkout(&r, target.as_object())?;
        r.set_head_detached(id)?;
    }
    for rf in r.references_glob("refs/bisect/*")?.flatten().filter_map(|rf| rf.name().ok().map(str::to_owned)).collect::<Vec<_>>() {
        if let Ok(mut rf) = r.find_reference(&rf) {
            rf.delete()?;
        }
    }
    for f in ["BISECT_START", "BISECT_LOG", "BISECT_NAMES", "BISECT_EXPECTED_REV", "BISECT_ANCESTORS_OK", "BISECT_TERMS"] {
        let _ = std::fs::remove_file(git_dir(&r).join(f));
    }
    Ok(())
}

/// Let a command decide each step, as `git bisect run` does: exit 0 good,
/// 125 skip, 1–127 bad, anything else stops. Runs in the work tree with
/// `sh -c`.
pub fn run(repo: &Path, command: &str, progress: &mut dyn FnMut(&str)) -> Result<Status> {
    if command.trim().is_empty() {
        return Err(Error::msg("Give a command to run, like `cargo test` or `./check.sh`"));
    }
    let workdir = repos::workdir(&repos::open(repo)?);
    for step in 1.. {
        let st = status(&repos::open(repo)?)?;
        if !st.active {
            return Err(Error::msg("No bisect is running"));
        }
        if st.found.is_some() {
            return Ok(st);
        }
        let current = st.current.clone().unwrap_or_default();
        progress(&format!("Step {step}: testing {}", &current[..current.len().min(7)]));
        let out = crate::host::command("sh", &[])
            .arg("-c")
            .arg(command)
            .current_dir(&workdir)
            .output()
            .map_err(|e| Error::msg(format!("Couldn't run the command: {e}")))?;
        let verdict_of = match out.status.code() {
            Some(0) => "good",
            Some(125) => "skip",
            Some(1..=127) => "bad",
            other => {
                return Err(Error::msg(format!(
                    "The command stopped the bisect (exit {}): {}",
                    other.map_or("by a signal".into(), |c| c.to_string()),
                    String::from_utf8_lossy(&out.stderr).trim()
                )))
            }
        };
        verdict(repo, verdict_of, None)?;
    }
    unreachable!()
}
