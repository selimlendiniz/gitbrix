//! End-to-end tests against throwaway repositories built with the real
//! `git` CLI.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

use super::{diff, lfs, log, net, ops, patch, rebase, refs, repo, status, workspace};

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

    net::push(&t.path, false, &mut |_| {}).unwrap();
    let info = repo::info(&t.open()).unwrap();
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));
    assert_eq!((info.ahead, info.behind), (0, 0));

    t.commit("a.txt", "2\n", "second");
    let info = repo::info(&t.open()).unwrap();
    assert_eq!((info.ahead, info.behind), (1, 0));

    net::push(&t.path, false, &mut |_| {}).unwrap();
    net::fetch(&t.path, &mut |_| {}).unwrap();
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
    net::push(&t.path, false, &mut |_| {}).unwrap();

    // Someone else pushes a commit.
    let other = t.path.parent().unwrap().join("other");
    git_in(t.path.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    isolate(&other);
    fs::write(other.join("b.txt"), "b\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "from other"]);
    git_in(&other, &["push", "-q"]);

    net::fetch(&t.path, &mut |_| {}).unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().behind, 1);
    net::pull(&t.path, "ff-only", &mut |_| {}).unwrap();
    assert!(t.path.join("b.txt").exists());
    assert!(net::pull(&t.path, "sideways", &mut |_| {}).is_err());
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
    // Merged again with the base in each conflict, for the merge editor.
    assert_eq!(
        c.merged.as_deref(),
        Some("top\n<<<<<<< ours\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> theirs\nbottom\n")
    );
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
    net::push(&t.path, false, &mut |_| {}).unwrap();

    let parent = t.path.parent().unwrap();
    let mut lines = Vec::new();
    let dest = net::clone(parent, bare.to_str().unwrap(), "cloned", &mut |l| lines.push(l.to_owned())).unwrap();
    assert!(dest.join("f.txt").exists());
    assert!(lines.iter().any(|l| l.starts_with("Cloning into")), "{lines:?}");
    assert!(net::clone(parent, bare.to_str().unwrap(), "cloned", &mut |_| {}).is_err(), "destination exists");
    assert!(net::clone(parent, "--upload-pack=evil", "x", &mut |_| {}).is_err());

    let err = net::clone(parent, "/nonexistent/repo.git", "nothing", &mut |_| {}).unwrap_err().to_string();
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
    rebase::run(&t.open(), &base, &plan).unwrap();
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
    rebase::run(&t.open(), &base, &plan).unwrap();
    assert_eq!(subjects(&t, &base), vec!["add a", "add c", "add d"]);
    let msg = t.git(&["log", "-1", "--format=%B", "HEAD~2"]);
    assert!(msg.contains("add a") && msg.contains("add b"), "{msg}");
}

#[test]
fn interactive_rebase_rejects_stale_plan_and_stops_on_conflict() {
    let (t, base, ids) = rebase_fixture();
    // Plan that leaves a commit out.
    let partial = vec![step("pick", &ids[0], None)];
    assert!(rebase::run(&t.open(), &base, &partial).is_err());

    // Two commits touching the same line, swapped: conflict.
    let c1 = t.commit("same.txt", "one\n", "one");
    let c2 = t.commit("same.txt", "two\n", "two");
    let mut plan: Vec<_> = ids.iter().map(|id| step("pick", id, None)).collect();
    plan.push(step("pick", &c2, None));
    plan.push(step("pick", &c1, None));
    assert!(rebase::run(&t.open(), &base, &plan).is_err());
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
    rebase::run(&t.open(), &base, &plan).unwrap();
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
    net::push_branch(&t.path, "backup", "topic", false, none).unwrap();
    assert_eq!(git_in(&backup, &["branch", "--list", "topic"]).trim(), "topic");
    let topic = refs::list(&t.open()).unwrap().into_iter().find(|r| r.name == "topic").unwrap();
    assert_eq!(topic.upstream.as_deref(), Some("backup/topic"));

    ops::set_upstream(&t.path, "topic", None).unwrap();
    let topic = refs::list(&t.open()).unwrap().into_iter().find(|r| r.name == "topic").unwrap();
    assert_eq!(topic.upstream, None);
    ops::set_upstream(&t.path, "topic", Some("backup/topic")).unwrap();

    net::fetch_remote(&t.path, "backup", none).unwrap();
    ops::rename_remote(&t.path, "backup", "mirror").unwrap();
    ops::set_remote_url(&t.path, "mirror", "/somewhere/else.git").unwrap();
    let list = refs::remotes(&t.open()).unwrap();
    let mirror = list.iter().find(|r| r.name == "mirror").unwrap();
    assert_eq!(mirror.url.as_deref(), Some("/somewhere/else.git"));
    ops::remove_remote(&t.path, "mirror").unwrap();
    assert_eq!(refs::remotes(&t.open()).unwrap().len(), 1);

    // Tags: push and delete on the remote.
    ops::create_tag(&t.path, "v1", "HEAD", None).unwrap();
    net::push_tag(&t.path, "origin", "v1", false, none).unwrap();
    assert_eq!(git_in(&bare, &["tag"]).trim(), "v1");
    net::push_tag(&t.path, "origin", "v1", true, none).unwrap();
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
    assert!(rebase::run(&t.open(), &base, &plan).is_err());
    let err = rebase::run(&t.open(), &base, &plan).unwrap_err().to_string();
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
    rebase::run(&t.open(), &base, &plan).unwrap();
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

// --- libgit2 replacements for what the git CLI used to do -----------------

/// A hooks directory for `t` with one executable hook.
fn hook(t: &TestRepo, name: &str, script: &str) {
    use std::os::unix::fs::PermissionsExt;
    let dir = t.path.parent().unwrap().join("hooks");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    fs::write(&file, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    t.git(&["config", "core.hooksPath", dir.to_str().unwrap()]);
}

#[test]
fn commit_runs_hooks() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    hook(&t, "pre-commit", "echo 'no tabs allowed' >&2; exit 1");
    t.write("a.txt", "2\n");
    ops::stage(&t.path, &["a.txt".into()]).unwrap();
    let err = ops::commit(&t.path, "blocked", false).unwrap_err().to_string();
    assert!(err.contains("pre-commit") && err.contains("no tabs allowed"), "{err}");
    assert_eq!(t.git(&["log", "-1", "--format=%s"]), "first");

    fs::remove_file(t.path.parent().unwrap().join("hooks/pre-commit")).unwrap();
    hook(&t, "commit-msg", r#"printf '\nTicket: GB-1\n' >> "$1""#);
    hook(&t, "post-commit", "touch \"$GIT_INDEX_FILE.post\"");
    ops::commit(&t.path, "allowed", false).unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%B"]), "allowed\n\nTicket: GB-1");
    assert!(t.path.join(".git/index.post").exists(), "post-commit ran");
}

#[test]
fn commits_are_signed_when_configured() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let key = t.path.parent().unwrap().join("signing-key");
    let out = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"])
        .arg(&key)
        .output()
        .expect("ssh-keygen runs");
    assert!(out.status.success());
    t.git(&["config", "gpg.format", "ssh"]);
    t.git(&["config", "user.signingkey", key.to_str().unwrap()]);
    t.git(&["config", "commit.gpgsign", "true"]);
    t.write("a.txt", "2\n");
    ops::stage_all(&t.path).unwrap();
    ops::commit(&t.path, "signed", false).unwrap();
    let r = t.open();
    let head = r.head().unwrap().target().unwrap();
    let (sig, _) = r.extract_signature(&head, None).unwrap();
    assert!(sig.as_str().unwrap().contains("BEGIN SSH SIGNATURE"));
    // git itself accepts the signature.
    let allowed = t.path.parent().unwrap().join("allowed");
    let public = fs::read_to_string(key.with_extension("pub")).unwrap();
    fs::write(&allowed, format!("test@example.com {public}")).unwrap();
    t.git(&["config", "gpg.ssh.allowedSignersFile", allowed.to_str().unwrap()]);
    t.git(&["verify-commit", "HEAD"]);
}

#[test]
fn rebase_stops_on_conflict_then_continues_or_skips() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit("a.txt", "feature\n", "feature edit");
    t.commit("b.txt", "b\n", "feature b");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "main\n", "main edit");
    t.git(&["switch", "-q", "feature"]);

    let err = ops::sequencer(&t.path, "rebase", "continue");
    assert!(err.is_err(), "nothing to continue yet");
    assert!(rebase::onto(&t.open(), "main").is_err(), "conflict stops the rebase");
    assert_eq!(repo::info(&t.open()).unwrap().state, "rebase");
    assert!(ops::sequencer(&t.path, "rebase", "continue").is_err(), "conflicts unresolved");
    ops::resolve_with_content(&t.path, "a.txt", "main+feature\n").unwrap();
    ops::sequencer(&t.path, "rebase", "continue").unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().state, "clean");
    assert_eq!(t.git(&["log", "--format=%s", "-3"]), "feature b\nfeature edit\nmain edit");
    assert_eq!(t.git(&["rev-parse", "--abbrev-ref", "HEAD"]), "feature");

    // Again, but skip the conflicting commit.
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    t.commit("a.txt", "feature\n", "feature edit");
    t.commit("b.txt", "b\n", "feature b");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "main\n", "main edit");
    t.git(&["switch", "-q", "feature"]);
    assert!(rebase::onto(&t.open(), "main").is_err());
    ops::sequencer(&t.path, "rebase", "skip").unwrap();
    assert_eq!(t.git(&["log", "--format=%s", "-2"]), "feature b\nmain edit");
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "main\n");
}

#[test]
fn cherry_pick_conflict_keeps_original_author() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "other"]);
    t.git(&["-c", "user.name=Grace", "-c", "user.email=grace@x", "commit", "-q", "--allow-empty", "-m", "noop"]);
    t.write("a.txt", "theirs\n");
    t.git(&["add", "-A"]);
    t.git(&["-c", "user.name=Grace", "-c", "user.email=grace@x", "commit", "-q", "-m", "grace's change"]);
    let pick = t.git(&["rev-parse", "HEAD"]);
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "ours\n", "ours");

    assert!(ops::cherry_pick(&t.path, &pick).is_err());
    assert_eq!(repo::info(&t.open()).unwrap().state, "cherry-pick");
    ops::resolve_with_side(&t.path, "a.txt", "theirs", true).unwrap();
    ops::sequencer(&t.path, "cherry-pick", "continue").unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%an|%s"]), "Grace|grace's change");
    assert_eq!(repo::info(&t.open()).unwrap().state, "clean");
}

#[test]
fn aborting_a_merge_keeps_unrelated_local_changes() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.commit("notes.txt", "notes\n", "notes");
    t.git(&["switch", "-q", "-c", "other"]);
    t.commit("a.txt", "other\n", "other");
    t.commit("new.txt", "new\n", "adds a file");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "main\n", "main");
    t.write("notes.txt", "my local notes\n");

    assert!(ops::merge(&t.path, "other").is_err());
    assert!(t.path.join("new.txt").exists());
    ops::sequencer(&t.path, "merge", "abort").unwrap();
    assert_eq!(fs::read_to_string(t.path.join("a.txt")).unwrap(), "main\n");
    assert!(!t.path.join("new.txt").exists(), "files the merge added are gone");
    assert_eq!(fs::read_to_string(t.path.join("notes.txt")).unwrap(), "my local notes\n");
    assert_eq!(t.git(&["status", "--porcelain"]), "M notes.txt");
}

#[test]
fn force_push_is_with_lease() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let bare = t.add_origin();
    net::push(&t.path, false, &mut |_| {}).unwrap();

    // Someone else pushes; we rewrite our commit without fetching.
    let other = t.path.parent().unwrap().join("other");
    git_in(t.path.parent().unwrap(), &["clone", "-q", bare.to_str().unwrap(), "other"]);
    isolate(&other);
    fs::write(other.join("b.txt"), "b\n").unwrap();
    git_in(&other, &["add", "-A"]);
    git_in(&other, &["commit", "-q", "-m", "theirs"]);
    git_in(&other, &["push", "-q"]);
    t.write("a.txt", "rewritten\n");
    ops::stage_all(&t.path).unwrap();
    ops::commit(&t.path, "first, rewritten", true).unwrap();

    let err = net::push(&t.path, false, &mut |_| {}).unwrap_err().to_string();
    assert!(err.contains("Pull first"), "{err}");
    let err = net::push(&t.path, true, &mut |_| {}).unwrap_err().to_string();
    assert!(err.contains("since you last fetched"), "{err}");
    // After a fetch we have seen their work and may overwrite it.
    net::fetch(&t.path, &mut |_| {}).unwrap();
    net::push(&t.path, true, &mut |_| {}).unwrap();
    assert_eq!(git_in(&bare, &["log", "-1", "--format=%s", "main"]), "first, rewritten");
}

#[test]
fn deleting_remote_branches_and_pushing_tags() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let bare = t.add_origin();
    ops::create_branch(&t.path, "topic", None, false).unwrap();
    net::push_branch(&t.path, "origin", "topic", false, &mut |_| {}).unwrap();
    assert!(t.open().find_reference("refs/remotes/origin/topic").is_ok());
    net::delete_remote_branch(&t.path, "origin", "topic").unwrap();
    assert!(t.open().find_reference("refs/remotes/origin/topic").is_err());
    assert_eq!(git_in(&bare, &["branch", "--list", "topic"]), "");

    ops::create_tag(&t.path, "v1", "HEAD", Some("Release one")).unwrap();
    net::push_tag(&t.path, "origin", "v1", false, &mut |_| {}).unwrap();
    assert_eq!(git_in(&bare, &["tag"]), "v1");
    net::push_tag(&t.path, "origin", "v1", true, &mut |_| {}).unwrap();
    assert_eq!(git_in(&bare, &["tag"]), "");
}

#[test]
fn ssh_remotes_go_through_the_ssh_command() {
    use std::os::unix::fs::PermissionsExt;
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    let bare = t.path.parent().unwrap().join("origin.git");
    git_in(t.path.parent().unwrap(), &["init", "-q", "--bare", "-b", "main", "origin.git"]);
    // A stand-in for ssh: check the host, run the remote command locally.
    let fake = t.path.parent().unwrap().join("fake-ssh");
    fs::write(
        &fake,
        "#!/bin/sh\n[ \"$1\" = git@example.test ] || { echo \"bad host $1\" >&2; exit 255; }\neval \"exec git ${2#git-}\"\n",
    )
    .unwrap();
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
    t.git(&["config", "core.sshCommand", fake.to_str().unwrap()]);
    t.git(&["remote", "add", "origin", &format!("git@example.test:{}", bare.display())]);

    net::push(&t.path, false, &mut |_| {}).unwrap();
    assert_eq!(git_in(&bare, &["log", "-1", "--format=%s", "main"]), "first");
    net::fetch(&t.path, &mut |_| {}).unwrap();
    assert_eq!(repo::info(&t.open()).unwrap().upstream.as_deref(), Some("origin/main"));

    t.git(&["remote", "set-url", "origin", &format!("ssh://nobody@example.test{}", bare.display())]);
    let err = net::fetch(&t.path, &mut |_| {}).unwrap_err().to_string();
    assert!(err.contains("bad host nobody@example.test"), "{err}");
}

#[test]
fn submodule_update_checks_out_submodules() {
    let lib = TestRepo::new();
    lib.commit("lib.txt", "lib\n", "lib");
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.git(&["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.path.to_str().unwrap(), "vendor/lib"]);
    t.git(&["commit", "-q", "-m", "add submodule"]);
    let parent = t.path.parent().unwrap();
    let clone = net::clone(parent, t.path.to_str().unwrap(), "clone", &mut |_| {}).unwrap();
    assert!(!clone.join("vendor/lib/lib.txt").exists());
    net::submodule_update(&clone, &mut |_| {}).unwrap();
    assert!(clone.join("vendor/lib/lib.txt").exists());
    assert!(refs::submodules(&repo::open(&clone).unwrap()).unwrap()[0].initialized);
}

#[test]
fn stash_pop_with_conflicts_keeps_the_stash() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.write("a.txt", "stashed\n");
    ops::stash_save(&t.path, Some("mine"), false).unwrap();
    t.commit("a.txt", "committed\n", "moved on");
    let res = ops::stash_apply(&t.path, 0, true);
    assert!(res.is_err());
    assert_eq!(refs::stashes(&mut t.open()).unwrap().len(), 1, "stash kept");
}

#[test]
fn branches_move_without_checkout() {
    let t = TestRepo::new();
    let first = t.commit("a.txt", "1\n", "first");
    t.commit("a.txt", "2\n", "second");
    ops::create_branch(&t.path, "topic", None, false).unwrap();
    ops::move_branch(&t.path, "topic", &first).unwrap();
    assert_eq!(t.git(&["rev-parse", "topic"]), first);
    assert!(ops::move_branch(&t.path, "main", &first).is_err(), "checked-out branch is reset, not moved");
    assert!(ops::move_branch(&t.path, "nope", &first).is_err());
}

// --- regressions from the review of the libgit2 move ----------------------

#[test]
fn discard_spares_nested_repositories_and_ignored_files() {
    let t = TestRepo::new();
    t.commit(".gitignore", "*.log\n", "ignore logs");
    git_in(&t.path, &["init", "-q", "nested"]);
    t.write("nested/work.txt", "unpushed\n");
    t.write("scratch/a.txt", "a\n");
    t.write("scratch/keep.log", "log\n");
    assert!(ops::discard(&t.path, &[], &["nested/".into()]).is_err());
    assert!(t.path.join("nested/.git").exists());
    ops::discard(&t.path, &[], &["scratch/".into()]).unwrap();
    assert!(!t.path.join("scratch/a.txt").exists());
    assert!(t.path.join("scratch/keep.log").exists(), "ignored files stay, like git clean without -x");
}

#[test]
fn rebase_abort_returns_to_the_branch_and_reset_waits_for_it() {
    let t = TestRepo::new();
    t.commit("a.txt", "base\n", "base");
    t.git(&["switch", "-q", "-c", "feature"]);
    let tip = t.commit("a.txt", "feature\n", "feature edit");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "main\n", "main edit");
    t.git(&["switch", "-q", "feature"]);
    assert!(rebase::onto(&t.open(), "main").is_err());

    let err = ops::reset(&t.path, &tip, "keep").unwrap_err().to_string();
    assert!(err.contains("rebase is in progress"), "{err}");
    assert!(ops::reset(&t.path, &tip, "hard").is_err());
    assert_eq!(repo::info(&t.open()).unwrap().state, "rebase");

    ops::sequencer(&t.path, "rebase", "abort").unwrap();
    assert_eq!(t.git(&["symbolic-ref", "--short", "HEAD"]), "feature");
    assert_eq!(t.git(&["rev-parse", "HEAD"]), tip);
}

#[test]
fn sequencer_needs_the_operation_in_progress() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.write("new.txt", "staged\n");
    ops::stage(&t.path, &["new.txt".into()]).unwrap();
    for (op, action) in [("merge", "abort"), ("cherry-pick", "skip"), ("revert", "continue")] {
        assert!(ops::sequencer(&t.path, op, action).is_err(), "{op} {action}");
    }
    assert!(t.path.join("new.txt").exists(), "staged work untouched");
    assert_eq!(t.git(&["status", "--porcelain"]), "A  new.txt");
}

#[test]
fn stash_over_staged_changes_explains_itself() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.write("a.txt", "2\n");
    ops::stash_save(&t.path, None, false).unwrap();
    t.write("b.txt", "b\n");
    ops::stage(&t.path, &["b.txt".into()]).unwrap();
    let err = ops::stash_apply(&t.path, 0, false).unwrap_err().to_string();
    assert!(err.contains("staged changes"), "{err}");
}

#[test]
fn squash_never_folds_into_the_base() {
    let t = TestRepo::new();
    let base = t.commit("base.txt", "base\n", "base");
    let c1 = t.commit("f.txt", "x\n", "add f");
    t.git(&["rm", "-q", "f.txt"]);
    t.git(&["commit", "-q", "-m", "remove f"]);
    let c2 = t.git(&["rev-parse", "HEAD"]);
    let c3 = t.commit("g.txt", "g\n", "add g");
    // Without c1, "remove f" is empty and dropped; c3 has nothing of ours
    // below it to squash into.
    let plan = vec![step("drop", &c1, None), step("pick", &c2, None), step("squash", &c3, None)];
    rebase::run(&t.open(), &base, &plan).unwrap();
    assert_eq!(subjects(&t, &base), vec!["add g"]);
    assert_eq!(t.git(&["rev-parse", "HEAD~1"]), base, "base commit untouched");
}

#[test]
fn amending_during_a_merge_is_refused() {
    let t = conflicted_repo();
    ops::resolve_with_content(&t.path, "a.txt", "top\nboth\nbottom\n").unwrap();
    assert!(ops::commit(&t.path, "amend it", true).is_err());
    ops::commit(&t.path, "Merge other", false).unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%p"]).split(' ').count(), 2);
}

/// Push to a real https remote with a saved account, then clone it back.
/// Run by hand: GITBRIX_LIVE_URL=https://gitlab.com/me/test.git
///   cargo test --lib live_push -- --ignored --nocapture
#[test]
#[ignore]
fn live_push() {
    let url = std::env::var("GITBRIX_LIVE_URL").expect("GITBRIX_LIVE_URL");
    let home = std::env::var("HOME").unwrap();
    crate::accounts::init(Path::new(&home).join(".config/dev.gitbrix.app"));
    let t = TestRepo::new();
    t.commit("README.md", "# gitbrix push test\n\nPushed by gitbrix through libgit2.\n", "Push test from gitbrix");
    t.git(&["remote", "add", "origin", &url]);
    let mut lines = Vec::new();
    net::push(&t.path, false, &mut |l| lines.push(l.to_owned())).unwrap();
    println!("push progress: {lines:?}");
    let info = repo::info(&t.open()).unwrap();
    println!("upstream {:?} ahead {} behind {}", info.upstream, info.ahead, info.behind);
    assert_eq!(info.upstream.as_deref(), Some("origin/main"));

    let parent = t.path.parent().unwrap();
    let clone = net::clone(parent, &url, "roundtrip", &mut |_| {}).unwrap();
    assert_eq!(fs::read_to_string(clone.join("README.md")).unwrap(), "# gitbrix push test\n\nPushed by gitbrix through libgit2.\n");
    println!("clone ok: {}", clone.display());
}

#[test]
fn pull_requests_from_forks_check_out_on_their_own_branch() {
    let t = TestRepo::new();
    let base = t.commit("a.txt", "1\n", "first");
    let bare = t.add_origin();
    // The service keeps a fork's commits under refs/pull/N/head.
    let fork = t.commit("a.txt", "2\n", "from a fork");
    git_in(&t.path, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    git_in(&t.path, &["reset", "-q", "--hard", &base]);

    let branch = net::checkout_pull_request(&t.path, "origin", "github", 7, &mut |_| {}).unwrap();
    assert_eq!(branch, "pr/7");
    assert_eq!(t.git(&["rev-parse", "HEAD"]), fork);
    assert_eq!(t.git(&["symbolic-ref", "--short", "HEAD"]), "pr/7");

    // New commits on the request move the branch forward.
    ops::checkout_branch(&t.path, "main").unwrap();
    let other = TempDir::new().unwrap();
    git_in(other.path(), &["clone", "-q", bare.to_str().unwrap(), "c"]);
    let c = other.path().join("c");
    isolate(&c);
    git_in(&c, &["fetch", "-q", "origin", "refs/pull/7/head"]);
    git_in(&c, &["checkout", "-q", "FETCH_HEAD"]);
    fs::write(c.join("a.txt"), "3\n").unwrap();
    git_in(&c, &["commit", "-qam", "review fix"]);
    git_in(&c, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    net::checkout_pull_request(&t.path, "origin", "github", 7, &mut |_| {}).unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%s"]), "review fix");

    // While it's checked out it isn't moved under the user.
    git_in(&c, &["commit", "-q", "--allow-empty", "-m", "more"]);
    git_in(&c, &["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    let err = net::checkout_pull_request(&t.path, "origin", "github", 7, &mut |_| {}).unwrap_err().to_string();
    assert!(err.contains("is checked out"), "{err}");
    assert!(net::checkout_pull_request(&t.path, "origin", "gitlab", 7, &mut |_| {}).is_err());
}

#[test]
fn workspace_sums_up_each_repository() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    t.add_origin();
    t.git(&["push", "-q", "-u", "origin", "main"]);
    t.commit("a.txt", "2\n", "ahead");
    t.write("a.txt", "3\n");
    t.write("new.txt", "x\n");
    t.git(&["add", "new.txt"]);
    t.write("new.txt", "y\n");

    let missing = t.path.join("nope").to_string_lossy().into_owned();
    let paths = vec![t.path.to_string_lossy().into_owned(), missing.clone()];
    let got = workspace::summaries(&paths);
    assert_eq!(got.len(), 2);
    let info = got[0].info.as_ref().unwrap();
    assert_eq!(info.head_branch.as_deref(), Some("main"));
    assert_eq!((info.ahead, info.behind), (1, 0));
    // new.txt is staged and changed again: one file, counted once.
    assert_eq!(got[0].changes, 2);
    assert!(got[0].error.is_none());
    assert_eq!(got[1].path, missing);
    assert!(got[1].info.is_none() && got[1].error.is_some());
}

#[test]
fn workspace_finds_repositories_in_a_folder() {
    let root = TempDir::new().unwrap();
    for p in ["a", "group/b", "group/deep/er/c", "node_modules/d", ".hidden/e"] {
        let dir = root.path().join(p);
        fs::create_dir_all(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
    }
    // A repository's own subfolders aren't searched.
    fs::create_dir_all(root.path().join("a/sub")).unwrap();
    git_in(&root.path().join("a/sub"), &["init", "-q"]);

    let found = workspace::find(root.path(), 3);
    let rel: Vec<String> = found
        .iter()
        .map(|p| Path::new(p).strip_prefix(root.path()).unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(rel, ["a", "group/b"]);
}

#[test]
fn a_profile_for_the_folder_signs_commits_unless_the_repo_says_otherwise() {
    use crate::profiles::{self, Profile, Profiles};
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "first");
    // Only the folder rule applies here; other tests' repos aren't under it.
    profiles::set_cached(Profiles {
        active: None,
        list: vec![Profile {
            id: "work".into(),
            name: "Work".into(),
            user_name: "Work Me".into(),
            user_email: "me@work.example".into(),
            folders: vec![t.path.to_string_lossy().into_owned()],
            accounts: vec![],
        }],
    });
    // The repository's own identity wins.
    let id = profiles::identity(&t.open());
    assert_eq!((id.source, id.name.as_deref()), ("repository", Some("Test User")));

    t.git(&["config", "--unset", "user.name"]);
    t.git(&["config", "--unset", "user.email"]);
    let id = profiles::identity(&t.open());
    assert_eq!((id.source, id.profile.as_deref(), id.email.as_deref()), ("profile", Some("Work"), Some("me@work.example")));
    t.write("a.txt", "2\n");
    ops::stage(&t.path, &["a.txt".into()]).unwrap();
    ops::commit(&t.path, "as work", false).unwrap();
    assert_eq!(t.git(&["log", "-1", "--format=%an <%ae> / %cn <%ce>"]), "Work Me <me@work.example> / Work Me <me@work.example>");
}

#[test]
fn a_requests_range_runs_from_where_it_left_its_target() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "base");
    let bare = t.add_origin();
    t.git(&["push", "-q", "origin", "main"]);
    let fork_point = t.git(&["rev-parse", "HEAD"]);
    let head = t.commit("b.txt", "x\n", "request work");
    git_in(&t.path, &["push", "-q", "origin", "HEAD:refs/merge-requests/3/head"]);
    // The target moves on meanwhile, in another clone.
    let other = TempDir::new().unwrap();
    git_in(other.path(), &["clone", "-q", bare.to_str().unwrap(), "c"]);
    let c = other.path().join("c");
    isolate(&c);
    fs::write(c.join("a.txt"), "2\n").unwrap();
    git_in(&c, &["commit", "-qam", "target moves"]);
    git_in(&c, &["push", "-q", "origin", "main"]);
    t.git(&["reset", "-q", "--hard", &fork_point]);

    let range = net::pull_request_range(&t.path, "origin", "gitlab", 3, "main", &mut |_| {}).unwrap();
    assert_eq!((range.base.as_str(), range.head.as_str()), (fork_point.as_str(), head.as_str()));
    let files: Vec<String> = diff::compare(&t.open(), git2::Oid::from_str(&range.base).unwrap(), git2::Oid::from_str(&range.head).unwrap())
        .unwrap()
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(files, ["b.txt"], "only the request's own change, not the target's");
    assert!(net::pull_request_range(&t.path, "origin", "gitlab", 3, "nope", &mut |_| {}).is_err());
}

type LfsStore = std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>>;

/// A tiny LFS server: the batch API plus object GET/PUT, kept in memory.
fn lfs_server() -> (String, LfsStore) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::Arc;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let objects: LfsStore = Arc::default();
    let store = objects.clone();
    let href = base.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            let mut len = 0;
            loop {
                let mut h = String::new();
                reader.read_line(&mut h).unwrap();
                if h.trim().is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            let mut parts = line.split_whitespace();
            let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or("").to_owned());
            let (status, answer): (&str, Vec<u8>) = if path.ends_with("/objects/batch") {
                let req: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let op = req["operation"].as_str().unwrap().to_owned();
                let have = store.lock().unwrap();
                let objs: Vec<serde_json::Value> = req["objects"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|o| {
                        let oid = o["oid"].as_str().unwrap();
                        let url = format!("{href}/objects/{oid}");
                        match (op.as_str(), have.contains_key(oid)) {
                            ("download", true) => serde_json::json!({ "oid": oid, "size": o["size"], "actions": { "download": { "href": url } } }),
                            ("download", false) => serde_json::json!({ "oid": oid, "error": { "code": 404, "message": "Object does not exist" } }),
                            (_, true) => serde_json::json!({ "oid": oid, "size": o["size"] }),
                            (_, false) => serde_json::json!({ "oid": oid, "size": o["size"], "actions": {
                                "upload": { "href": url }, "verify": { "href": format!("{href}/verify") } } }),
                        }
                    })
                    .collect();
                ("200 OK", serde_json::json!({ "objects": objs }).to_string().into_bytes())
            } else if let Some(oid) = path.strip_prefix("/objects/") {
                if method == "PUT" {
                    store.lock().unwrap().insert(oid.to_owned(), body);
                    ("200 OK", Vec::new())
                } else {
                    match store.lock().unwrap().get(oid) {
                        Some(b) => ("200 OK", b.clone()),
                        None => ("404 Not Found", Vec::new()),
                    }
                }
            } else {
                ("200 OK", Vec::new())
            };
            let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", answer.len());
            let _ = stream.write_all(&answer);
        }
    });
    (base, objects)
}

#[test]
fn lfs_files_go_up_as_objects_and_come_back_as_content() {
    let (server, objects) = lfs_server();
    let t = TestRepo::new();
    let bare = t.add_origin();
    t.git(&["config", "lfs.url", &format!("{server}/repo.git/info/lfs")]);
    t.write(".gitattributes", "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    let content = "big binary-ish content\n".repeat(500);
    t.write("art.bin", &content);
    t.write("readme.txt", "small\n");
    ops::stage_all(&t.path).unwrap();

    // The index holds a pointer; the content went to the object store.
    let r = t.open();
    let entry = r.index().unwrap().get_path(Path::new("art.bin"), 0).unwrap();
    let pointer = lfs::Pointer::parse(r.find_blob(entry.id).unwrap().content()).expect("a pointer is staged");
    assert_eq!(pointer.size, content.len() as u64);
    assert_eq!(fs::read_to_string(lfs::object_path(&r, &pointer.oid)).unwrap(), content);
    let st = status::status(&r).unwrap();
    assert!(st.unstaged.is_empty(), "{:?}", st.unstaged.iter().map(|e| &e.path).collect::<Vec<_>>());

    ops::commit(&t.path, "add art", false).unwrap();
    net::push_branch(&t.path, "origin", "main", false, &mut |_| {}).unwrap();
    assert_eq!(objects.lock().unwrap().get(&pointer.oid).map(|b| b.len()), Some(content.len()), "uploaded before the push");

    // A fresh clone has the pointer until it pulls.
    let other = TempDir::new().unwrap();
    let clone = net::clone(other.path(), bare.to_str().unwrap(), "c", &mut |_| {}).unwrap();
    git_in(&clone, &["config", "lfs.url", &format!("{server}/repo.git/info/lfs")]);
    let cr = repo::open(&clone).unwrap();
    assert!(lfs::Pointer::parse(&fs::read(clone.join("art.bin")).unwrap()).is_some());
    assert_eq!(lfs::pending(&cr).unwrap().len(), 1);
    assert_eq!(lfs::pull(&clone, &mut |_| {}).unwrap(), 1);
    assert_eq!(fs::read_to_string(clone.join("art.bin")).unwrap(), content);
    assert!(lfs::pending(&cr).unwrap().is_empty());
    let st = status::status(&repo::open(&clone).unwrap()).unwrap();
    assert!(st.unstaged.is_empty() && st.staged.is_empty(), "pulled files aren't changes");

    // A real change shows, and stages as a new pointer.
    fs::write(clone.join("art.bin"), "changed\n").unwrap();
    let st = status::status(&repo::open(&clone).unwrap()).unwrap();
    assert_eq!(st.unstaged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["art.bin"]);
    ops::stage(&clone, &["art.bin".into()]).unwrap();
    let cr = repo::open(&clone).unwrap();
    let e = cr.index().unwrap().get_path(Path::new("art.bin"), 0).unwrap();
    assert_eq!(lfs::Pointer::parse(cr.find_blob(e.id).unwrap().content()).unwrap().size, 8);
}

#[test]
fn lfs_pointers_and_tracking() {
    let p = lfs::Pointer { oid: "a".repeat(64), size: 12 };
    assert_eq!(lfs::Pointer::parse(p.text().as_bytes()), Some(p.clone()));
    assert_eq!(lfs::Pointer::parse(b"version https://git-lfs.github.com/spec/v1\noid sha256:xyz\nsize 1\n"), None);
    assert_eq!(lfs::Pointer::parse(b"just text"), None);

    let t = TestRepo::new();
    lfs::track(&t.path, "*.psd").unwrap();
    lfs::track(&t.path, "*.psd").unwrap();
    lfs::track(&t.path, "my file.zip").unwrap();
    assert_eq!(
        fs::read_to_string(t.path.join(".gitattributes")).unwrap(),
        "*.psd filter=lfs diff=lfs merge=lfs -text\nmy[[:space:]]file.zip filter=lfs diff=lfs merge=lfs -text\n"
    );
    assert!(lfs::tracked(&t.open(), "deep/a.psd") && !lfs::tracked(&t.open(), "a.txt"));
    assert!(lfs::track(&t.path, " ").is_err());
}

#[test]
fn patches_round_trip_through_git_and_back() {
    let t = TestRepo::new();
    let base = t.commit("a.txt", "one\n", "base");
    let other = TempDir::new().unwrap();
    let mirror = other.path().join("m");
    git_in(other.path(), &["clone", "-q", t.path.to_str().unwrap(), "m"]);
    isolate(&mirror);

    t.git(&["config", "user.name", "Selçuk Öz"]);
    t.commit("a.txt", "one\ntwo\n", "Add two\n\nBecause one wasn't enough.");
    t.git(&["config", "user.name", "Test User"]);
    t.write("b.txt", "new file\n");
    t.git(&["add", "-A"]);
    t.git(&["commit", "-q", "-m", "Add b"]);
    let head = t.git(&["rev-parse", "HEAD"]);

    // Ours, read by git am.
    let r = t.open();
    let ids = patch::range(&r, git2::Oid::from_str(&base).unwrap(), git2::Oid::from_str(&head).unwrap()).unwrap();
    let mbox = patch::format(&r, &ids).unwrap();
    assert!(mbox.contains("[PATCH 1/2] Add two") && mbox.contains("[PATCH 2/2] Add b"), "{mbox}");
    let file = other.path().join("series.patch");
    fs::write(&file, &mbox).unwrap();
    git_in(&mirror, &["am", "-q", file.to_str().unwrap()]);
    assert_eq!(git_in(&mirror, &["log", "-2", "--format=%an|%s|%b"]), "Test User|Add b|\nSelçuk Öz|Add two|Because one wasn't enough.");

    // git format-patch's, applied by us as commits.
    let third = other.path().join("t");
    git_in(other.path(), &["clone", "-q", t.path.to_str().unwrap(), "t"]);
    isolate(&third);
    git_in(&third, &["reset", "-q", "--hard", &base]);
    let gitmbox = t.git(&["format-patch", "--stdout", &format!("{base}..HEAD")]);
    let mails = patch::parse(&gitmbox);
    assert_eq!(mails.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["Add two", "Add b"]);
    assert_eq!(mails[0].author.as_ref().map(|a| a.0.as_str()), Some("Selçuk Öz"));
    assert_eq!(mails[0].date.map(|d| d.0), Some(1767225600), "2026-01-01T00:00:00Z");
    assert_eq!(patch::apply(&third, &gitmbox, true).unwrap(), 2);
    assert_eq!(git_in(&third, &["log", "-2", "--format=%an|%at|%s|%b"]), "Test User|1767225600|Add b|\nSelçuk Öz|1767225600|Add two|Because one wasn't enough.");
    assert_eq!(git_in(&third, &["rev-parse", "HEAD^{tree}"]), t.git(&["rev-parse", "HEAD^{tree}"]));

    // A plain diff lands in the work tree only.
    git_in(&third, &["reset", "-q", "--hard", &base]);
    let plain = t.git(&["diff", &base, "HEAD"]);
    assert_eq!(patch::apply(&third, &format!("{plain}\n"), false).unwrap(), 0);
    assert_eq!(fs::read_to_string(third.join("a.txt")).unwrap(), "one\ntwo\n");
    assert_eq!(git_in(&third, &["diff", "--cached", "--name-only"]), "");
    // It doesn't apply twice.
    assert!(patch::apply(&third, &format!("{plain}\n"), false).is_err());
    assert!(patch::apply(&third, "nothing here", false).is_err());
}

#[test]
fn several_commits_cherry_pick_in_order_and_revert_newest_first() {
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "base");
    t.git(&["switch", "-q", "-c", "side"]);
    let one = t.commit("b.txt", "b\n", "add b");
    t.commit("skip.txt", "x\n", "not picked");
    let two = t.commit("c.txt", "c\n", "add c");
    t.git(&["switch", "-q", "main"]);
    t.commit("a.txt", "2\n", "main moves");

    rebase::pick_onto_head(&t.open(), &[one.clone(), two.clone()]).unwrap();
    assert_eq!(t.git(&["log", "-3", "--format=%s"]), "add c\nadd b\nmain moves");
    assert_eq!(t.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    assert!(!t.path.join("skip.txt").exists());

    let picked: Vec<String> = t.git(&["log", "-2", "--format=%H"]).lines().map(str::to_owned).collect();
    assert_eq!(ops::revert_many(&t.path, &picked).unwrap(), 2);
    assert_eq!(t.git(&["log", "-2", "--format=%s"]), "Revert \"add b\"\nRevert \"add c\"");
    assert!(!t.path.join("b.txt").exists() && !t.path.join("c.txt").exists());

    // A conflict stops the sequence; continue finishes it.
    t.git(&["switch", "-q", "-c", "clash", "HEAD~5"]);
    let clash = t.commit("a.txt", "clash\n", "clash");
    let after = t.commit("d.txt", "d\n", "after clash");
    t.git(&["switch", "-q", "main"]);
    let err = rebase::pick_onto_head(&t.open(), &[clash, after]).unwrap_err().to_string();
    assert!(err.contains("conflicts in a.txt"), "{err}");
    fs::write(t.path.join("a.txt"), "resolved\n").unwrap();
    ops::stage(&t.path, &["a.txt".into()]).unwrap();
    ops::sequencer(&t.path, "rebase", "continue").unwrap();
    assert_eq!(t.git(&["log", "-2", "--format=%s"]), "after clash\nclash");
    assert_eq!(t.git(&["symbolic-ref", "--short", "HEAD"]), "main");
}

#[test]
fn stale_branches_are_merged_or_gone() {
    use super::cleanup;
    let t = TestRepo::new();
    t.commit("a.txt", "1\n", "base");
    t.add_origin();
    t.git(&["push", "-q", "-u", "origin", "main"]);
    t.git(&["switch", "-q", "-c", "done"]);
    t.commit("b.txt", "b\n", "done work");
    t.git(&["switch", "-q", "main"]);
    t.git(&["merge", "-q", "--no-ff", "done", "-m", "merge done"]);
    t.git(&["push", "-q", "origin", "main"]);
    t.git(&["switch", "-q", "-c", "wip"]);
    t.commit("c.txt", "c\n", "unfinished");
    t.git(&["push", "-q", "-u", "origin", "wip"]);
    // Deleted on the server, then pruned by a fetch: "gone".
    t.git(&["push", "-q", "origin", "--delete", "wip"]);
    t.git(&["switch", "-q", "main"]);
    t.git(&["branch", "fresh"]);
    t.git(&["switch", "-q", "-c", "ahead"]);
    t.commit("d.txt", "d\n", "not merged");
    t.git(&["switch", "-q", "main"]);
    t.git(&["push", "-q", "origin", "done"]);
    t.git(&["remote", "set-head", "origin", "main"]);

    let got = cleanup::stale(&t.open()).unwrap();
    let seen: Vec<(&str, bool, &str, &str)> = got.iter().map(|s| (s.name.as_str(), s.remote, s.reason, s.into.as_str())).collect();
    assert_eq!(
        seen,
        [("done", false, "merged", "main"), ("fresh", false, "merged", "main"), ("wip", false, "gone", "origin/wip"), ("origin/done", true, "merged", "origin/main")]
    );
    assert!(!got[2].merged, "a gone branch may hold unmerged work");
}
