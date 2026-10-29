//! Watches the open repository and tells the frontend when something
//! changed on disk (edits in an editor, commits from a terminal, ...).
//!
//! Events are filtered (ignored files, object database churn, lock files)
//! and debounced, then a single `repo-changed` event is emitted.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Mutex;
use std::time::Duration;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

const DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Clone, Serialize)]
struct Changed {
    path: String,
    /// Something under the git dir changed (refs, HEAD, index), not just
    /// work tree files: the graph may need reloading.
    git: bool,
}

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

/// inotify also reports files being opened and read. Our own refresh reads
/// refs and the index, so reacting to reads would refresh forever.
pub fn changes_content(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
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
        let relevant = |ev: &notify::Event| {
            changes_content(&ev.kind) && ev.paths.iter().any(|p| is_relevant(p, &workdir, &gitdir, ignored))
        };
        // Staging only rewrites the index, which can't change the graph.
        let index = gitdir.join("index");
        let in_git = |ev: &notify::Event| {
            changes_content(&ev.kind)
                && ev
                    .paths
                    .iter()
                    .any(|p| p.starts_with(&gitdir) && *p != index && is_relevant(p, &workdir, &gitdir, |_| false))
        };
        // The loop ends when the watcher is dropped and the channel closes.
        while let Ok(ev) = rx.recv() {
            let Ok(ev) = ev else { continue };
            if !relevant(&ev) {
                continue;
            }
            let mut git = in_git(&ev);
            // Swallow the burst that follows (a checkout touches many files).
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(Ok(ev)) => git |= in_git(&ev),
                    Ok(Err(_)) => continue,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app.emit("repo-changed", Changed { path: shown.clone(), git });
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

    #[test]
    fn ignores_reads() {
        use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind};
        assert!(!changes_content(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!changes_content(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(changes_content(&EventKind::Modify(ModifyKind::Any)));
        assert!(changes_content(&EventKind::Create(CreateKind::File)));
    }

    /// Reading the repository the way a refresh does must not produce a
    /// change event (it once caused an endless refresh loop).
    #[test]
    fn reading_the_repo_is_not_a_change() {
        use std::sync::mpsc::channel;
        let dir = tempfile::TempDir::new().unwrap();
        let p = dir.path();
        std::process::Command::new("git").args(["init", "-q"]).arg(p).status().unwrap();
        std::fs::write(p.join("f.txt"), "x").unwrap();
        let (tx, rx) = channel::<notify::Result<notify::Event>>();
        let mut w = notify::recommended_watcher(tx).unwrap();
        w.watch(p, RecursiveMode::Recursive).unwrap();
        let _ = std::fs::read(p.join(".git/HEAD")).unwrap();
        let _ = std::fs::read(p.join("f.txt")).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let changes: Vec<_> = rx.try_iter().flatten().filter(|e| changes_content(&e.kind)).collect();
        assert!(changes.is_empty(), "{changes:?}");
        std::fs::write(p.join("f.txt"), "y").unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(rx.try_iter().flatten().any(|e| changes_content(&e.kind)));
    }
}
