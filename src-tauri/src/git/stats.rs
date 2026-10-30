//! Repository statistics for the current branch: who commits, when, and
//! which files change most.

use std::collections::HashMap;

use git2::{Repository, Sort};
use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub email: String,
    pub commits: usize,
    pub first: i64,
    pub last: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotFile {
    pub path: String,
    /// Commits (of the recent ones looked at) that changed it.
    pub changes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub commits: usize,
    pub merges: usize,
    pub first: Option<i64>,
    pub last: Option<i64>,
    /// Most commits first.
    pub authors: Vec<Author>,
    /// Commits per week for the 52 weeks up to the newest commit, oldest first.
    pub weeks: Vec<usize>,
    /// Start of the first of those weeks (seconds since the epoch).
    pub weeks_start: i64,
    /// Commits by weekday (Monday first) and hour, in the author's own time.
    pub hours: Vec<Vec<usize>>,
    pub hot_files: Vec<HotFile>,
    /// How many recent commits `hot_files` comes from.
    pub hot_window: usize,
}

const WEEK: i64 = 7 * 86400;
const HOT_WINDOW: usize = 1000;

pub fn stats(r: &Repository) -> Result<Stats> {
    let head = r.head().ok().and_then(|h| h.target()).ok_or_else(|| Error::msg("There are no commits yet"))?;
    let mut walk = r.revwalk()?;
    walk.set_sorting(Sort::TIME)?;
    walk.push(head)?;

    let mut by_author: HashMap<String, Author> = HashMap::new();
    let mut times = Vec::new();
    let mut hours = vec![vec![0usize; 24]; 7];
    let mut merges = 0;
    let mut hot: HashMap<String, usize> = HashMap::new();
    let mut looked = 0;

    for (n, id) in walk.enumerate() {
        let c = r.find_commit(id?)?;
        let author = c.author();
        let when = author.when();
        let t = when.seconds();
        times.push(t);
        let local = t + when.offset_minutes() as i64 * 60;
        // 1970-01-01 was a Thursday: day 0 → index 3 with Monday first.
        let weekday = ((local.div_euclid(86400) + 3).rem_euclid(7)) as usize;
        let hour = (local.rem_euclid(86400) / 3600) as usize;
        hours[weekday][hour] += 1;
        if c.parent_count() > 1 {
            merges += 1;
        }
        let email = author.email().ok().unwrap_or("").to_lowercase();
        let name = author.name().ok().unwrap_or("").to_owned();
        let key = if email.is_empty() { name.clone() } else { email.clone() };
        let a = by_author.entry(key).or_insert_with(|| Author { name: name.clone(), email, commits: 0, first: t, last: t });
        a.commits += 1;
        a.first = a.first.min(t);
        a.last = a.last.max(t);

        // Files: from the newest commits only (a diff each), merges skipped.
        if n < HOT_WINDOW && c.parent_count() <= 1 {
            looked += 1;
            let parent = c.parents().next().map(|p| p.tree()).transpose()?;
            let diff = r.diff_tree_to_tree(parent.as_ref(), Some(&c.tree()?), None)?;
            for d in diff.deltas() {
                if let Some(p) = d.new_file().path().or_else(|| d.old_file().path()) {
                    *hot.entry(p.to_string_lossy().into_owned()).or_default() += 1;
                }
            }
        }
    }

    let last = times.iter().copied().max();
    let first = times.iter().copied().min();
    let weeks_start = last.map_or(0, |l| l - 51 * WEEK - l.rem_euclid(WEEK));
    let mut weeks = vec![0usize; 52];
    for t in &times {
        if *t >= weeks_start {
            let i = ((t - weeks_start) / WEEK) as usize;
            if let Some(w) = weeks.get_mut(i) {
                *w += 1;
            }
        }
    }
    let mut authors: Vec<Author> = by_author.into_values().collect();
    authors.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.name.cmp(&b.name)));
    let mut hot_files: Vec<HotFile> = hot.into_iter().map(|(path, changes)| HotFile { path, changes }).collect();
    hot_files.sort_by(|a, b| b.changes.cmp(&a.changes).then_with(|| a.path.cmp(&b.path)));
    hot_files.truncate(20);

    Ok(Stats { commits: times.len(), merges, first, last, authors, weeks, weeks_start, hours, hot_files, hot_window: looked })
}
