//! End-to-end tests against throwaway repositories built with the real
//! `git` CLI.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::{diff, log, ops, rebase, refs, repo, status};

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
    let g = log::graph(&t.open(), 100, false).unwrap();
    assert!(g.commits.is_empty());
    // With changes waiting for the first commit there is a WIP row.
    let g = log::graph(&t.open(), 100, true).unwrap();
    assert_eq!(g.commits.len(), 1);
    assert_eq!(g.commits[0].id, log::WIP_ID);
    assert!(g.commits[0].parents.is_empty());
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
    assert!(!d.signed);
    assert_eq!(d.author.name, "Test User");
    assert_eq!(d.files.len(), 1);
    let f = &d.files[0];
    assert_eq!((f.path.as_str(), f.status, f.additions, f.deletions), ("a.txt", "modified", 2, 1));

    let fd = diff::commit_file_diff(&r, oid, "a.txt", None, false).unwrap();
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
    let fd = diff::commit_file_diff(&r, git2::Oid::from_str(&id).unwrap(), "b.txt", Some("a.txt"), false).unwrap();
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
    assert_eq!(v1.message.as_deref(), Some("release one"));
    assert_eq!(all.iter().find(|r| r.name == "light").unwrap().message, None);

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

    ops::push(&t.path, false, &mut |_| {}).unwrap();
    let info = repo::info(&t.open()).unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (0, 0));

    t.commit("a.txt", "2\n", "second");
    let info = repo::info(&t.open()).unwrap();
    assert_eq!((info.ahead, info.behind), (1, 0));

    ops::push(&t.path, false, &mut |_| {}).unwrap();
    ops::fetch(&t.path, &mut |_| {}).unwrap();
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
    ops::push(&t.path, false, &mut |_| {}).unwrap();

    // Someone else pushes a commit.
    let other = t.path.parent().unwrap().join("other");
    git_in(t.path.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    isolate(&other);
    fs::write(other.join("b.txt"), "b\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "from other"]);
    git_in(&other, &["push", "-q"]);

    ops::fetch(&t.path, &mut |_| {}).unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().behind, 1);
    ops::pull(&t.path, "ff-only", &mut |_| {}).unwrap();
    assert!(t.path.join("b.txt").exists());
    assert!(ops::pull(&t.path, "sideways", &mut |_| {}).is_err());
}

#[test]
fn stage_unstage_and_discard_single_hunks() {
    let t = TestRepo::new();
    let base: String = (1..=20).map(|i| format!("line {i}\n")).collect();
    t.commit("f.txt", &base, "base");
    // Two changes far apart: two hunks.
    t.write("f.txt", &base.replace("line 2\n", "LINE TWO\n").replace("line 19\n", "LINE NINETEEN\n"));

    // Stage only the second hunk, the way the UI builds it.
    let patch = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n\
                 @@ -16,5 +16,5 @@\n line 16\n line 17\n line 18\n-line 19\n+LINE NINETEEN\n line 20\n";
    ops::apply_patch(&t.path, patch, true, false).unwrap();
    let staged = t.git(&["diff", "--cached"]);
    assert!(staged.contains("+LINE NINETEEN") && !staged.contains("LINE TWO"), "{staged}");
    let unstaged = t.git(&["diff"]);
    assert!(unstaged.contains("+LINE TWO") && !unstaged.contains("NINETEEN"), "{unstaged}");

    // Unstage it again: same patch, reversed, against the index.
    ops::apply_patch(&t.path, patch, true, true).unwrap();
    assert_eq!(t.git(&["diff", "--cached"]), "");

    // Discard the first hunk from the work tree.
    let first = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n\
                 @@ -1,5 +1,5 @@\n line 1\n-line 2\n+LINE TWO\n line 3\n line 4\n line 5\n";
    ops::apply_patch(&t.path, first, false, true).unwrap();
    let content = fs::read_to_string(t.path.join("f.txt")).unwrap();
    assert!(content.contains("line 2\n") && content.contains("LINE NINETEEN"));
}

#[test]
fn stage_selected_lines_only() {
    let t = TestRepo::new();
    t.commit("f.txt", "a\nb\nc\n", "base");
    t.write("f.txt", "a\nB\nC\nc\n");
    // Selected: "-b" and "+B"; "+C" left out.
    let patch = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";
    ops::apply_patch(&t.path, patch, true, false).unwrap();
    assert_eq!(t.git(&["show", ":f.txt"]), "a\nB\nc");
    assert_eq!(fs::read_to_string(t.path.join("f.txt")).unwrap(), "a\nB\nC\nc\n");
}

#[test]
fn stage_part_of_an_untracked_file() {
    let t = TestRepo::new();
    t.commit("keep.txt", "x\n", "base");
    t.write("new.txt", "one\ntwo\n");
    let fd = diff::workdir_file_diff(&t.open(), "new.txt", false).unwrap();
    assert_eq!(fd.hunks[0].old_start, 0);
    ops::intent_to_add(&t.path, "new.txt").unwrap();
    let patch = "diff --git a/new.txt b/new.txt\n--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+one\n";
    ops::apply_patch(&t.path, patch, true, false).unwrap();
    assert_eq!(t.git(&["show", ":new.txt"]), "one");
}

#[test]
fn missing_final_newline_is_marked_and_patchable() {
    let t = TestRepo::new();
    t.commit("f.txt", "a\nb", "no newline at end");
    t.write("f.txt", "a\nc");
    let fd = diff::workdir_file_diff(&t.open(), "f.txt", false).unwrap();
    let lines: Vec<(&str, &str, bool)> =
        fd.hunks[0].lines.iter().map(|l| (l.kind, l.text.as_str(), l.no_eol)).collect();
    assert_eq!(lines, vec![("ctx", "a", false), ("del", "b", true), ("add", "c", true)]);

    let patch = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
    ops::apply_patch(&t.path, patch, true, false).unwrap();
    assert_eq!(t.git(&["diff"]), "");
}

fn conflicted_repo() -> TestRepo {
    let t = TestRepo::new();
    t.commit("a.txt", "top\nbase\nbottom\n", "base");
    t.git(&["switch", "-q", "-c", "other"]);
    t.commit("a.txt", "top\ntheirs\nbottom\n", "other");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "top\nours\nbottom\n", "main");
    assert!(ops::merge(&t.path, "other").is_err());
    t
}

#[test]
fn conflict_file_has_all_three_sides() {
    let t = conflicted_repo();
    let c = status::conflict_file(&t.open(), "a.txt").unwrap();
    assert_eq!(c.ours.as_deref(), Some("top\nours\nbottom\n"));
    assert_eq!(c.theirs.as_deref(), Some("top\ntheirs\nbottom\n"));
    assert_eq!(c.base.as_deref(), Some("top\nbase\nbottom\n"));
    let w = c.working.unwrap();
    assert!(w.contains("<<<<<<< HEAD") && w.contains(">>>>>>> other"), "{w}");
    assert!(status::conflict_file(&t.open(), "nope.txt").is_err());
}

#[test]
fn resolve_conflict_with_content_then_continue() {
    let t = conflicted_repo();
    ops::resolve_with_content(&t.path, "a.txt", "top\nours\ntheirs\nbottom\n").unwrap();
    let st = status::status(&t.open()).unwrap();
    assert!(st.conflicted.is_empty());
    ops::sequencer(&t.path, "merge", "continue").unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%p"]).split(' ').count(), 2, "merge commit created");
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "top\nours\ntheirs\nbottom\n");
}

#[test]
fn resolve_conflict_by_side() {
    let t = conflicted_repo();
    ops::resolve_with_side(&t.path, "a.txt", "theirs", true).unwrap();
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "top\ntheirs\nbottom\n");
    assert!(status::status(&t.open()).unwrap().conflicted.is_empty());
}

#[test]
fn resolve_delete_modify_conflict_by_deleting() {
    let t = TestRepo::new();
    t.commit("a.txt", "x\n", "base");
    t.git(&["switch", "-q", "-c", "other"]);
    t.git(&["rm", "-q", "a.txt"]);
    t.git(&["commit", "-q", "-m", "delete"]);
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "changed\n", "modify");
    assert!(ops::merge(&t.path, "other").is_err());
    let c = status::conflict_file(&t.open(), "a.txt").unwrap();
    assert!(c.theirs.is_none() && c.ours.is_some());
    ops::resolve_with_side(&t.path, "a.txt", "theirs", false).unwrap();
    assert!(!t.path.join("a.txt").exists());
    assert!(status::status(&t.open()).unwrap().conflicted.is_empty());
}

#[test]
fn file_history_follows_renames_and_blame_attributes_lines() {
    use super::history;
    let t = TestRepo::new();
    t.commit("old.txt", "one\n", "create");
    t.commit("old.txt", "one\ntwo\n", "add two");
    t.git(&["mv", "old.txt", "new.txt"]);
    t.git(&["commit", "-q", "-m", "rename"]);
    t.commit("other.txt", "x\n", "unrelated");

    let h = history::file_history(&t.path, "new.txt", 100).unwrap();
    let got: Vec<(&str, &str)> = h.iter().map(|e| (e.summary.as_str(), e.path.as_str())).collect();
    assert_eq!(got, vec![("rename", "new.txt"), ("add two", "old.txt"), ("create", "old.txt")]);
    assert_eq!(h[0].author_name, "Test User");

    let b = history::blame(&t.path, "new.txt", None).unwrap();
    assert_eq!(b.lines.len(), 2);
    let first = &b.commits[&b.lines[0].id];
    let second = &b.commits[&b.lines[1].id];
    assert_eq!((first.summary.as_str(), second.summary.as_str()), ("create", "add two"));

    // Blame at an older commit, under the old name.
    let at = h[1].id.clone();
    let old = history::blame(&t.path, "old.txt", Some(&at)).unwrap();
    assert_eq!(old.lines.len(), 2);
    assert!(history::blame(&t.path, "new.txt", Some("--evil")).is_err());
}

#[test]
fn clone_reports_progress_and_init_creates_repo() {
    let t = TestRepo::new();
    for i in 0..3 {
        t.commit("f.txt", &format!("{i}\n"), &format!("c{i}"));
    }
    let bare = t.add_origin();
    ops::push(&t.path, false, &mut |_| {}).unwrap();

    let parent = t.path.parent().unwrap();
    let mut lines = Vec::new();
    let dest = ops::clone(parent, bare.to_str().unwrap(), "cloned", &mut |l| lines.push(l.to_owned())).unwrap();
    assert!(dest.join("f.txt").exists());
    assert!(lines.iter().any(|l| l.starts_with("Cloning into")), "{lines:?}");
    assert!(ops::clone(parent, bare.to_str().unwrap(), "cloned", &mut |_| {}).is_err(), "destination exists");
    assert!(ops::clone(parent, "--upload-pack=evil", "x", &mut |_| {}).is_err());

    let err = ops::clone(parent, "/nonexistent/repo.git", "nothing", &mut |_| {}).unwrap_err().to_string();
    assert!(err.contains("does not exist") || err.contains("not appear to be a git repository"), "{err}");

    let fresh = parent.join("fresh/nested");
    ops::init(&fresh).unwrap();
    assert!(repo::info(&repo::open(&fresh).unwrap()).unwrap().unborn);
}

fn rebase_fixture() -> (TestRepo, String, Vec<String>) {
    let t = TestRepo::new();
    let base = t.commit("base.txt", "base\n", "base");
    let ids = ["a", "b", "c", "d"]
        .iter()
        .map(|n| t.commit(&format!("{n}.txt"), &format!("{n}\n"), &format!("add {n}")))
        .collect();
    (t, base, ids)
}

fn subjects(t: &TestRepo, base: &str) -> Vec<String> {
    t.git(&["log", "--reverse", "--format=%s", &format!("{base}..HEAD")])
        .lines()
        .map(str::to_owned)
        .collect()
}

fn step(action: &str, id: &str, message: Option<&str>) -> rebase::RebaseStep {
    rebase::RebaseStep { action: action.into(), id: id.into(), message: message.map(Into::into) }
}

#[test]
fn rebase_commits_lists_range_oldest_first() {
    let (t, base, ids) = rebase_fixture();
    let list = rebase::commits(&t.open(), &base).unwrap();
    assert_eq!(list.iter().map(|c| c.id.clone()).collect::<Vec<_>>(), ids);
    assert_eq!(list[0].summary, "add a");
    // Not an ancestor of HEAD.
    t.git(&["switch", "-q", "-c", "side", &base]);
    let side = t.commit("s.txt", "s\n", "side");
    t.git(&["switch", "-q", "main"]);
    assert!(rebase::commits(&t.open(), &side).is_err());
}

#[test]
fn interactive_rebase_reorders_drops_rewords_and_squashes() {
    let (t, base, ids) = rebase_fixture();
    let plan = vec![
        step("pick", &ids[2], None),                           // c first
        step("reword", &ids[0], Some("A, reworded\n\nwith body")), // a renamed
        step("fixup", &ids[1], None),                          // b folded into a
        step("drop", &ids[3], None),                           // d gone
    ];
    rebase::run(&t.open(), &t.path, &base, &plan).unwrap();
    assert_eq!(subjects(&t, &base), vec!["add c", "A, reworded"]);
    assert_eq!(t.git(&["log", "-1", "--format=%b"]), "with body");
    assert!(t.path.join("b.txt").exists(), "fixup keeps b's change");
    assert!(!t.path.join("d.txt").exists(), "drop removes d's change");
    assert_eq!(repo::info(&t.open()).unwrap().state, "clean");
}

#[test]
fn interactive_rebase_squash_keeps_both_messages() {
    let (t, base, ids) = rebase_fixture();
    let plan = vec![
        step("pick", &ids[0], None),
        step("squash", &ids[1], None),
        step("pick", &ids[2], None),
        step("pick", &ids[3], None),
    ];
    rebase::run(&t.open(), &t.path, &base, &plan).unwrap();
    assert_eq!(subjects(&t, &base), vec!["add a", "add c", "add d"]);
    let msg = t.git(&["log", "-1", "--format=%B", "HEAD~2"]);
    assert!(msg.contains("add a") && msg.contains("add b"), "{msg}");
}

#[test]
fn interactive_rebase_rejects_stale_plan_and_stops_on_conflict() {
    let (t, base, ids) = rebase_fixture();
    // Plan that leaves a commit out.
    let partial = vec![step("pick", &ids[0], None)];
    assert!(rebase::run(&t.open(), &t.path, &base, &partial).is_err());

    // Two commits touching the same line, swapped: conflict.
    let c1 = t.commit("same.txt", "one\n", "one");
    let c2 = t.commit("same.txt", "two\n", "two");
    let mut plan: Vec<_> = ids.iter().map(|id| step("pick", id, None)).collect();
    plan.push(step("pick", &c2, None));
    plan.push(step("pick", &c1, None));
    assert!(rebase::run(&t.open(), &t.path, &base, &plan).is_err());
    assert_eq!(repo::info(&t.open()).unwrap().state, "rebase");
    ops::sequencer(&t.path, "rebase", "abort").unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().state, "clean");
    assert_eq!(t.git(&["rev-parse", "HEAD"]), c2);
}

#[test]
fn interactive_rebase_autostashes_local_changes() {
    let (t, base, ids) = rebase_fixture();
    t.write("base.txt", "dirty\n");
    let plan: Vec<_> = ids.iter().rev().map(|id| step("pick", id, None)).collect();
    rebase::run(&t.open(), &t.path, &base, &plan).unwrap();
    assert_eq!(subjects(&t, &base), vec!["add d", "add c", "add b", "add a"]);
    assert_eq!(fs::read_to_string(t.path.join("base.txt")).unwrap(), "dirty\n");
}

#[test]
fn undo_building_blocks_keep_reset_and_stash_store() {
    let t = TestRepo::new();
    let first = t.commit("a.txt", "1\n", "first");
    let second = t.commit("a.txt", "2\n", "second");
    // reset --keep moves HEAD back and forth when the tree is clean...
    ops::reset(&t.path, &first, "keep").unwrap();
    ops::reset(&t.path, &second, "keep").unwrap();
    assert_eq!(t.git(&["rev-parse", "HEAD"]), second);
    // ...but refuses to clobber a local edit of a file it would change.
    t.write("a.txt", "local edit\n");
    assert!(ops::reset(&t.path, &first, "keep").is_err());
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "local edit\n");

    // A dropped stash can be stored back.
    ops::stash_save(&t.path, Some("keep me"), false).unwrap();
    let st = refs::stashes(&mut t.open()).unwrap().remove(0);
    ops::stash_drop(&t.path, 0).unwrap();
    assert!(refs::stashes(&mut t.open()).unwrap().is_empty());
    ops::stash_store(&t.path, &st.id, &st.message).unwrap();
    let back = refs::stashes(&mut t.open()).unwrap();
    assert_eq!(back[0].id, st.id);
    assert_eq!(back[0].message, st.message);
}

#[test]
fn remote_management_and_targeted_push() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let bare = t.add_origin();
    let none: &mut dyn FnMut(&str) = &mut |_| {};

    let list = refs::remotes(&t.open()).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "origin");
    assert_eq!(list[0].url.as_deref(), bare.to_str());

    // Second remote: add, push a branch to it, rename, change URL, remove.
    let backup = t.path.parent().unwrap().join("backup.git");
    git_in(t.path.parent().unwrap(), &["init", "-q", "--bare", "backup.git"]);
    ops::add_remote(&t.path, "backup", backup.to_str().unwrap()).unwrap();
    assert!(ops::add_remote(&t.path, "backup", "x").is_err(), "duplicate");
    ops::create_branch(&t.path, "topic", None, false).unwrap();
    ops::push_branch(&t.path, "backup", "topic", false, none).unwrap();
    assert_eq!(git_in(&backup, &["branch", "--list", "topic"]).trim(), "topic");
    let topic = refs::list(&t.open()).unwrap().into_iter().find(|r| r.name == "topic").unwrap();
    assert_eq!(topic.upstream.as_deref(), Some("backup/topic"));

    ops::set_upstream(&t.path, "topic", None).unwrap();
    let topic = refs::list(&t.open()).unwrap().into_iter().find(|r| r.name == "topic").unwrap();
    assert_eq!(topic.upstream, None);
    ops::set_upstream(&t.path, "topic", Some("backup/topic")).unwrap();

    ops::fetch_remote(&t.path, "backup", none).unwrap();
    ops::rename_remote(&t.path, "backup", "mirror").unwrap();
    ops::set_remote_url(&t.path, "mirror", "/somewhere/else.git").unwrap();
    let list = refs::remotes(&t.open()).unwrap();
    let mirror = list.iter().find(|r| r.name == "mirror").unwrap();
    assert_eq!(mirror.url.as_deref(), Some("/somewhere/else.git"));
    ops::remove_remote(&t.path, "mirror").unwrap();
    assert_eq!(refs::remotes(&t.open()).unwrap().len(), 1);

    // Tags: push and delete on the remote.
    ops::create_tag(&t.path, "v1", "HEAD", None).unwrap();
    ops::push_tag(&t.path, "origin", "v1", false, none).unwrap();
    assert_eq!(git_in(&bare, &["tag"]).trim(), "v1");
    ops::push_tag(&t.path, "origin", "v1", true, none).unwrap();
    assert_eq!(git_in(&bare, &["tag"]).trim(), "");
}

#[test]
fn compare_two_commits() {
    let t = TestRepo::new();
    let a = t.commit("a.txt", "1\n", "a");
    t.commit("b.txt", "b\n", "b");
    t.git(&["mv", "a.txt", "moved.txt"]);
    t.git(&["commit", "-q", "-m", "move"]);
    let c = t.commit("moved.txt", "1\n2\n", "edit");
    let r = t.open();
    let (a, c) = (git2::Oid::from_str(&a).unwrap(), git2::Oid::from_str(&c).unwrap());
    let mut files: Vec<(String, &str)> = diff::compare(&r, a, c).unwrap().into_iter().map(|f| (f.path, f.status)).collect();
    files.sort();
    assert_eq!(files, vec![("b.txt".into(), "added"), ("moved.txt".into(), "renamed")]);
    let fd = diff::compare_file_diff(&r, a, c, "moved.txt", Some("a.txt"), false).unwrap();
    assert_eq!(fd.old_path.as_deref(), Some("a.txt"));
    assert!(fd.hunks[0].lines.iter().any(|l| l.kind == "add" && l.text == "2"));
    // Reversed direction swaps additions and deletions.
    let back = diff::compare_file_diff(&r, c, a, "b.txt", None, false).unwrap();
    assert_eq!(back.status, "deleted");
}

#[test]
fn ignore_appends_once_and_hides_files() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.write("build/out.o", "bin");
    t.write("debug.log", "log");
    fs::write(t.path.join(".gitignore"), "target/").unwrap(); // no trailing newline
    ops::ignore(&t.path, "*.log").unwrap();
    ops::ignore(&t.path, "build/").unwrap();
    ops::ignore(&t.path, "*.log").unwrap();
    assert_eq!(fs::read_to_string(t.path.join(".gitignore")).unwrap(), "target/\n*.log\nbuild/\n");
    let st = status::status(&t.open()).unwrap();
    let paths: Vec<&str> = st.unstaged.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec![".gitignore"]);
    assert!(ops::ignore(&t.path, "a\nb").is_err());
    assert!(ops::ignore(&t.path, "x\u{1b}[31m").is_err());
}

#[test]
fn never_writes_through_committed_symlinks() {
    let t = TestRepo::new();
    let outside = t.path.parent().unwrap().join("bashrc");
    fs::write(&outside, "original\n").unwrap();
    std::os::unix::fs::symlink(&outside, t.path.join(".gitignore")).unwrap();
    assert!(ops::ignore(&t.path, "*.log").is_err());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "original\n");
}

#[test]
fn paths_are_literal_not_globs() {
    let t = TestRepo::new();
    t.write("a*b.txt", "1\n");
    t.write("axb.txt", "1\n");
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "base"]);
    t.write("a*b.txt", "changed\n");
    t.write("axb.txt", "changed\n");
    t.write("notes[1].txt", "u\n");
    t.write("notes1.txt", "keep me\n");
    ops::discard(&t.path, &["a*b.txt".into()], &["notes[1].txt".into()]).unwrap();
    assert_eq!(fs::read_to_string(t.path.join("a*b.txt")).unwrap(), "1\n");
    assert_eq!(fs::read_to_string(t.path.join("axb.txt")).unwrap(), "changed\n", "glob must not match");
    assert!(!t.path.join("notes[1].txt").exists());
    assert!(t.path.join("notes1.txt").exists(), "glob must not match");
    ops::stage(&t.path, &["a*b.txt".into(), "axb.txt".into()]).unwrap();
    ops::unstage_all(&t.path).unwrap();
    assert!(status::status(&t.open()).unwrap().staged.is_empty());
}

#[test]
fn conflict_paths_must_stay_inside_the_repo() {
    let t = conflicted_repo();
    let outside = t.path.parent().unwrap().join("outside.txt");
    assert!(ops::resolve_with_content(&t.path, outside.to_str().unwrap(), "x").is_err());
    assert!(ops::resolve_with_content(&t.path, "../outside.txt", "x").is_err());
    assert!(!outside.exists());
    assert!(ops::resolve_with_side(&t.path, "/etc/hostname", "ours", true).is_err());
}

#[test]
fn rebase_refuses_while_another_is_stopped() {
    let (t, base, ids) = rebase_fixture();
    let c1 = t.commit("same.txt", "one\n", "one");
    let c2 = t.commit("same.txt", "two\n", "two");
    let mut plan: Vec<_> = ids.iter().map(|id| step("pick", id, None)).collect();
    plan.push(step("pick", &c2, None));
    plan.push(step("pick", &c1, None));
    assert!(rebase::run(&t.open(), &t.path, &base, &plan).is_err());
    let err = rebase::run(&t.open(), &t.path, &base, &plan).unwrap_err().to_string();
    assert!(err.contains("in progress"), "{err}");
    ops::sequencer(&t.path, "rebase", "abort").unwrap();
}

#[test]
fn reword_then_squash_keeps_the_new_message() {
    let (t, base, ids) = rebase_fixture();
    let plan = vec![
        step("reword", &ids[0], Some("Renamed A")),
        step("squash", &ids[1], None),
        step("pick", &ids[2], None),
        step("pick", &ids[3], None),
    ];
    rebase::run(&t.open(), &t.path, &base, &plan).unwrap();
    let msg = t.git(&["log", "-1", "--format=%B", "HEAD~2"]);
    assert!(msg.contains("Renamed A") && msg.contains("add b") && !msg.contains("add a"), "{msg}");
}

#[test]
fn non_utf8_diffs_are_flagged() {
    let t = TestRepo::new();
    t.commit("latin1.txt", "plain\n", "base");
    fs::write(t.path.join("latin1.txt"), b"plain\ncaf\xe9\n").unwrap();
    let fd = diff::workdir_file_diff(&t.open(), "latin1.txt", false).unwrap();
    assert!(fd.lossy);
    t.write("utf8.txt", "café\n");
    assert!(!diff::workdir_file_diff(&t.open(), "utf8.txt", false).unwrap().lossy);
}

#[test]
fn stashes_appear_in_the_graph_above_their_base() {
    let t = TestRepo::new();
    let first = t.commit("a.txt", "1\n", "first");
    t.write("a.txt", "s1\n");
    ops::stash_save(&t.path, Some("older"), false).unwrap();
    t.write("a.txt", "s2\n");
    ops::stash_save(&t.path, Some("newer"), false).unwrap();
    t.commit("b.txt", "b\n", "second");

    let g = log::graph(&t.open(), 100, false).unwrap();
    let rows: Vec<(&str, &str)> = g.commits.iter().map(|c| (c.kind, c.summary.as_str())).collect();
    assert_eq!(rows.len(), 4);
    assert_eq!(rows[0], ("commit", "second"));
    assert_eq!(rows[1].0, "stash");
    assert!(rows[1].1.contains("newer"), "{rows:?}");
    assert!(rows[2].1.contains("older"), "{rows:?}");
    assert_eq!(rows[3], ("commit", "first"));
    // Only the base as parent: index/untracked commits stay hidden.
    assert_eq!(g.commits[1].parents, vec![first.clone()]);
    assert_eq!(g.max_lanes, 2, "both stashes reuse the second lane");
}

#[test]
fn graph_can_hide_or_solo_branches() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "base");
    t.git(&["switch", "-q", "-c", "side"]);
    t.commit("s.txt", "s\n", "side work");
    t.git(&["switch", "-q", "-c", "other", "main"]);
    t.commit("o.txt", "o\n", "other work");
    t.git(&["switch", "-q", "main"]);
    let r = t.open();
    let summaries = |f: log::GraphFilter| -> Vec<String> {
        let mut v: Vec<String> = log::graph_filtered(&r, 100, false, &f).unwrap().commits.into_iter().map(|c| c.summary).collect();
        v.sort();
        v
    };
    assert_eq!(summaries(log::GraphFilter::default()), vec!["base", "other work", "side work"]);
    let hidden = log::GraphFilter { hidden: vec!["refs/heads/side".into()], solo: vec![] };
    assert_eq!(summaries(hidden), vec!["base", "other work"]);
    let solo = log::GraphFilter { hidden: vec![], solo: vec!["refs/heads/side".into()] };
    // HEAD (main) is always walked.
    assert_eq!(summaries(solo), vec!["base", "side work"]);
}

#[test]
fn worktrees_add_list_open_remove() {
    use super::worktree;
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    ops::create_branch(&t.path, "existing", None, false).unwrap();
    let parent = t.path.parent().unwrap();
    let wt1 = parent.join("wt-existing");
    let wt2 = parent.join("wt-new");
    worktree::add(&t.path, wt1.to_str().unwrap(), "existing", false, None).unwrap();
    worktree::add(&t.path, wt2.to_str().unwrap(), "fresh", true, Some("HEAD")).unwrap();

    let list = worktree::list(&t.path).unwrap();
    assert_eq!(list.len(), 3);
    assert!(list[0].main);
    let branches: Vec<Option<&str>> = list.iter().map(|w| w.branch.as_deref()).collect();
    assert_eq!(branches, vec![Some("main"), Some("existing"), Some("fresh")]);
    // A linked work tree opens like any repository.
    let info = repo::info(&repo::open(&wt2).unwrap()).unwrap();
    assert_eq!(info.head_branch.as_deref(), Some("fresh"));
    // Its branch can't be checked out in the main tree.
    assert!(ops::checkout_branch(&t.path, "existing").is_err());

    fs::write(wt1.join(".gitignore"), ".env\n").unwrap();
    fs::write(wt1.join(".env"), "SECRET=1").unwrap();
    assert_eq!(worktree::ignored(&wt1).unwrap(), vec![".env"]);
    fs::write(wt1.join("dirty.txt"), "x").unwrap();
    assert!(worktree::remove(&t.path, wt1.to_str().unwrap(), false).is_err(), "dirty tree needs force");
    worktree::remove(&t.path, wt1.to_str().unwrap(), true).unwrap();
    fs::remove_dir_all(&wt2).unwrap();
    assert!(worktree::list(&t.path).unwrap()[1].prunable);
    worktree::prune(&t.path).unwrap();
    assert_eq!(worktree::list(&t.path).unwrap().len(), 1);
}

#[test]
fn submodules_are_listed() {
    let lib = TestRepo::new();
    lib.commit("lib.txt", "lib\n", "lib");
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.path.to_str().unwrap(), "vendor/lib"]);
    t.git(&["commit", "-q", "-m", "add submodule"]);

    let subs = refs::submodules(&t.open()).unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].path, "vendor/lib");
    assert!(subs[0].initialized && !subs[0].modified);

    // A fresh clone has the submodule registered but not checked out.
    let parent = t.path.parent().unwrap();
    git_in(parent, &["clone", "-q", t.path.to_str().unwrap(), "clone"]);
    let clone = parent.join("clone");
    isolate(&clone);
    assert!(!refs::submodules(&repo::open(&clone).unwrap()).unwrap()[0].initialized);
    // `submodule_update` itself isn't exercised: git refuses file://
    // submodule clones by default and the nested clone ignores repo-local
    // config, so it would need a change to the global git config.
}

#[test]
fn reflog_remembers_commits_lost_by_reset() {
    use super::history;
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let lost = t.commit("a.txt", "2\n", "soon lost");
    t.git(&["reset", "-q", "--hard", "HEAD~1"]);
    let log = history::reflog(&t.open(), 50).unwrap();
    assert!(log[0].message.starts_with("reset:"), "{:?}", log[0].message);
    let entry = log.iter().find(|e| e.id == lost).expect("lost commit in reflog");
    assert_eq!(entry.summary.as_deref(), Some("soon lost"));
    assert_eq!(history::reflog(&t.open(), 1).unwrap().len(), 1);
}

#[test]
fn search_history_by_file_and_code() {
    use super::history;
    let t = TestRepo::new();
    let a = t.commit("src/Parser.rs", "fn parse() {}\n", "add parser");
    let b = t.commit("README.md", "docs\n", "docs");
    t.git(&["switch", "-q", "-c", "side"]);
    let c = t.commit("src/parser_util.rs", "fn tokenize() {}\n", "util on side");
    t.git(&["switch", "-q", "main"]);

    // Path substring, case-insensitive, across all branches.
    assert_eq!(history::search(&t.path, "files", "parser", 100).unwrap(), vec![c.clone(), a.clone()]);
    assert_eq!(history::search(&t.path, "files", "readme", 100).unwrap(), vec![b]);
    // Pickaxe: commits adding/removing the text.
    assert_eq!(history::search(&t.path, "code", "tokenize", 100).unwrap(), vec![c]);
    assert!(history::search(&t.path, "files", "*", 100).unwrap().is_empty(), "glob chars are literal");
    assert!(history::search(&t.path, "code", "  ", 100).unwrap().is_empty());
    assert!(history::search(&t.path, "nope", "x", 100).is_err());
}

#[test]
fn reword_head_keeps_staged_changes_and_whitespace_can_be_ignored() {
    let t = TestRepo::new();
    t.commit("a.txt", "fn main() {\n    x();\n}\n", "frist");
    t.commit("a.txt", "fn main() {\n        x();\n}\nmore\n", "reindent");
    t.write("staged.txt", "s\n");
    ops::stage(&t.path, &["staged.txt".into()]).unwrap();
    ops::reword_head(&t.path, "Reindent and add more").unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%s"]), "Reindent and add more");
    assert_eq!(t.git(&["show", "--stat", "--format=", "HEAD"]).contains("staged.txt"), false);
    assert_eq!(status::status(&t.open()).unwrap().staged.len(), 1, "still staged, not committed");

    let r = t.open();
    let head = git2::Oid::from_str(&t.git(&["rev-parse", "HEAD"])).unwrap();
    let all = diff::commit_file_diff(&r, head, "a.txt", None, false).unwrap();
    let ws = diff::commit_file_diff(&r, head, "a.txt", None, true).unwrap();
    let changed = |d: &diff::FileDiff| d.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind != "ctx").count();
    assert_eq!(changed(&all), 3, "indent change + addition");
    assert_eq!(changed(&ws), 1, "only the addition");
}

#[test]
fn file_contents_for_image_diffs() {
    let t = TestRepo::new();
    fs::write(t.path.join("img.png"), [0x89, b'P', b'N', b'G', 0, 1]).unwrap();
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "add image"]);
    let first = t.git(&["rev-parse", "HEAD"]);
    fs::write(t.path.join("img.png"), [0x89, b'P', b'N', b'G', 9, 9]).unwrap();
    let r = t.open();
    assert_eq!(diff::file_base64(&r, Some(&first), "img.png").unwrap().as_deref(), Some("iVBORwAB"));
    assert_eq!(diff::file_base64(&r, None, "img.png").unwrap().as_deref(), Some("iVBORwkJ"));
    assert_eq!(diff::file_base64(&r, Some(":"), "img.png").unwrap().as_deref(), Some("iVBORwAB"));
    assert_eq!(diff::file_base64(&r, Some(&format!("{first}^")), "img.png").unwrap(), None, "root commit has no parent");
    assert_eq!(diff::file_base64(&r, Some(&first), "missing.png").unwrap(), None);
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
    let stash_ids: Vec<String> =
        refs::stashes(&mut repo::open(Path::new(&repo_path)).unwrap()).unwrap().into_iter().map(|s| s.id).collect();
    let ids = g.commits.iter().filter(|c| c.id != log::WIP_ID).take(80).map(|c| c.id.clone()).chain(stash_ids);
    for id in ids {
        let oid = git2::Oid::from_str(&id).unwrap();
        let d = diff::commit_details(&r, oid).unwrap();
        for f in &d.files {
            let fd = diff::commit_file_diff(&r, oid, &f.path, f.old_path.as_deref(), false).unwrap();
            commit_diffs.insert(format!("{}:{}", id, f.path), serde_json::to_value(fd).unwrap());
        }
        details.insert(id.clone(), serde_json::to_value(d).unwrap());
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

    // History and working-tree blame for every file in HEAD.
    let mut histories = Map::new();
    let mut blames = Map::new();
    let head_tree = r.head().unwrap().peel_to_tree().unwrap();
    head_tree
        .walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                let path = format!("{dir}{}", entry.name().unwrap_or(""));
                let wd = Path::new(&repo_path);
                if let Ok(h) = super::history::file_history(wd, &path, 500) {
                    histories.insert(path.clone(), serde_json::to_value(h).unwrap());
                }
                if let Ok(b) = super::history::blame(wd, &path, None) {
                    blames.insert(path, serde_json::to_value(b).unwrap());
                }
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();

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
        "remotes": refs::remotes(&r).unwrap(),
        "worktrees": super::worktree::list(Path::new(&repo_path)).unwrap(),
        "reflog": super::history::reflog(&r, 500).unwrap(),
        "histories": histories,
        "blames": blames,
        "rebaseCommits": super::rebase::commits(&r, &r.revparse_single("HEAD~2").unwrap().id().to_string()).unwrap(),
    });
    fs::write(&out, serde_json::to_string(&fixture).unwrap()).unwrap();
}

/// Timing for the graph on a big repository:
/// `GITBRIX_BENCH_REPO=<path> cargo test --release bench_graph -- --ignored --nocapture`
#[test]
#[ignore = "benchmark; needs GITBRIX_BENCH_REPO"]
fn bench_graph() {
    use std::time::Instant;
    let path = std::env::var("GITBRIX_BENCH_REPO").expect("GITBRIX_BENCH_REPO");
    let r = repo::open(Path::new(&path)).unwrap();
    for limit in [2_000, 20_000, 100_000] {
        let t0 = Instant::now();
        let g = log::graph(&r, limit, false).unwrap();
        let walk = t0.elapsed();
        let json = serde_json::to_string(&g).unwrap();
        println!(
            "limit {limit:>6}: {} commits, {} refs, {} lanes, graph {:?}, json {:?} {} KB",
            g.commits.len(),
            g.refs.len(),
            g.max_lanes,
            walk,
            t0.elapsed() - walk,
            json.len() / 1024
        );
    }
    let t0 = Instant::now();
    let st = status::status(&r).unwrap();
    println!("status: {:?} ({} entries)", t0.elapsed(), st.unstaged.len());
}
