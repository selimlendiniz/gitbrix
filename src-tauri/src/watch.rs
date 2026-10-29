//! Watches the open repository and tells the frontend when something
//! changed on disk (edits in an editor, commits from a terminal, ...).
//!
//! Events are filtered (ignored files, object database churn, lock files)
//! and debounced, then a single `repo-changed` event is emitted.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

const DEBOUNCE: Duration = Duration::from_millis(300);

/// The single active watcher; replaced when another repo is opened.
#[derive(Default)]
pub struct WatchState(Mutex<Option<RecommendedWatcher>>);

/// Does a change at `path` affect what the UI shows?
pub fn is_relevant(path: &Path, workdir: &Path, gitdir: &Path, ignored: impl Fn(&Path) -> bool) -> bool {
    if let Ok(rel) = path.strip_prefix(gitdir) {
        let rel = rel.to_string_lossy();
        if rel.ends_with(".lock") {
            return false;
        }
        return rel == "HEAD"
            || rel == "index"
            || rel == "packed-refs"
            || rel.starts_with("refs/")
            || rel.ends_with("_HEAD") // MERGE_HEAD, CHERRY_PICK_HEAD, ...
            || rel.starts_with("rebase-merge")
            || rel.starts_with("rebase-apply");
    }
    match path.strip_prefix(workdir) {
        Ok(rel) if !rel.as_os_str().is_empty() => !ignored(rel),
        _ => false,
    }
}

pub fn watch(app: AppHandle, state: &WatchState, repo_path: &str) -> Result<()> {
    let repo = git2::Repository::discover(repo_path)?;
    let workdir: PathBuf = repo.workdir().ok_or_else(|| Error::msg("bare repository"))?.to_path_buf();
    let gitdir = repo.path().to_path_buf();
    // Canonical paths, so prefix checks match what inotify reports.
    let workdir = workdir.canonicalize().unwrap_or(workdir);
    let gitdir = gitdir.canonicalize().unwrap_or(gitdir);

    let (tx, rx) = channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| Error::msg(e.to_string()))?;
    watcher
        .watch(&workdir, RecursiveMode::Recursive)
        .map_err(|e| Error::msg(format!("Cannot watch {}: {e}", workdir.display())))?;
    if !gitdir.starts_with(&workdir) {
        // Worktrees and separate git dirs live elsewhere.
        let _ = watcher.watch(&gitdir, RecursiveMode::Recursive);
    }

    let shown = repo_path.to_owned();
    std::thread::spawn(move || {
        let ignored = |rel: &Path| repo.is_path_ignored(rel).unwrap_or(false);
        let relevant = |ev: &notify::Event| ev.paths.iter().any(|p| is_relevant(p, &workdir, &gitdir, ignored));
        // The loop ends when the watcher is dropped and the channel closes.
        while let Ok(ev) = rx.recv() {
            let Ok(ev) = ev else { continue };
            if !relevant(&ev) {
                continue;
            }
            // Swallow the burst that follows (a checkout touches many files).
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(_) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("repo-changed", &shown);
        }
    });

    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

pub fn unwatch(state: &WatchState) {
    *state.0.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_paths() {
        let wd = Path::new("/r");
        let gd = Path::new("/r/.git");
        let ign = |p: &Path| p.starts_with("target");
        let rel = |p: &str| is_relevant(Path::new(p), wd, gd, ign);

        assert!(rel("/r/src/main.rs"));
        assert!(!rel("/r/target/debug/x"));
        assert!(!rel("/r"));
        assert!(rel("/r/.git/HEAD"));
        assert!(rel("/r/.git/index"));
        assert!(rel("/r/.git/refs/heads/main"));
        assert!(rel("/r/.git/MERGE_HEAD"));
        assert!(!rel("/r/.git/index.lock"));
        assert!(!rel("/r/.git/objects/ab/cdef"));
        assert!(!rel("/r/.git/logs/HEAD"));
        assert!(!rel("/elsewhere/file"));
    }
}
