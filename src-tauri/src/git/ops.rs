//! Repository-changing operations, through libgit2. Network operations
//! live in `net`, rebases in `rebase`. libgit2 doesn't run hooks or sign,
//! so commits go through `hooks` and `sign` to behave as git would.

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{
    BranchType, CheckoutNotificationType, Commit, ErrorCode, Index, IndexAddOption, IndexEntry, IndexTime, Object,
    ObjectType, Oid, Reference, Repository, RepositoryState, ResetType, Signature, StashApplyOptions, StashFlags, Tree,
};

use super::{hooks, lfs, rebase, repo as repos, sign};
use crate::error::{Error, Result};

fn open(path: &Path) -> Result<Repository> {
    repos::open(path)
}

/// Ref names come from the UI; refuse anything git would read as an option.
pub(crate) fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(Error::msg(format!("Invalid name: {name:?}")));
    }
    Ok(())
}

fn check_branch_name(name: &str) -> Result<()> {
    check_name(name)?;
    if !Reference::is_valid_name(&format!("refs/heads/{name}")) {
        return Err(Error::msg(format!("'{name}' is not a valid branch name")));
    }
    Ok(())
}

/// A path from the UI must stay inside the work tree.
pub fn check_path(path: &str) -> Result<()> {
    let p = Path::new(path);
    if path.is_empty() || p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(Error::msg(format!("Invalid path: {path:?}")));
    }
    Ok(())
}

/// Don't write through a symlink committed into the repository: it could
/// point anywhere (e.g. `.gitignore -> ~/.bashrc`).
fn refuse_symlink(file: &Path) -> Result<()> {
    if std::fs::symlink_metadata(file).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
        return Err(Error::msg(format!("{} is a symbolic link; not writing through it", file.display())));
    }
    Ok(())
}

pub(crate) fn head_commit(r: &Repository) -> Option<Commit<'_>> {
    r.head().ok()?.peel_to_commit().ok()
}

fn resolve_commit<'r>(r: &'r Repository, rev: &str) -> Result<Commit<'r>> {
    check_name(rev)?;
    r.revparse_single(rev)
        .and_then(|o| o.peel_to_commit())
        .map_err(|_| Error::msg(format!("Unknown revision {rev}")))
}

/// The profile's identity, if one applies to this repository; otherwise
/// what git would use (environment, then config).
pub(crate) fn author(r: &Repository) -> Result<Signature<'static>> {
    match crate::profiles::signature_override(r) {
        Some((name, email)) => Ok(Signature::now(&name, &email)?),
        None => r.author_from_env().map_err(identity_error),
    }
}

pub(crate) fn committer(r: &Repository) -> Result<Signature<'static>> {
    match crate::profiles::signature_override(r) {
        Some((name, email)) => Ok(Signature::now(&name, &email)?),
        None => r.committer_from_env().map_err(identity_error),
    }
}

fn identity_error(e: git2::Error) -> Error {
    if e.code() == ErrorCode::NotFound {
        Error::msg("Set your name and email first: add a profile in Settings, or user.name and user.email in git config")
    } else {
        e.into()
    }
}

fn summary_of(message: &str) -> &str {
    message.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim()
}

/// Point HEAD (its branch, or HEAD itself when detached) at `oid`.
pub(crate) fn update_head(r: &Repository, oid: Oid, log: &str) -> Result<()> {
    let head = r.find_reference("HEAD")?;
    match head.symbolic_target().ok().flatten() {
        Some(target) => {
            let target = target.to_owned();
            match r.refname_to_id(&target) {
                // Compare-and-swap: fail rather than lose a concurrent update.
                Ok(current) => r.reference_matching(&target, oid, true, current, log)?,
                Err(_) => r.reference(&target, oid, false, log)?,
            };
        }
        None => {
            r.reference("HEAD", oid, true, log)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Index and work tree

fn entry_for(path: &str, mode: u32, id: Oid) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: path.len().min(0xfff) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Make the index entry for `path` match `tree` (removing it when the
/// tree doesn't have it). Literal: no pathspec matching.
fn reset_path(index: &mut Index, tree: Option<&Tree>, path: &str) -> Result<()> {
    let _ = index.conflict_remove(Path::new(path));
    let entry = tree.and_then(|t| t.get_path(Path::new(path)).ok()).filter(|e| e.kind() != Some(ObjectType::Tree));
    match entry {
        Some(e) => index.add(&entry_for(path, e.filemode() as u32, e.id()))?,
        None => {
            let _ = index.remove_path(Path::new(path));
        }
    }
    Ok(())
}

fn stage_path(r: &Repository, index: &mut Index, path: &str) -> Result<()> {
    check_path(path)?;
    let full = repos::workdir(r).join(path);
    match std::fs::symlink_metadata(&full) {
        Ok(meta) if meta.is_dir() => {
            // A submodule (or nested repository) is staged as its commit.
            let mut sm = r
                .find_submodule(path)
                .map_err(|_| Error::msg(format!("{path} is a directory, not a file")))?;
            sm.add_to_index(false)?;
            *index = r.index()?;
        }
        Ok(meta) if meta.is_file() && lfs::used(r) && lfs::tracked(r, path) => lfs::stage(r, index, path)?,
        Ok(_) => index.add_path(Path::new(path))?,
        Err(_) => {
            let _ = index.conflict_remove(Path::new(path));
            index.remove_path(Path::new(path))?;
        }
    }
    Ok(())
}

pub fn stage(repo: &Path, paths: &[String]) -> Result<()> {
    let r = open(repo)?;
    let mut index = r.index()?;
    for p in paths {
        stage_path(&r, &mut index, p)?;
    }
    index.write()?;
    Ok(())
}

pub fn stage_all(repo: &Path) -> Result<()> {
    let r = open(repo)?;
    let mut index = r.index()?;
    // LFS files are left to `lfs::stage`, which stages their pointers.
    let lfs = lfs::used(&r);
    let workdir = repos::workdir(&r);
    let mut lfs_paths: Vec<String> = Vec::new();
    {
        let mut skip_lfs = |path: &Path, _: &[u8]| -> i32 {
            let p = path.to_string_lossy();
            if lfs && workdir.join(path).is_file() && lfs::tracked(&r, &p) {
                lfs_paths.push(p.into_owned());
                1
            } else {
                0
            }
        };
        index.add_all(["*"], IndexAddOption::DEFAULT, Some(&mut skip_lfs))?;
        index.update_all(["*"], Some(&mut skip_lfs))?;
    }
    lfs_paths.sort();
    lfs_paths.dedup();
    for p in &lfs_paths {
        lfs::stage(&r, &mut index, p)?;
    }
    index.write()?;
    Ok(())
}

pub fn unstage(repo: &Path, paths: &[String]) -> Result<()> {
    let r = open(repo)?;
    let mut index = r.index()?;
    let tree = head_commit(&r).map(|c| c.tree()).transpose()?;
    for p in paths {
        check_path(p)?;
        reset_path(&mut index, tree.as_ref(), p)?;
    }
    index.write()?;
    Ok(())
}

pub fn unstage_all(repo: &Path) -> Result<()> {
    let r = open(repo)?;
    match head_commit(&r) {
        Some(head) => r.reset_default(Some(head.as_object()), ["*"])?,
        None => {
            let mut index = r.index()?;
            index.clear()?;
            index.write()?;
        }
    }
    Ok(())
}

/// Rewrite a patch from the UI for libgit2: optionally reversed (swap
/// sides), and with hunk line counts recomputed from the hunk bodies
/// (the UI may leave them approximate, as `git apply --recount` allows).
pub fn prepare_patch(patch: &str, reverse: bool) -> Result<String> {
    let lines: Vec<&str> = patch.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    let swap_prefix = |l: &str| -> String {
        match l.as_bytes().first() {
            Some(b'+') if reverse => format!("-{}", &l[1..]),
            Some(b'-') if reverse => format!("+{}", &l[1..]),
            _ => l.to_owned(),
        }
    };
    while i < lines.len() {
        let l = lines[i];
        if let Some(rest) = l.strip_prefix("@@ ") {
            let (ranges, tail) = rest.split_once(" @@").ok_or_else(|| Error::msg("Malformed hunk header"))?;
            let mut parts = ranges.split_whitespace();
            let start = |s: Option<&str>, sign: char| -> Result<u32> {
                let s = s.and_then(|s| s.strip_prefix(sign)).ok_or_else(|| Error::msg("Malformed hunk header"))?;
                s.split(',').next().unwrap_or("").parse().map_err(|_| Error::msg("Malformed hunk header"))
            };
            let mut old_start = start(parts.next(), '-')?;
            let mut new_start = start(parts.next(), '+')?;
            let mut body = Vec::new();
            let (mut old_n, mut new_n) = (0u32, 0u32);
            i += 1;
            while i < lines.len() && !lines[i].starts_with("@@ ") && !lines[i].starts_with("diff --git ") {
                let b = lines[i];
                match b.as_bytes().first() {
                    Some(b' ') | None => {
                        old_n += 1;
                        new_n += 1;
                    }
                    Some(b'-') => old_n += 1,
                    Some(b'+') => new_n += 1,
                    _ => {}
                }
                body.push(if b.is_empty() { " ".to_owned() } else { swap_prefix(b) });
                i += 1;
            }
            if reverse {
                std::mem::swap(&mut old_start, &mut new_start);
                std::mem::swap(&mut old_n, &mut new_n);
            }
            out.push(format!("@@ -{old_start},{old_n} +{new_start},{new_n} @@{tail}"));
            out.extend(body);
            continue;
        }
        if reverse {
            if let Some(rest) = l.strip_prefix("diff --git a/") {
                // "a/<old> b/<new>": the UI writes both; swap them.
                if let Some((old, new)) = rest.split_once(" b/") {
                    out.push(format!("diff --git a/{new} b/{old}"));
                    i += 1;
                    continue;
                }
            }
            if let (Some(old), Some(new)) = (l.strip_prefix("--- "), lines.get(i + 1).and_then(|n| n.strip_prefix("+++ "))) {
                let flip = |p: &str, side: &str| p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).map(|x| format!("{side}{x}")).unwrap_or_else(|| p.to_owned());
                out.push(format!("--- {}", flip(new, "a/")));
                out.push(format!("+++ {}", flip(old, "b/")));
                i += 2;
                continue;
            }
        }
        out.push(l.to_owned());
        i += 1;
    }
    Ok(out.join("\n") + "\n")
}

/// Apply a patch built by the UI from part of a diff, to the index
/// (staging / unstaging hunks and lines) or the work tree (discarding).
pub fn apply_patch(repo: &Path, patch: &str, to_index: bool, reverse: bool) -> Result<()> {
    let r = open(repo)?;
    let text = prepare_patch(patch, reverse)?;
    let diff = git2::Diff::from_buffer(text.as_bytes())?;
    let location = if to_index { git2::ApplyLocation::Index } else { git2::ApplyLocation::WorkDir };
    r.apply(&diff, location, None)
        .map_err(|e| Error::msg(format!("The change no longer applies; refresh and try again ({})", e.message())))?;
    Ok(())
}

/// Record an untracked file in the index as empty, so a patch can stage
/// part of its content.
pub fn intent_to_add(repo: &Path, path: &str) -> Result<()> {
    check_path(path)?;
    let r = open(repo)?;
    let mut index = r.index()?;
    if index.get_path(Path::new(path), 0).is_none() {
        let empty = r.blob(b"")?;
        let mode = if is_executable(&repos::workdir(&r).join(path)) { 0o100755 } else { 0o100644 };
        index.add(&entry_for(path, mode, empty))?;
        index.write()?;
    }
    Ok(())
}

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        let _ = p;
        false
    }
}

/// Resolve a conflicted file by writing `content` to it and staging it.
pub fn resolve_with_content(repo: &Path, path: &str, content: &str) -> Result<()> {
    check_path(path)?;
    let r = open(repo)?;
    let file = repos::workdir(&r).join(path);
    refuse_symlink(&file)?;
    std::fs::write(&file, content)?;
    let mut index = r.index()?;
    index.add_path(Path::new(path))?;
    index.write()?;
    Ok(())
}

/// Resolve a conflicted file by taking one side whole. If that side
/// deleted the file, the resolution is the deletion.
pub fn resolve_with_side(repo: &Path, path: &str, side: &str, side_exists: bool) -> Result<()> {
    check_path(path)?;
    if !matches!(side, "ours" | "theirs") {
        return Err(Error::msg(format!("Unknown side {side}")));
    }
    let r = open(repo)?;
    let file = repos::workdir(&r).join(path);
    let mut index = r.index()?;
    if side_exists {
        refuse_symlink(&file)?;
        let mut cb = CheckoutBuilder::new();
        cb.force().path(path).disable_pathspec_match(true);
        if side == "ours" {
            cb.use_ours(true);
        } else {
            cb.use_theirs(true);
        }
        r.checkout_index(Some(&mut index), Some(&mut cb))?;
        index.add_path(Path::new(path))?;
    } else {
        if std::fs::symlink_metadata(&file).is_ok() {
            std::fs::remove_file(&file)?;
        }
        let _ = index.conflict_remove(Path::new(path));
        index.remove_path(Path::new(path))?;
    }
    index.write()?;
    Ok(())
}

/// Append `pattern` to the repository's top-level .gitignore.
pub fn ignore(repo: &Path, pattern: &str) -> Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.chars().any(char::is_control) {
        return Err(Error::msg("Invalid ignore pattern"));
    }
    let file = repo.join(".gitignore");
    refuse_symlink(&file)?;
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    if text.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(pattern);
    text.push('\n');
    std::fs::write(file, text)?;
    Ok(())
}

/// Throw away unstaged changes. Tracked files go back to their index
/// version; untracked files are deleted.
pub fn discard(repo: &Path, tracked: &[String], untracked: &[String]) -> Result<()> {
    let r = open(repo)?;
    let wd = repos::workdir(&r);
    if !tracked.is_empty() {
        let mut cb = CheckoutBuilder::new();
        cb.force().disable_pathspec_match(true);
        for p in tracked {
            check_path(p)?;
            cb.path(p.as_str());
        }
        r.checkout_index(None, Some(&mut cb))?;
    }
    for p in untracked {
        check_path(p)?;
        let full = wd.join(p);
        match std::fs::symlink_metadata(&full) {
            Ok(m) if m.is_dir() => remove_untracked_dir(&r, &wd, &full)?,
            Ok(_) => std::fs::remove_file(&full)?,
            Err(_) => {}
        }
    }
    Ok(())
}

/// Delete an untracked directory like `git clean -f -d`: never a nested
/// repository (its history may exist nowhere else), never ignored files.
fn remove_untracked_dir(r: &Repository, wd: &Path, dir: &Path) -> Result<()> {
    if dir.join(".git").exists() {
        let rel = dir.strip_prefix(wd).unwrap_or(dir).display();
        return Err(Error::msg(format!("{rel} is a separate repository; not deleting it")));
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let rel = path.strip_prefix(wd).unwrap_or(&path);
        if r.status_should_ignore(rel).unwrap_or(true) {
            continue;
        }
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            remove_untracked_dir(r, wd, &path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    // Still holding ignored files: keep it.
    let _ = std::fs::remove_dir(dir);
    Ok(())
}

// ---------------------------------------------------------------------------
// Commits

pub fn commit(repo: &Path, message: &str, amend: bool) -> Result<()> {
    if message.trim().is_empty() {
        return Err(Error::msg("Commit message is empty"));
    }
    let r = open(repo)?;
    if r.index()?.has_conflicts() {
        return Err(Error::msg("Resolve all conflicts before committing"));
    }
    let head = head_commit(&r);
    if amend && head.is_none() {
        return Err(Error::msg("There is no commit to amend yet"));
    }
    if amend && matches!(r.state(), RepositoryState::Merge | RepositoryState::CherryPick | RepositoryState::Revert) {
        return Err(Error::msg("Finish or abort the operation in progress before amending"));
    }
    hooks::run(&r, "pre-commit", &[], None)?;
    // The hook may have staged more (formatters do).
    let mut index = r.index()?;
    index.read(false)?;
    let tree = r.find_tree(index.write_tree()?)?;

    let state = r.state();
    let mut parents: Vec<Commit> = Vec::new();
    let author;
    if amend {
        let h = head.as_ref().expect("checked above");
        parents.extend(h.parents());
        author = h.author().to_owned();
    } else {
        parents.extend(head.clone());
        if state == RepositoryState::Merge {
            for id in merge_heads(&r)? {
                parents.push(r.find_commit(id)?);
            }
        }
        author = match state {
            // Finishing a stopped cherry-pick (or rebase step) keeps the
            // original author.
            RepositoryState::CherryPick => r.revparse_single("CHERRY_PICK_HEAD")?.peel_to_commit()?.author().to_owned(),
            _ => match rebase::stopped_commit(&r).and_then(|id| r.find_commit(id).ok()) {
                Some(c) => c.author().to_owned(),
                None => self::author(&r)?,
            },
        };
        let unchanged = match &head {
            Some(h) => h.tree_id() == tree.id(),
            None => index.is_empty(),
        };
        if unchanged && parents.len() < 2 {
            return Err(Error::msg("Nothing to commit: stage some changes first"));
        }
    }

    let source: Vec<String> = if amend {
        vec!["commit".into(), head.as_ref().expect("checked above").id().to_string()]
    } else if state == RepositoryState::Merge {
        vec!["merge".into()]
    } else {
        vec!["message".into()]
    };
    let source: Vec<&str> = source.iter().map(String::as_str).collect();
    let message = hooks::commit_message(&r, message, &source)?;
    let message = git2::message_prettify(message, None)?;
    if message.trim().is_empty() {
        return Err(Error::msg("Commit message is empty"));
    }

    let refs: Vec<&Commit> = parents.iter().collect();
    let oid = sign::commit(&r, &author, &committer(&r)?, &message, &tree, &refs)?;
    let kind = if amend {
        "commit (amend)"
    } else if refs.is_empty() {
        "commit (initial)"
    } else if refs.len() > 1 {
        "commit (merge)"
    } else {
        "commit"
    };
    update_head(&r, oid, &format!("{kind}: {}", summary_of(&message)))?;
    if !amend && matches!(state, RepositoryState::Merge | RepositoryState::CherryPick | RepositoryState::Revert) {
        r.cleanup_state()?;
    }
    hooks::notify(&r, "post-commit", &[]);
    Ok(())
}

/// Change the last commit's message only; staged changes stay staged.
pub fn reword_head(repo: &Path, message: &str) -> Result<()> {
    if message.trim().is_empty() {
        return Err(Error::msg("Commit message is empty"));
    }
    let r = open(repo)?;
    let head = head_commit(&r).ok_or_else(|| Error::msg("There is no commit yet"))?;
    let id = head.id().to_string();
    let message = hooks::commit_message(&r, message, &["commit", &id])?;
    let message = git2::message_prettify(message, None)?;
    let parents: Vec<Commit> = head.parents().collect();
    let refs: Vec<&Commit> = parents.iter().collect();
    let oid = sign::commit(&r, &head.author(), &committer(&r)?, &message, &head.tree()?, &refs)?;
    update_head(&r, oid, &format!("commit (amend): {}", summary_of(&message)))?;
    hooks::notify(&r, "post-commit", &[]);
    Ok(())
}

fn merge_heads(r: &Repository) -> Result<Vec<Oid>> {
    let text = std::fs::read_to_string(r.path().join("MERGE_HEAD")).unwrap_or_default();
    Ok(text.lines().filter_map(|l| Oid::from_str(l.trim()).ok()).collect())
}

// ---------------------------------------------------------------------------
// Checkout, branches, tags

/// Check out `target` like `git switch`: local changes that don't collide
/// with the switch come along; ones that would be overwritten stop it.
pub(crate) fn safe_checkout(r: &Repository, target: &Object) -> Result<()> {
    let mut conflicts: Vec<String> = Vec::new();
    let result = {
        let mut cb = CheckoutBuilder::new();
        cb.safe().notify_on(CheckoutNotificationType::CONFLICT).notify(|_, path, _, _, _| {
            if let Some(p) = path {
                conflicts.push(p.to_string_lossy().into_owned());
            }
            true
        });
        r.checkout_tree(target, Some(&mut cb))
    };
    match result {
        Ok(()) => Ok(()),
        Err(_) if !conflicts.is_empty() => Err(Error::msg(format!(
            "Your local changes to {} would be overwritten. Commit or stash them first.",
            conflicts.join(", ")
        ))),
        Err(e) => Err(e.into()),
    }
}

fn post_checkout(r: &Repository, from: Option<Oid>, to: Oid) {
    let zero = Oid::ZERO_SHA1.to_string();
    let from = from.map(|o| o.to_string()).unwrap_or(zero);
    hooks::notify(r, "post-checkout", &[&from, &to.to_string(), "1"]);
}

pub fn checkout_branch(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    let r = open(repo)?;
    let refname = format!("refs/heads/{name}");
    let target = r
        .find_reference(&refname)
        .and_then(|rf| rf.peel_to_commit())
        .map_err(|_| Error::msg(format!("No branch named '{name}'")))?;
    let from = head_commit(&r).map(|c| c.id());
    safe_checkout(&r, target.as_object())?;
    r.set_head(&refname)?;
    post_checkout(&r, from, target.id());
    Ok(())
}

/// Check out a remote branch: switch to the local branch tracking it,
/// creating one if needed.
pub fn checkout_remote(repo: &Path, remote_branch: &str, local: &str) -> Result<()> {
    check_name(remote_branch)?;
    check_branch_name(local)?;
    let r = open(repo)?;
    if r.find_branch(local, BranchType::Local).is_ok() {
        return checkout_branch(repo, local);
    }
    let remote = r
        .find_branch(remote_branch, BranchType::Remote)
        .map_err(|_| Error::msg(format!("No remote branch '{remote_branch}'")))?;
    let target = remote.get().peel_to_commit()?;
    let from = head_commit(&r).map(|c| c.id());
    safe_checkout(&r, target.as_object())?;
    let mut branch = r.branch(local, &target, false)?;
    branch.set_upstream(Some(remote_branch))?;
    r.set_head(&format!("refs/heads/{local}"))?;
    post_checkout(&r, from, target.id());
    Ok(())
}

pub fn checkout_detached(repo: &Path, rev: &str) -> Result<()> {
    let r = open(repo)?;
    let target = resolve_commit(&r, rev)?;
    let from = head_commit(&r).map(|c| c.id());
    safe_checkout(&r, target.as_object())?;
    r.set_head_detached(target.id())?;
    post_checkout(&r, from, target.id());
    Ok(())
}

pub fn create_branch(repo: &Path, name: &str, start: Option<&str>, checkout: bool) -> Result<()> {
    check_branch_name(name)?;
    let r = open(repo)?;
    if r.find_branch(name, BranchType::Local).is_ok() {
        return Err(Error::msg(format!("A branch named '{name}' already exists")));
    }
    let refname = format!("refs/heads/{name}");
    // Starting from a remote branch tracks it, as git does by default.
    let (target, upstream) = match start {
        Some(s) => match r.find_branch(s, BranchType::Remote) {
            Ok(b) => (b.get().peel_to_commit()?, Some(s)),
            Err(_) => (resolve_commit(&r, s)?, None),
        },
        None => match head_commit(&r) {
            Some(c) => (c, None),
            None if checkout => {
                // No commits yet: the unborn branch just gets a new name.
                r.set_head(&refname)?;
                return Ok(());
            }
            None => return Err(Error::msg("There are no commits to branch from yet")),
        },
    };
    let from = head_commit(&r).map(|c| c.id());
    if checkout {
        safe_checkout(&r, target.as_object())?;
    }
    let mut branch = r.branch(name, &target, false)?;
    if let Some(u) = upstream {
        branch.set_upstream(Some(u))?;
    }
    if checkout {
        r.set_head(&refname)?;
        post_checkout(&r, from, target.id());
    }
    Ok(())
}

pub fn delete_branch(repo: &Path, name: &str, force: bool) -> Result<()> {
    check_name(name)?;
    let r = open(repo)?;
    let mut branch = r
        .find_branch(name, BranchType::Local)
        .map_err(|_| Error::msg(format!("No branch named '{name}'")))?;
    if branch.is_head() {
        return Err(Error::msg(format!("Can't delete '{name}': it is checked out")));
    }
    if !force {
        // Merged means reachable from its upstream if it has one, else HEAD.
        let tip = branch.get().target().ok_or_else(|| Error::msg("Branch has no target"))?;
        let base = branch.upstream().ok().and_then(|u| u.get().target()).or_else(|| head_commit(&r).map(|c| c.id()));
        let merged = base.is_some_and(|b| b == tip || r.graph_descendant_of(b, tip).unwrap_or(false));
        if !merged {
            return Err(Error::msg(format!("The branch '{name}' is not fully merged.")));
        }
    }
    branch.delete()?;
    Ok(())
}

/// Point branch `name` at `target` without checking anything out (the
/// checked-out branch is reset instead).
pub fn move_branch(repo: &Path, name: &str, target: &str) -> Result<()> {
    check_name(name)?;
    let r = open(repo)?;
    let branch = r
        .find_branch(name, BranchType::Local)
        .map_err(|_| Error::msg(format!("No branch named '{name}'")))?;
    if branch.is_head() {
        return Err(Error::msg(format!("'{name}' is checked out; reset it instead")));
    }
    if super::worktree::list(repo)?.iter().any(|w| w.branch.as_deref() == Some(name)) {
        return Err(Error::msg(format!("'{name}' is checked out in another work tree")));
    }
    let commit = resolve_commit(&r, target)?;
    r.reference(&format!("refs/heads/{name}"), commit.id(), true, &format!("branch: moved to {target}"))?;
    Ok(())
}

pub fn rename_branch(repo: &Path, old: &str, new: &str) -> Result<()> {
    check_name(old)?;
    check_branch_name(new)?;
    let r = open(repo)?;
    let mut branch = r
        .find_branch(old, BranchType::Local)
        .map_err(|_| Error::msg(format!("No branch named '{old}'")))?;
    branch.rename(new, false)?;
    Ok(())
}

pub fn create_tag(repo: &Path, name: &str, target: &str, message: Option<&str>) -> Result<()> {
    check_name(name)?;
    if !git2::Tag::is_valid_name(name) {
        return Err(Error::msg(format!("'{name}' is not a valid tag name")));
    }
    let r = open(repo)?;
    let obj = resolve_commit(&r, target)?.into_object();
    match message.filter(|m| !m.trim().is_empty()) {
        Some(m) => {
            let msg = git2::message_prettify(m, Some(b'#'))?;
            sign::tag(&r, name, &obj, &committer(&r)?, &msg)?;
        }
        None => {
            r.tag_lightweight(name, &obj, false)?;
        }
    }
    Ok(())
}

pub fn delete_tag(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    open(repo)?.tag_delete(name)?;
    Ok(())
}

pub fn set_upstream(repo: &Path, branch: &str, upstream: Option<&str>) -> Result<()> {
    check_name(branch)?;
    if let Some(u) = upstream {
        check_name(u)?;
    }
    let r = open(repo)?;
    let mut b = r
        .find_branch(branch, BranchType::Local)
        .map_err(|_| Error::msg(format!("No branch named '{branch}'")))?;
    b.set_upstream(upstream)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Remotes (configuration only; talking to them is in `net`)

pub fn add_remote(repo: &Path, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_name(url)?;
    if !git2::Remote::is_valid_name(name) {
        return Err(Error::msg(format!("'{name}' is not a valid remote name")));
    }
    open(repo)?.remote(name, url)?;
    Ok(())
}

pub fn remove_remote(repo: &Path, name: &str) -> Result<()> {
    check_name(name)?;
    open(repo)?.remote_delete(name)?;
    Ok(())
}

pub fn rename_remote(repo: &Path, old: &str, new: &str) -> Result<()> {
    check_name(old)?;
    check_name(new)?;
    if !git2::Remote::is_valid_name(new) {
        return Err(Error::msg(format!("'{new}' is not a valid remote name")));
    }
    open(repo)?.remote_rename(old, new)?;
    Ok(())
}

pub fn set_remote_url(repo: &Path, name: &str, url: &str) -> Result<()> {
    check_name(name)?;
    check_name(url)?;
    let r = open(repo)?;
    r.find_remote(name)?;
    r.remote_set_url(name, url)?;
    Ok(())
}

/// Create a new repository at `path` (created if missing).
pub fn init(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    Repository::init(path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Stashes

pub fn stash_save(repo: &Path, message: Option<&str>, include_untracked: bool) -> Result<()> {
    let mut r = open(repo)?;
    let who = committer(&r)?;
    let flags = if include_untracked { StashFlags::INCLUDE_UNTRACKED } else { StashFlags::DEFAULT };
    match r.stash_save2(&who, message.filter(|m| !m.trim().is_empty()), Some(flags)) {
        Ok(_) => Ok(()),
        Err(e) if e.code() == ErrorCode::NotFound => Err(Error::msg("No local changes to save")),
        Err(e) => Err(e.into()),
    }
}

/// The blob and mode of a work tree file, for a tree.
fn worktree_entry(r: &Repository, root: &Path, path: &str) -> Result<Option<(Oid, u32)>> {
    let full = root.join(path);
    let Ok(meta) = std::fs::symlink_metadata(&full) else { return Ok(None) };
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(&full)?;
        return Ok(Some((r.blob(target.to_string_lossy().as_bytes())?, 0o120000)));
    }
    #[cfg(unix)]
    let exec = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let exec = false;
    Ok(Some((r.blob_path(&full)?, if exec { 0o100755 } else { 0o100644 })))
}

fn entry(path: &str, id: Oid, mode: u32) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Stash only `paths` (their staged, unstaged or untracked changes); the
/// rest of the work stays. Built as git builds a stash (a work tree commit
/// over HEAD, the index and untracked files), so `git stash pop` takes it
/// too. (libgit2's own path-limited stash also drops the other files'
/// changes, so it isn't used.)
pub fn stash_paths(repo: &Path, paths: &[String], message: Option<&str>) -> Result<()> {
    if paths.is_empty() {
        return Err(Error::msg("Pick some files to stash"));
    }
    let r = open(repo)?;
    let head = r.head().ok().and_then(|h| h.peel_to_commit().ok()).ok_or_else(|| Error::msg("Commit something before stashing"))?;
    let head_tree = head.tree()?;
    let root = repos::workdir(&r);
    let who = committer(&r)?;
    let mut index = r.index()?;

    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for p in paths {
        let st = r.status_file(Path::new(p)).map_err(|_| Error::msg(format!("{p} isn't in this repository")))?;
        if st.is_conflicted() {
            return Err(Error::msg(format!("{p} has a conflict; resolve it first")));
        }
        if st.contains(git2::Status::WT_NEW) && !st.intersects(git2::Status::INDEX_NEW | git2::Status::INDEX_MODIFIED) {
            untracked.push(p.as_str());
        } else if !st.is_empty() {
            tracked.push(p.as_str());
        }
    }
    if tracked.is_empty() && untracked.is_empty() {
        return Err(Error::msg("No changes to those files"));
    }

    // The index commit: HEAD with these paths as staged.
    let mut staged = Index::new()?;
    staged.read_tree(&head_tree)?;
    for p in &tracked {
        match index.get_path(Path::new(p), 0) {
            Some(e) => staged.add(&e)?,
            None => {
                let _ = staged.remove_path(Path::new(p));
            }
        }
    }
    let staged_tree = r.find_tree(staged.write_tree_to(&r)?)?;
    // The work tree commit: that, with these paths as on disk.
    let mut work = Index::new()?;
    work.read_tree(&staged_tree)?;
    for p in &tracked {
        match worktree_entry(&r, &root, p)? {
            Some((id, mode)) => work.add(&entry(p, id, mode))?,
            None => {
                let _ = work.remove_path(Path::new(p));
            }
        }
    }
    let work_tree = r.find_tree(work.write_tree_to(&r)?)?;

    let branch = r.head().ok().and_then(|h| h.shorthand().ok().map(str::to_owned)).unwrap_or_else(|| "(no branch)".into());
    let short = &head.id().to_string()[..7];
    let summary = head.summary().ok().flatten().unwrap_or("").to_owned();
    let what = message.filter(|m| !m.trim().is_empty()).map(str::to_owned).unwrap_or_else(|| {
        let names: Vec<&str> = paths.iter().map(|p| p.rsplit('/').next().unwrap_or(p)).take(3).collect();
        format!("{}{}", names.join(", "), if paths.len() > 3 { format!(" and {} more", paths.len() - 3) } else { String::new() })
    });
    let name = format!("On {branch}: {what}");
    let i_commit = r.find_commit(r.commit(None, &who, &who, &format!("index on {branch}: {short} {summary}"), &staged_tree, &[&head])?)?;
    let mut parents = vec![head.clone(), i_commit];
    if !untracked.is_empty() {
        let mut u = Index::new()?;
        for p in &untracked {
            if let Some((id, mode)) = worktree_entry(&r, &root, p)? {
                u.add(&entry(p, id, mode))?;
            }
        }
        let u_tree = r.find_tree(u.write_tree_to(&r)?)?;
        parents.push(r.find_commit(r.commit(None, &who, &who, &format!("untracked files on {branch}: {short} {summary}"), &u_tree, &[])?)?);
    }
    let parent_refs: Vec<&Commit> = parents.iter().collect();
    let w = r.commit(None, &who, &who, &name, &work_tree, &parent_refs)?;
    r.reference("refs/stash", w, true, &name)?;
    let mut log = r.reflog("refs/stash")?;
    if log.get(0).map(|e| e.id_new()) != Some(w) {
        log.append(w, &who, Some(&name))?;
        log.write()?;
    }

    // Saved: take those changes out of the index and the work tree.
    for p in &tracked {
        match head_tree.get_path(Path::new(p)) {
            Ok(e) => index.add(&entry(p, e.id(), e.filemode() as u32))?,
            Err(_) => {
                let _ = index.remove_path(Path::new(p));
            }
        }
    }
    index.write()?;
    for p in &tracked {
        if head_tree.get_path(Path::new(p)).is_ok() {
            r.checkout_head(Some(CheckoutBuilder::new().force().path(p)))?;
        } else {
            let _ = std::fs::remove_file(root.join(p));
        }
    }
    for p in &untracked {
        std::fs::remove_file(root.join(p))?;
    }
    Ok(())
}

pub fn stash_apply(repo: &Path, index: usize, pop: bool) -> Result<()> {
    let mut r = open(repo)?;
    apply_stash(&mut r, index, pop)
}

/// Apply stash `index`; with `pop`, drop it afterwards — but only if it
/// applied cleanly (libgit2's own pop drops it even on conflicts).
pub(crate) fn apply_stash(r: &mut Repository, index: usize, pop: bool) -> Result<()> {
    let mut opts = StashApplyOptions::new();
    match r.stash_apply(index, Some(&mut opts)) {
        Ok(()) => {}
        Err(e) if e.code() == ErrorCode::Conflict => {
            return Err(Error::msg("Your local changes would be overwritten by the stash. Commit or stash them first."));
        }
        // libgit2 can't apply a stash over staged changes (git can).
        Err(e) if e.class() == git2::ErrorClass::Stash && e.message().contains("uncommitted changes exist in the index") => {
            return Err(Error::msg("Unstage or commit your staged changes before applying a stash"));
        }
        Err(e) if e.code() != ErrorCode::MergeConflict => return Err(e.into()),
        Err(_) => {}
    }
    if r.index()?.has_conflicts() {
        return Err(Error::msg("The stash was applied with conflicts; resolve them. The stash was kept."));
    }
    if pop {
        r.stash_drop(index)?;
    }
    Ok(())
}

pub fn stash_drop(repo: &Path, index: usize) -> Result<()> {
    open(repo)?.stash_drop(index)?;
    Ok(())
}

/// Put a dropped stash commit back on the stash list (undo of drop).
pub fn stash_store(repo: &Path, id: &str, message: &str) -> Result<()> {
    let oid = Oid::from_str(id).map_err(|_| Error::msg(format!("Not a commit id: {id}")))?;
    let r = open(repo)?;
    r.find_commit(oid)?;
    r.reference("refs/stash", oid, true, message)?;
    // The stash list is refs/stash's reflog; make sure the entry is there.
    let mut log = r.reflog("refs/stash")?;
    if log.get(0).map(|e| e.id_new()) != Some(oid) {
        log.append(oid, &committer(&r)?, Some(message))?;
        log.write()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reset, cherry-pick, revert, merge and finishing them

pub fn reset(repo: &Path, oid: &str, mode: &str) -> Result<()> {
    // libgit2's reset also deletes a stopped rebase's state; git's doesn't.
    if rebase::in_progress(&open(repo)?) {
        return Err(Error::msg("A rebase is in progress; continue or abort it first"));
    }
    let kind = match mode {
        "soft" => ResetType::Soft,
        "mixed" => ResetType::Mixed,
        "hard" => ResetType::Hard,
        // Moves HEAD but refuses to overwrite local changes: used by undo.
        "keep" => {
            let r = open(repo)?;
            let target = resolve_commit(&r, oid)?;
            safe_checkout(&r, target.as_object())?;
            update_head(&r, target.id(), &format!("reset: moving to {oid}"))?;
            r.cleanup_state()?;
            return Ok(());
        }
        other => return Err(Error::msg(format!("Unknown reset mode {other}"))),
    };
    let r = open(repo)?;
    let target = resolve_commit(&r, oid)?;
    r.reset(target.as_object(), kind, None)?;
    Ok(())
}

fn conflict_list(r: &Repository) -> Result<Vec<String>> {
    let index = r.index()?;
    let mut out = Vec::new();
    for c in index.conflicts()? {
        let c = c?;
        if let Some(e) = c.our.or(c.their).or(c.ancestor) {
            out.push(String::from_utf8_lossy(&e.path).into_owned());
        }
    }
    Ok(out)
}

fn stopped_on_conflicts(r: &Repository, what: &str) -> Result<()> {
    let files = conflict_list(r)?;
    if files.is_empty() {
        return Ok(());
    }
    Err(Error::msg(format!(
        "{what} stopped on conflicts in {}. Resolve them, then continue.",
        files.join(", ")
    )))
}

fn refuse_if_busy(r: &Repository) -> Result<()> {
    if r.state() != RepositoryState::Clean || rebase::in_progress(r) {
        return Err(Error::msg("Another operation is in progress; finish or abort it first"));
    }
    Ok(())
}

/// Translate libgit2's "N conflicts prevent checkout" for the user.
fn local_changes_error(e: git2::Error) -> Error {
    if e.code() == ErrorCode::Conflict || e.class() == git2::ErrorClass::Checkout {
        Error::msg(format!("Your local changes would be overwritten. Commit or stash them first. ({})", e.message()))
    } else {
        e.into()
    }
}

pub fn cherry_pick(repo: &Path, oid: &str) -> Result<()> {
    let r = open(repo)?;
    refuse_if_busy(&r)?;
    let pick = resolve_commit(&r, oid)?;
    if pick.parent_count() > 1 {
        return Err(Error::msg("That is a merge commit; cherry-picking it isn't supported"));
    }
    if let Err(e) = r.cherrypick(&pick, None) {
        let _ = r.cleanup_state();
        return Err(local_changes_error(e));
    }
    stopped_on_conflicts(&r, "Cherry-pick")?;
    finish_operation(&r)
}

pub fn revert(repo: &Path, oid: &str) -> Result<()> {
    let r = open(repo)?;
    refuse_if_busy(&r)?;
    let target = resolve_commit(&r, oid)?;
    if target.parent_count() > 1 {
        return Err(Error::msg("That is a merge commit; reverting it isn't supported"));
    }
    if let Err(e) = r.revert(&target, None) {
        let _ = r.cleanup_state();
        return Err(local_changes_error(e));
    }
    stopped_on_conflicts(&r, "Revert")?;
    finish_operation(&r)
}

/// Revert several commits, newest first, one commit each. Stops at the
/// first that conflicts (left in the work tree, like a single revert).
pub fn revert_many(repo: &Path, ids: &[String]) -> Result<usize> {
    for (n, id) in ids.iter().enumerate() {
        revert(repo, id).map_err(|e| if n == 0 { e } else { Error::msg(format!("Reverted {n} of {}; {e}", ids.len())) })?;
    }
    Ok(ids.len())
}

/// Branch, remote branch or any revision, as git would name it in a merge
/// message.
fn annotated<'r>(r: &'r Repository, rev: &str) -> Result<git2::AnnotatedCommit<'r>> {
    check_name(rev)?;
    for kind in [BranchType::Local, BranchType::Remote] {
        if let Ok(b) = r.find_branch(rev, kind) {
            return Ok(r.reference_to_annotated_commit(b.get())?);
        }
    }
    Ok(r.find_annotated_commit(resolve_commit(r, rev)?.id())?)
}

pub fn merge(repo: &Path, rev: &str) -> Result<()> {
    let r = open(repo)?;
    refuse_if_busy(&r)?;
    let theirs = annotated(&r, rev)?;
    let (analysis, preference) = r.merge_analysis(&[&theirs])?;
    if analysis.is_up_to_date() {
        return Ok(());
    }
    if analysis.is_unborn() || (analysis.is_fast_forward() && !preference.is_no_fast_forward()) {
        let target = r.find_commit(theirs.id())?;
        safe_checkout(&r, target.as_object())?;
        update_head(&r, target.id(), &format!("merge {rev}: Fast-forward"))?;
        hooks::notify(&r, "post-merge", &["0"]);
        return Ok(());
    }
    if preference.is_fastforward_only() {
        return Err(Error::msg("Not possible to fast-forward (merge.ff is set to only)"));
    }
    let mut cb = CheckoutBuilder::new();
    cb.safe().allow_conflicts(true).conflict_style_merge(true);
    if let Err(e) = r.merge(&[&theirs], None, Some(&mut cb)) {
        let _ = r.cleanup_state();
        return Err(local_changes_error(e));
    }
    stopped_on_conflicts(&r, "Merge")?;
    finish_operation(&r)?;
    hooks::notify(&r, "post-merge", &["0"]);
    Ok(())
}

/// The message git would use to finish the stopped operation: MERGE_MSG
/// without the conflict list libgit2 appends to it.
fn pending_message(r: &Repository) -> Result<String> {
    let raw = r.message().unwrap_or_default();
    let mut kept = Vec::new();
    for line in raw.lines() {
        let t = line.trim_start_matches('#').trim();
        if t == "Conflicts:" {
            break;
        }
        kept.push(line);
    }
    Ok(git2::message_prettify(kept.join("\n"), None)?)
}

/// Commit the result of a merge / cherry-pick / revert whose conflicts are
/// resolved (or that had none), and leave the operation.
pub(crate) fn finish_operation(r: &Repository) -> Result<()> {
    let state = r.state();
    let mut index = r.index()?;
    if index.has_conflicts() {
        return Err(Error::msg("Resolve all conflicts first"));
    }
    let head = head_commit(r).ok_or_else(|| Error::msg("No commit to build on"))?;
    let tree = r.find_tree(index.write_tree()?)?;
    let mut parents = vec![head.clone()];
    let (author, kind) = match state {
        RepositoryState::Merge => {
            for id in merge_heads(r)? {
                parents.push(r.find_commit(id)?);
            }
            (author(r)?, "commit (merge)")
        }
        RepositoryState::CherryPick => {
            (r.revparse_single("CHERRY_PICK_HEAD")?.peel_to_commit()?.author().to_owned(), "cherry-pick")
        }
        RepositoryState::Revert => (author(r)?, "revert"),
        _ => return Err(Error::msg("Nothing to continue")),
    };
    if parents.len() == 1 && tree.id() == head.tree_id() {
        r.cleanup_state()?;
        return Err(Error::msg("Nothing changed: those changes are already here"));
    }
    let mut message = pending_message(r)?;
    if state == RepositoryState::Merge {
        message = merge_message_into(r, message);
    }
    if message.trim().is_empty() {
        return Err(Error::msg("The commit message is empty"));
    }
    let refs: Vec<&Commit> = parents.iter().collect();
    let oid = sign::commit(r, &author, &committer(r)?, &message, &tree, &refs)?;
    update_head(r, oid, &format!("{kind}: {}", summary_of(&message)))?;
    r.cleanup_state()?;
    hooks::notify(r, "post-commit", &[]);
    Ok(())
}

/// git names the target branch unless it is main/master:
/// "Merge branch 'x' into feature".
fn merge_message_into(r: &Repository, message: String) -> String {
    let Ok(head) = r.head() else { return message };
    let Some(branch) = head.shorthand().ok().filter(|_| head.is_branch()).map(str::to_owned) else { return message };
    if matches!(branch.as_str(), "main" | "master") {
        return message;
    }
    let mut lines = message.splitn(2, '\n');
    let first = lines.next().unwrap_or("");
    if !first.starts_with("Merge ") || first.contains(" into ") {
        return message;
    }
    match lines.next() {
        Some(rest) => format!("{first} into {branch}\n{rest}"),
        None => format!("{first} into {branch}"),
    }
}

/// Undo a stopped merge / cherry-pick / revert: put back HEAD's version
/// of every file the operation touched, keep unrelated local changes.
pub(crate) fn abort_operation(r: &Repository) -> Result<()> {
    let head = head_commit(r).ok_or_else(|| Error::msg("No commit to go back to"))?;
    let tree = head.tree()?;
    let mut paths = conflict_list(r)?;
    let index = r.index()?;
    let diff = r.diff_tree_to_index(Some(&tree), Some(&index), None)?;
    for d in diff.deltas() {
        for f in [d.old_file().path(), d.new_file().path()].into_iter().flatten() {
            paths.push(f.to_string_lossy().into_owned());
        }
    }
    paths.sort();
    paths.dedup();
    if !paths.is_empty() {
        let mut cb = CheckoutBuilder::new();
        cb.force().disable_pathspec_match(true).remove_untracked(false);
        for p in &paths {
            cb.path(p.as_str());
        }
        r.checkout_tree(tree.as_object(), Some(&mut cb))?;
        let mut index = r.index()?;
        for p in &paths {
            reset_path(&mut index, Some(&tree), p)?;
            // Files the operation added are gone from the index; delete
            // them from the work tree too, as git does.
            if tree.get_path(Path::new(p)).is_err() {
                let full = repos::workdir(r).join(p);
                if std::fs::symlink_metadata(&full).map(|m| !m.is_dir()).unwrap_or(false) {
                    let _ = std::fs::remove_file(full);
                }
            }
        }
        index.write()?;
    }
    r.cleanup_state()?;
    Ok(())
}

/// `continue`, `abort` or `skip` for whatever operation is in progress
/// (`merge`, `rebase`, `cherry-pick`, `revert`).
pub fn sequencer(repo: &Path, op: &str, action: &str) -> Result<()> {
    if !matches!(op, "merge" | "rebase" | "cherry-pick" | "revert") {
        return Err(Error::msg(format!("Unknown operation {op}")));
    }
    if !matches!(action, "continue" | "abort" | "skip") {
        return Err(Error::msg(format!("Unknown action {action}")));
    }
    let r = open(repo)?;
    if op == "rebase" {
        return rebase::sequence(&r, action);
    }
    let expected = match op {
        "merge" => RepositoryState::Merge,
        "cherry-pick" => RepositoryState::CherryPick,
        _ => RepositoryState::Revert,
    };
    if r.state() != expected {
        return Err(Error::msg(format!("No {op} is in progress")));
    }
    match action {
        "continue" => finish_operation(&r),
        "abort" => abort_operation(&r),
        _ if op == "merge" => Err(Error::msg("A merge can't be skipped; abort it instead")),
        // A single cherry-pick or revert: skipping it is aborting it.
        _ => abort_operation(&r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_are_recounted_and_reversed() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3,9 +3,9 @@\n ctx\n-old\n+new\n+more\n";
        let fwd = prepare_patch(patch, false).unwrap();
        assert!(fwd.contains("@@ -3,2 +3,3 @@\n ctx\n-old\n+new\n+more\n"), "{fwd}");
        let rev = prepare_patch(patch, true).unwrap();
        assert!(rev.contains("@@ -3,3 +3,2 @@\n ctx\n+old\n-new\n-more\n"), "{rev}");

        let renamed = "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1,1 +1,1 @@\n-a\n+b\n";
        let rev = prepare_patch(renamed, true).unwrap();
        assert!(rev.starts_with("diff --git a/new b/old\n--- a/new\n+++ b/old\n"), "{rev}");
    }

    #[test]
    fn no_newline_markers_survive() {
        let patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n";
        let out = prepare_patch(patch, false).unwrap();
        assert!(out.contains("@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n"), "{out}");
    }
}

/// Put a suggested change into a work tree file: lines `from`..=`to`
/// (1-based) become `text`. The suggestion was made on the committed
/// file, so a file with uncommitted changes is left alone.
pub fn apply_suggestion(r: &Repository, path: &str, from: usize, to: usize, text: &str) -> Result<()> {
    let status = r.status_file(Path::new(path)).map_err(|_| Error::msg(format!("{path} isn't in this repository")))?;
    if !status.is_empty() {
        return Err(Error::msg(format!("{path} has uncommitted changes; commit or stash them first")));
    }
    let full = repos::workdir(r).join(path);
    let content = std::fs::read_to_string(&full).map_err(|e| Error::msg(format!("Can't read {path}: {e}")))?;
    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let ends = content.ends_with('\n');
    let mut lines: Vec<&str> = content.lines().collect();
    if from == 0 || from > to || to > lines.len() {
        return Err(Error::msg(format!("{path} has no lines {from}–{to}; is the request's branch checked out?")));
    }
    let new: Vec<&str> = if text.is_empty() { Vec::new() } else { text.lines().collect() };
    lines.splice(from - 1..to, new);
    let mut out = lines.join(newline);
    if ends && !out.is_empty() {
        out.push_str(newline);
    }
    std::fs::write(&full, out)?;
    Ok(())
}
