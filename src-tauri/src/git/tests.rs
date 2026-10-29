//! End-to-end tests against throwaway repositories built with the real
//! `git` CLI.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::{diff, log, ops, refs, repo, status};

struct TestRepo {
    _dir: TempDir,
    path: PathBuf,
}

fn git_in(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// Repo-local settings that shield tests from the developer's global git
/// config (signing, hooks, default branch name).
fn isolate(path: &Path) {
    for (k, v) in [
        ("user.name", "Test User"),
        ("user.email", "test@example.com"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.hooksPath", "/dev/null"),
        ("pull.rebase", "false"),
    ] {
        git_in(path, &["config", k, v]);
    }
}

impl TestRepo {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("work");
        fs::create_dir(&path).unwrap();
        git_in(&path, &["init", "-q", "-b", "main"]);
        isolate(&path);
        TestRepo { _dir: dir, path }
    }

    fn git(&self, args: &[&str]) -> String {
        git_in(&self.path, args)
    }

    fn write(&self, file: &str, content: &str) {
        let p = self.path.join(file);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(p, content).unwrap();
    }

    fn commit(&self, file: &str, content: &str, msg: &str) -> String {
        self.write(file, content);
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
        self.git(&["rev-parse", "HEAD"])
    }

    fn open(&self) -> git2::Repository {
        repo::open(&self.path).unwrap()
    }

    /// A bare repo next to the work tree, registered as `origin`.
    fn add_origin(&self) -> PathBuf {
        let bare = self.path.parent().unwrap().join("origin.git");
        git_in(self.path.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", "origin.git"]);
        self.git(&["remote", "add", "origin", bare.to_str().unwrap()]);
        bare
    }
}

#[test]
fn graph_of_branch_and_merge() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit("b.txt", "1\n", "on feature");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "2\n", "on main");
    t.git(&["merge", "-q", "--no-ff", "-m", "merge feature", "feature"]);

    let g = log::graph(&t.open(), 1000, false).unwrap();
    let summaries: Vec<&str> = g.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(summaries[0], "merge feature");
    assert_eq!(*summaries.last().unwrap(), "first");
    assert_eq!(g.commits.len(), 4);
    assert_eq!(g.max_lanes, 2);
    assert!(!g.truncated);
    assert_eq!(g.commits[0].parents.len(), 2);

    let names: Vec<&str> = g.refs.iter().map(|r| r.name.as_str()).collect();
    assert!(names.contains(&"main") && names.contains(&"feature"));
    let main = g.refs.iter().find(|r| r.name == "main").unwrap();
    assert!(main.is_head);
    assert_eq!(main.target, g.commits[0].id);
}

#[test]
fn graph_limit_and_wip_row() {
    let t = TestRepo::new();
    for i in 0..5 {
        t.commit("f.txt", &format!("{i}\n"), &format!("c{i}"));
    }
    let g = log::graph(&t.open(), 3, true).unwrap();
    assert!(g.truncated);
    assert_eq!(g.commits.len(), 4, "3 commits + WIP");
    assert_eq!(g.commits[0].id, log::WIP_ID);
    assert_eq!(g.commits[0].parents, vec![g.commits[1].id.clone()]);
    assert_eq!(g.commits[0].lane, g.commits[1].lane);
}

#[test]
fn graph_of_empty_repo() {
    let t = TestRepo::new();
    let g = log::graph(&t.open(), 100, true).unwrap();
    assert!(g.commits.is_empty());
    let info = repo::info(&t.open()).unwrap();
    assert!(info.unborn);
    assert_eq!(info.head_branch.as_deref(), Some("main"));
}

#[test]
fn status_stage_unstage_commit() {
    let t = TestRepo::new();
    t.commit("tracked.txt", "one\n", "init");
    t.write("tracked.txt", "one\ntwo\n");
    t.write("new/file.txt", "hello\n");

    let st = status::status(&t.open()).unwrap();
    assert!(st.staged.is_empty());
    let mut unstaged: Vec<(&str, &str)> =
        st.unstaged.iter().map(|e| (e.path.as_str(), e.status)).collect();
    unstaged.sort();
    assert_eq!(unstaged, vec![("new/file.txt", "untracked"), ("tracked.txt", "modified")]);

    ops::stage(&t.path, &["tracked.txt".into()]).unwrap();
    let st = status::status(&t.open()).unwrap();
    assert_eq!(st.staged.len(), 1);
    assert_eq!(st.staged[0].status, "modified");

    ops::unstage(&t.path, &["tracked.txt".into()]).unwrap();
    assert!(status::status(&t.open()).unwrap().staged.is_empty());

    ops::stage_all(&t.path).unwrap();
    ops::commit(&t.path, "second\n\nbody", false).unwrap();
    let st = status::status(&t.open()).unwrap();
    assert!(!st.is_dirty());
    assert_eq!(t.git(&["log", "-1", "--format=%s"]), "second");

    ops::commit(&t.path, "second, amended", true).unwrap();
    assert_eq!(t.git(&["rev-list", "--count", "HEAD"]), "2");
    assert_eq!(t.git(&["log", "-1", "--format=%s"]), "second, amended");
}

#[test]
fn unstage_in_repo_without_commits() {
    let t = TestRepo::new();
    t.write("a.txt", "x\n");
    ops::stage_all(&t.path).unwrap();
    assert_eq!(status::status(&t.open()).unwrap().staged.len(), 1);
    ops::unstage(&t.path, &["a.txt".into()]).unwrap();
    let st = status::status(&t.open()).unwrap();
    assert!(st.staged.is_empty());
    assert_eq!(st.unstaged[0].status, "untracked");
}

#[test]
fn discard_restores_and_removes() {
    let t = TestRepo::new();
    t.commit("a.txt", "orig\n", "init");
    t.write("a.txt", "changed\n");
    t.write("junk.txt", "junk\n");
    ops::discard(&t.path, &["a.txt".into()], &["junk.txt".into()]).unwrap();
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "orig\n");
    assert!(!t.path.join("junk.txt").exists());
}

#[test]
fn empty_commit_message_is_rejected() {
    let t = TestRepo::new();
    t.write("a.txt", "x\n");
    ops::stage_all(&t.path).unwrap();
    assert!(ops::commit(&t.path, "   \n", false).is_err());
}

#[test]
fn commit_details_and_file_diff() {
    let t = TestRepo::new();
    t.commit("a.txt", "one\ntwo\nthree\n", "init");
    let id = t.commit("a.txt", "one\nTWO\nthree\nfour\n", "edit");
    let r = t.open();
    let oid = git2::Oid::from_str(&id).unwrap();

    let d = diff::commit_details(&r, oid).unwrap();
    assert_eq!(d.message.trim(), "edit");
    assert_eq!(d.author.name, "Test User");
    assert_eq!(d.files.len(), 1);
    let f = &d.files[0];
    assert_eq!((f.path.as_str(), f.status, f.additions, f.deletions), ("a.txt", "modified", 2, 1));

    let fd = diff::commit_file_diff(&r, oid, "a.txt", None).unwrap();
    assert_eq!(fd.hunks.len(), 1);
    let kinds: Vec<(&str, &str)> =
        fd.hunks[0].lines.iter().map(|l| (l.kind, l.text.as_str())).collect();
    assert_eq!(
        kinds,
        vec![("ctx", "one"), ("del", "two"), ("add", "TWO"), ("ctx", "three"), ("add", "four")]
    );
    assert_eq!(fd.hunks[0].lines[1].old_no, Some(2));
    assert_eq!(fd.hunks[0].lines[2].new_no, Some(2));
}

#[test]
fn root_commit_and_rename_diffs() {
    let t = TestRepo::new();
    let root = t.commit("a.txt", "line\n".repeat(20).as_str(), "root");
    let r = t.open();
    let d = diff::commit_details(&r, git2::Oid::from_str(&root).unwrap()).unwrap();
    assert_eq!(d.files[0].status, "added");
    assert_eq!(d.files[0].additions, 20);

    t.git(&["mv", "a.txt", "b.txt"]);
    t.git(&["commit", "-q", "-m", "rename"]);
    let id = t.git(&["rev-parse", "HEAD"]);
    let r = t.open();
    let d = diff::commit_details(&r, git2::Oid::from_str(&id).unwrap()).unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].status, "renamed");
    assert_eq!(d.files[0].old_path.as_deref(), Some("a.txt"));
    let fd = diff::commit_file_diff(&r, git2::Oid::from_str(&id).unwrap(), "b.txt", Some("a.txt")).unwrap();
    assert_eq!(fd.status, "renamed");
}

#[test]
fn workdir_diffs() {
    let t = TestRepo::new();
    t.commit("a.txt", "a\n", "init");
    t.write("a.txt", "a\nb\n");
    t.write("u.txt", "untracked\n");
    let r = t.open();

    let fd = diff::workdir_file_diff(&r, "u.txt", false).unwrap();
    assert_eq!(fd.status, "untracked");
    assert_eq!(fd.hunks[0].lines[0].text, "untracked");

    ops::stage(&t.path, &["a.txt".into()]).unwrap();
    let r = t.open();
    let staged = diff::workdir_file_diff(&r, "a.txt", true).unwrap();
    assert_eq!(staged.hunks[0].lines.iter().filter(|l| l.kind == "add").count(), 1);
    assert!(diff::workdir_file_diff(&r, "a.txt", false).is_err(), "nothing unstaged left");
}

#[test]
fn branches_tags_and_checkout() {
    let t = TestRepo::new();
    let first = t.commit("a.txt", "1\n", "first");
    t.commit("a.txt", "2\n", "second");

    ops::create_branch(&t.path, "topic", Some(&first), false).unwrap();
    ops::create_tag(&t.path, "v1", &first, Some("release one")).unwrap();
    ops::create_tag(&t.path, "light", "HEAD", None).unwrap();

    let all = refs::list(&t.open()).unwrap();
    let topic = all.iter().find(|r| r.name == "topic").unwrap();
    assert_eq!(topic.target, first);
    assert!(!topic.is_head);
    // Annotated tags are peeled to the commit they tag.
    let v1 = all.iter().find(|r| r.name == "v1").unwrap();
    assert_eq!(v1.target, first);

    ops::checkout_branch(&t.path, "topic").unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().head_branch.as_deref(), Some("topic"));

    ops::rename_branch(&t.path, "topic", "topic2").unwrap();
    ops::checkout_detached(&t.path, "main").unwrap();
    let info = repo::info(&t.open()).unwrap();
    assert!(info.detached);
    assert_eq!(info.head_branch, None);

    // topic2 is not merged into HEAD (it's behind, so it is merged) —
    // `-d` succeeds for an ancestor.
    ops::delete_branch(&t.path, "topic2", false).unwrap();
    ops::delete_tag(&t.path, "light").unwrap();
    let names: Vec<String> = refs::list(&t.open()).unwrap().into_iter().map(|r| r.name).collect();
    assert_eq!(names, vec!["main", "v1"]);
}

#[test]
fn option_like_names_are_rejected() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    assert!(ops::create_branch(&t.path, "--force", None, false).is_err());
    assert!(ops::checkout_branch(&t.path, "-b").is_err());
}

#[test]
fn stash_roundtrip() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.write("a.txt", "dirty\n");
    t.write("new.txt", "new\n");
    ops::stash_save(&t.path, Some("wip stuff"), true).unwrap();
    assert!(!status::status(&t.open()).unwrap().is_dirty());

    let list = refs::stashes(&mut t.open()).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].message.contains("wip stuff"));
    assert_eq!(list[0].base.as_deref(), Some(t.git(&["rev-parse", "HEAD"]).as_str()));

    ops::stash_apply(&t.path, 0, true).unwrap();
    assert!(t.path.join("new.txt").exists());
    assert!(refs::stashes(&mut t.open()).unwrap().is_empty());
}

#[test]
fn reset_revert_cherry_pick() {
    let t = TestRepo::new();
    let first = t.commit("a.txt", "1\n", "first");
    t.commit("a.txt", "2\n", "second");

    ops::revert(&t.path, "HEAD").unwrap();
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "1\n");

    t.git(&["switch", "-q", "-c", "side", &first]);
    let side = t.commit("s.txt", "s\n", "side work");
    t.git(&["switch", "-q", "main"]);
    ops::cherry_pick(&t.path, &side).unwrap();
    assert!(t.path.join("s.txt").exists());

    ops::reset(&t.path, &first, "hard").unwrap();
    assert_eq!(t.git(&["rev-parse", "HEAD"]), first);
    assert!(ops::reset(&t.path, &first, "bogus").is_err());
}

#[test]
fn merge_conflict_then_abort() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "other"]);
    t.commit("a.txt", "other\n", "other");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "main\n", "main");

    assert!(ops::merge(&t.path, "other").is_err(), "conflict reports an error");
    let r = t.open();
    assert_eq!(repo::info(&r).unwrap().state, "merge");
    let st = status::status(&r).unwrap();
    assert_eq!(st.conflicted.len(), 1);

    ops::sequencer(&t.path, "merge", "abort").unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().state, "clean");
}

#[test]
fn push_sets_upstream_then_tracks_ahead_behind() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.add_origin();

    ops::push(&t.path, false).unwrap();
    let info = repo::info(&t.open()).unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (0, 0));

    t.commit("a.txt", "2\n", "second");
    let info = repo::info(&t.open()).unwrap();
    assert_eq!((info.ahead, info.behind), (1, 0));

    ops::push(&t.path, false).unwrap();
    ops::fetch(&t.path).unwrap();
    let main = refs::list(&t.open()).unwrap().into_iter().find(|r| r.name == "main").unwrap();
    assert_eq!((main.ahead, main.behind), (0, 0));
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));

    // Remote branches show up, but not origin/HEAD.
    let names: Vec<String> = refs::list(&t.open()).unwrap().into_iter().map(|r| r.name).collect();
    assert!(names.contains(&"origin/main".to_owned()));
}

#[test]
fn pull_fast_forwards_from_clone() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let bare = t.add_origin();
    ops::push(&t.path, false).unwrap();

    // Someone else pushes a commit.
    let other = t.path.parent().unwrap().join("other");
    git_in(t.path.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    isolate(&other);
    fs::write(other.join("b.txt"), "b\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "from other"]);
    git_in(&other, &["push", "-q"]);

    ops::fetch(&t.path).unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().behind, 1);
    ops::pull(&t.path, "ff-only").unwrap();
    assert!(t.path.join("b.txt").exists());
    assert!(ops::pull(&t.path, "sideways").is_err());
}

/// Records what the backend returns for a repository into the JSON
/// fixture the browser-only UI mode serves (src/mock/fixture.json).
/// Run through `scripts/record-fixture.sh`.
#[test]
#[ignore = "writes the UI fixture; run via scripts/record-fixture.sh"]
fn record_ui_fixture() {
    use serde_json::{json, Map, Value};

    let repo_path = std::env::var("GITBRIX_FIXTURE_REPO").expect("GITBRIX_FIXTURE_REPO");
    let out = std::env::var("GITBRIX_FIXTURE_OUT").expect("GITBRIX_FIXTURE_OUT");
    let shown_path = std::env::var("GITBRIX_FIXTURE_PATH_AS").ok();

    let r = repo::open(Path::new(&repo_path)).unwrap();
    let st = status::status(&r).unwrap();
    let g = log::graph(&r, 20_000, st.is_dirty()).unwrap();
    let mut info = serde_json::to_value(repo::info(&r).unwrap()).unwrap();
    if let Some(p) = &shown_path {
        info["path"] = json!(p);
    }

    let mut details = Map::new();
    let mut commit_diffs = Map::new();
    for c in g.commits.iter().filter(|c| c.id != log::WIP_ID).take(80) {
        let oid = git2::Oid::from_str(&c.id).unwrap();
        let d = diff::commit_details(&r, oid).unwrap();
        for f in &d.files {
            let fd = diff::commit_file_diff(&r, oid, &f.path, f.old_path.as_deref()).unwrap();
            commit_diffs.insert(format!("{}:{}", c.id, f.path), serde_json::to_value(fd).unwrap());
        }
        details.insert(c.id.clone(), serde_json::to_value(d).unwrap());
    }

    let mut wip_diffs = Map::new();
    for e in &st.staged {
        let fd = diff::workdir_file_diff(&r, &e.path, true).unwrap();
        wip_diffs.insert(format!("staged:{}", e.path), serde_json::to_value(fd).unwrap());
    }
    for e in st.unstaged.iter().chain(&st.conflicted) {
        if let Ok(fd) = diff::workdir_file_diff(&r, &e.path, false) {
            wip_diffs.insert(format!("unstaged:{}", e.path), serde_json::to_value(fd).unwrap());
        }
    }

    let head_message = r.head().unwrap().peel_to_commit().unwrap().message().unwrap_or("").to_owned();
    let fixture: Value = json!({
        "info": info,
        "graph": g,
        "status": st,
        "stashes": refs::stashes(&mut repo::open(Path::new(&repo_path)).unwrap()).unwrap(),
        "details": details,
        "commitDiffs": commit_diffs,
        "wipDiffs": wip_diffs,
        "headMessage": head_message,
    });
    fs::write(&out, serde_json::to_string(&fixture).unwrap()).unwrap();
}
