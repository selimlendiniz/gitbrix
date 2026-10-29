//! Talking to remotes through libgit2: fetch, pull, push, clone and
//! submodules. https remotes log in with an account's access token (see
//! `accounts`) or `~/.git-credentials`; ssh remotes go through the
//! system's `ssh` (see `ssh`).

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use git2::build::{CheckoutBuilder, RepoBuilder};
use git2::{
    AutotagOption, BranchType, Cred, CredentialType, Direction, ErrorCode, FetchOptions, FetchPrune, Oid, PushOptions,
    RemoteCallbacks, Repository, SubmoduleUpdateOptions,
};

use super::{hooks, ops, rebase, repo as repos, ssh};
use crate::accounts;
use crate::error::{Error, Result};

/// Progress callback for long-running network operations.
pub type Progress<'a> = &'a mut dyn FnMut(&str);

type Shared<'a, 'p> = &'a RefCell<&'p mut dyn FnMut(&str)>;

#[derive(Default)]
struct Auth {
    /// Credentials were handed out once already (asked again = rejected).
    tried: bool,
    /// The URL we had no credentials for.
    missing: Option<String>,
}

fn open(path: &Path) -> Result<Repository> {
    let r = repos::open(path)?;
    prepare(Some(&r));
    Ok(r)
}

fn prepare(r: Option<&Repository>) {
    ssh::register();
    ssh::set_command(r.and_then(|r| r.config().ok()).and_then(|c| c.get_string("core.sshCommand").ok()));
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Credentials saved by git's `store` helper (`~/.git-credentials`).
fn stored_credentials(url: &str) -> Option<(String, String)> {
    let (scheme, host, _) = accounts::split_url(url)?;
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    for file in [home.join(".git-credentials"), config.join("git/credentials")] {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        for line in text.lines() {
            let Some((s, rest)) = line.trim().split_once("://") else { continue };
            let Some((userinfo, hostpart)) = rest.split('/').next().and_then(|a| a.rsplit_once('@')) else { continue };
            let Some((user, pass)) = userinfo.split_once(':') else { continue };
            if s.eq_ignore_ascii_case(&scheme) && hostpart.eq_ignore_ascii_case(&host) {
                return Some((percent_decode(user), percent_decode(pass)));
            }
        }
    }
    None
}

fn callbacks<'a, 'p>(progress: Shared<'a, 'p>, auth: &'a RefCell<Auth>) -> RemoteCallbacks<'a> {
    let mut cb = RemoteCallbacks::new();
    cb.credentials(move |url, username, allowed| {
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            let mut a = auth.borrow_mut();
            if a.tried {
                return Err(git2::Error::from_str("authentication failed"));
            }
            a.tried = true;
            match accounts::credentials_for(url).or_else(|| stored_credentials(url)) {
                Some((user, token)) => Cred::userpass_plaintext(&user, &token),
                None => {
                    a.missing = Some(url.to_owned());
                    Err(git2::Error::from_str("no credentials for this host"))
                }
            }
        } else if allowed.contains(CredentialType::USERNAME) {
            Cred::username(username.unwrap_or("git"))
        } else {
            Err(git2::Error::from_str("unsupported authentication method"))
        }
    });
    cb.transfer_progress(move |stats| {
        let line = if stats.received_objects() < stats.total_objects() {
            let pct = stats.received_objects() * 100 / stats.total_objects().max(1);
            format!(
                "Receiving objects: {pct}% ({}/{}), {} KiB",
                stats.received_objects(),
                stats.total_objects(),
                stats.received_bytes() / 1024
            )
        } else if stats.total_deltas() > 0 {
            let pct = stats.indexed_deltas() * 100 / stats.total_deltas().max(1);
            let done = if stats.indexed_deltas() == stats.total_deltas() { ", done." } else { "" };
            format!("Resolving deltas: {pct}% ({}/{}){done}", stats.indexed_deltas(), stats.total_deltas())
        } else {
            return true;
        };
        (progress.borrow_mut())(&line);
        true
    });
    // Remote messages arrive in packets that may cut a line anywhere;
    // pass on whole lines only.
    let mut pending = String::new();
    cb.sideband_progress(move |data| {
        pending.push_str(&String::from_utf8_lossy(data));
        while let Some(end) = pending.find(['\r', '\n']) {
            let line: String = pending.drain(..=end).collect();
            if !line.trim().is_empty() {
                (progress.borrow_mut())(&format!("remote: {}", line.trim()));
            }
        }
        true
    });
    cb.push_transfer_progress(move |current, total, _bytes| {
        if total > 0 {
            (progress.borrow_mut())(&format!("Writing objects: {}% ({current}/{total})", current * 100 / total));
        }
    });
    cb
}

fn host_of(url: &str) -> String {
    accounts::split_url(url)
        .map(|(_, h, _)| h)
        .or_else(|| ssh::parse_url(url).map(|(h, _, _)| h.rsplit('@').next().unwrap_or(&h).to_owned()))
        .unwrap_or_else(|| url.to_owned())
}

fn net_error(e: git2::Error, auth: &RefCell<Auth>, url: &str) -> Error {
    let a = auth.borrow();
    if let Some(u) = &a.missing {
        return Error::msg(format!(
            "{} needs a login. Add a GitHub or GitLab account with an access token in Settings → Accounts.",
            host_of(u)
        ));
    }
    let msg = e.message().to_ascii_lowercase();
    if a.tried && (e.code() == ErrorCode::Auth || msg.contains("auth") || msg.contains("401") || msg.contains("403")) {
        return Error::msg(format!(
            "{} rejected the access token. Check that it is still valid and allows repository access (Settings → Accounts).",
            host_of(url)
        ));
    }
    if e.code() == ErrorCode::NotFastForward {
        return Error::msg("The remote has commits you don't have. Pull first, or force push.");
    }
    e.into()
}

// ---------------------------------------------------------------------------
// Fetch and pull

fn fetch_one(r: &Repository, name: &str, progress: Shared) -> Result<()> {
    fetch_refspecs(r, name, &[], progress)
}

/// Fetch `refspecs` from remote `name`, or its configured ones when empty
/// (then pruning deleted branches and taking all tags).
fn fetch_refspecs(r: &Repository, name: &str, refspecs: &[&str], progress: Shared) -> Result<()> {
    let mut remote = r.find_remote(name).map_err(|_| Error::msg(format!("No remote named '{name}'")))?;
    let url = remote.url().unwrap_or("").to_owned();
    let auth = RefCell::new(Auth::default());
    let mut fo = FetchOptions::new();
    fo.remote_callbacks(callbacks(progress, &auth));
    if refspecs.is_empty() {
        fo.prune(FetchPrune::On).download_tags(AutotagOption::All);
    }
    remote.fetch(refspecs, Some(&mut fo), None).map_err(|e| net_error(e, &auth, &url))?;
    Ok(())
}

/// Fetch every remote (pruning deleted branches, with all tags).
pub fn fetch(repo: &Path, progress: Progress) -> Result<()> {
    let r = open(repo)?;
    let progress = RefCell::new(progress);
    let mut errors = Vec::new();
    for name in r.remotes()?.iter().flatten().flatten() {
        if let Err(e) = fetch_one(&r, name, &progress) {
            errors.push(format!("{name}: {e}"));
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(Error::msg(errors.join("\n"))) }
}

pub fn fetch_remote(repo: &Path, remote: &str, progress: Progress) -> Result<()> {
    ops::check_name(remote)?;
    let r = open(repo)?;
    fetch_one(&r, remote, &RefCell::new(progress))
}

/// Check out the head of a pull/merge request from a fork on a local
/// branch (`pr/12` for GitHub, `mr/12` for GitLab), creating it or moving
/// it forward to the request's latest commit. Returns the branch name.
pub fn checkout_pull_request(repo: &Path, remote: &str, provider: &str, number: u64, progress: Progress) -> Result<String> {
    ops::check_name(remote)?;
    let (head_ref, branch) = match provider {
        "github" => (format!("refs/pull/{number}/head"), format!("pr/{number}")),
        "gitlab" => (format!("refs/merge-requests/{number}/head"), format!("mr/{number}")),
        other => return Err(Error::msg(format!("Unknown provider {other}"))),
    };
    {
        let r = open(repo)?;
        fetch_refspecs(&r, remote, &[&head_ref], &RefCell::new(progress))?;
        // The fetched commit is FETCH_HEAD's only entry.
        let mut tip = None;
        r.fetchhead_foreach(|_, _, oid, _| {
            tip = Some(*oid);
            false
        })
        .or_else(|e| if tip.is_some() { Ok(()) } else { Err(e) })?;
        let tip = tip.ok_or_else(|| Error::msg(format!("{remote} has no {head_ref}")))?;
        let commit = r.find_commit(tip)?;
        match r.find_branch(&branch, BranchType::Local) {
            Err(_) => {
                r.branch(&branch, &commit, false)?;
            }
            Ok(existing) => {
                let current = existing.get().target().unwrap_or(tip);
                if current != tip {
                    if existing.is_head() {
                        return Err(Error::msg(format!("{branch} is checked out; switch to another branch to update it")));
                    }
                    if !r.graph_descendant_of(tip, current)? {
                        return Err(Error::msg(format!("{branch} has commits the request doesn't; rename or delete it first")));
                    }
                    r.reference(&format!("refs/heads/{branch}"), tip, true, &format!("gitbrix: update {branch} from {remote}"))?;
                }
            }
        }
    }
    ops::checkout_branch(repo, &branch)?;
    Ok(branch)
}

/// The current branch, its upstream's remote, and the upstream branch ref
/// on that remote (`refs/heads/main`), from the branch's config.
fn current_upstream(r: &Repository) -> Result<(String, Option<(String, String)>)> {
    let head = r.head().map_err(|_| Error::msg("There are no commits yet"))?;
    if !head.is_branch() {
        return Err(Error::msg("HEAD is detached; check out a branch first"));
    }
    let branch = head.shorthand()?.to_owned();
    let cfg = r.config()?;
    let remote = cfg.get_string(&format!("branch.{branch}.remote")).ok();
    let merge = cfg.get_string(&format!("branch.{branch}.merge")).ok();
    Ok((branch, remote.zip(merge)))
}

pub fn pull(repo: &Path, mode: &str, progress: Progress) -> Result<()> {
    if !matches!(mode, "ff-only" | "rebase" | "merge") {
        return Err(Error::msg(format!("Unknown pull mode {mode}")));
    }
    let r = open(repo)?;
    let (branch, upstream) = current_upstream(&r)?;
    let (remote, merge) =
        upstream.ok_or_else(|| Error::msg(format!("'{branch}' has no upstream branch to pull from")))?;
    if remote == "." {
        return Err(Error::msg("The upstream is a local branch; merge it instead"));
    }
    fetch_one(&r, &remote, &RefCell::new(progress))?;
    let short = merge.strip_prefix("refs/heads/").unwrap_or(&merge);
    let upstream = format!("{remote}/{short}");
    let tracking = r
        .find_reference(&format!("refs/remotes/{upstream}"))
        .map_err(|_| Error::msg(format!("{upstream} doesn't exist on the remote")))?;
    match mode {
        "ff-only" => {
            let theirs = r.reference_to_annotated_commit(&tracking)?;
            let (analysis, _) = r.merge_analysis(&[&theirs])?;
            if analysis.is_up_to_date() {
                return Ok(());
            }
            if !analysis.is_fast_forward() {
                return Err(Error::msg(format!(
                    "'{branch}' and {upstream} have diverged; pull with merge or rebase instead"
                )));
            }
            let target = r.find_commit(theirs.id())?;
            ops::safe_checkout(&r, target.as_object())?;
            ops::update_head(&r, target.id(), &format!("pull: Fast-forward to {upstream}"))?;
            hooks::notify(&r, "post-merge", &["0"]);
            Ok(())
        }
        "merge" => ops::merge(repo, &upstream),
        _ => rebase::onto(&r, &upstream),
    }
}

// ---------------------------------------------------------------------------
// Push

/// One ref update: `local` (None deletes) to `remote_ref` on the remote.
struct Update {
    local: Option<String>,
    remote_ref: String,
    force: bool,
}

/// What we last saw `remote_ref` at (its remote-tracking ref).
fn tracking_value(r: &Repository, remote: &str, remote_ref: &str) -> Option<Oid> {
    let short = remote_ref.strip_prefix("refs/heads/")?;
    r.refname_to_id(&format!("refs/remotes/{remote}/{short}")).ok()
}

fn push_updates(r: &Repository, remote_name: &str, updates: &[Update], progress: Progress) -> Result<()> {
    ops::check_name(remote_name)?;
    let mut remote = r.find_remote(remote_name).map_err(|_| Error::msg(format!("No remote named '{remote_name}'")))?;
    let url = remote.url().unwrap_or("").to_owned();
    let progress = RefCell::new(progress);

    // Force pushes are "with lease": refuse if the remote moved since we
    // last fetched, so nobody's work is overwritten unseen.
    if updates.iter().any(|u| u.force) {
        let auth = RefCell::new(Auth::default());
        let connection = remote
            .connect_auth(Direction::Push, Some(callbacks(&progress, &auth)), None)
            .map_err(|e| net_error(e, &auth, &url))?;
        let heads: Vec<(String, Oid)> =
            connection.list()?.iter().map(|h| (h.name().to_owned(), h.oid())).collect();
        drop(connection);
        for u in updates.iter().filter(|u| u.force) {
            let actual = heads.iter().find(|(n, _)| *n == u.remote_ref).map(|(_, o)| *o);
            if actual != tracking_value(r, remote_name, &u.remote_ref) {
                return Err(Error::msg(format!(
                    "{} changed on {remote_name} since you last fetched. Fetch and look at it before force pushing.",
                    u.remote_ref.trim_start_matches("refs/heads/")
                )));
            }
        }
    }

    let zero = Oid::ZERO_SHA1.to_string();
    let mut specs = Vec::new();
    let mut hook_input = String::new();
    for u in updates {
        let local_id = match &u.local {
            Some(l) => r.refname_to_id(l).map_err(|_| Error::msg(format!("{l} doesn't exist")))?.to_string(),
            None => zero.clone(),
        };
        let remote_id = tracking_value(r, remote_name, &u.remote_ref).map(|o| o.to_string()).unwrap_or_else(|| zero.clone());
        hook_input.push_str(&format!(
            "{} {local_id} {} {remote_id}\n",
            u.local.as_deref().unwrap_or("(delete)"),
            u.remote_ref
        ));
        specs.push(format!("{}{}:{}", if u.force { "+" } else { "" }, u.local.as_deref().unwrap_or(""), u.remote_ref));
    }
    hooks::run(r, "pre-push", &[remote_name, &url], Some(&hook_input))?;

    let auth = RefCell::new(Auth::default());
    let rejected = RefCell::new(Vec::new());
    let mut cb = callbacks(&progress, &auth);
    cb.push_update_reference(|refname, status| {
        if let Some(s) = status {
            rejected.borrow_mut().push(format!("{}: {s}", refname.trim_start_matches("refs/heads/")));
        }
        Ok(())
    });
    let mut po = PushOptions::new();
    po.remote_callbacks(cb);
    remote.push(&specs, Some(&mut po)).map_err(|e| net_error(e, &auth, &url))?;
    drop(po);
    let rejected = rejected.into_inner();
    if !rejected.is_empty() {
        return Err(Error::msg(format!("{remote_name} rejected the push: {}", rejected.join("; "))));
    }
    Ok(())
}

fn set_tracking(r: &Repository, branch: &str, remote: &str, merge: &str) -> Result<()> {
    let mut cfg = r.config()?;
    cfg.set_str(&format!("branch.{branch}.remote"), remote)?;
    cfg.set_str(&format!("branch.{branch}.merge"), merge)?;
    Ok(())
}

/// Push the current branch. Without an upstream, publish it to `origin`
/// (or the only remote) under the same name and start tracking it.
pub fn push(repo: &Path, force: bool, progress: Progress) -> Result<()> {
    let r = open(repo)?;
    let (branch, upstream) = current_upstream(&r)?;
    let local = format!("refs/heads/{branch}");
    match upstream {
        Some((remote, merge)) if remote != "." => {
            push_updates(&r, &remote, &[Update { local: Some(local), remote_ref: merge, force }], progress)
        }
        _ => {
            let remotes: Vec<String> = r.remotes()?.iter().flatten().flatten().map(str::to_owned).collect();
            let remote = if remotes.iter().any(|n| n == "origin") {
                "origin".to_owned()
            } else if let [only] = remotes.as_slice() {
                only.clone()
            } else if remotes.is_empty() {
                return Err(Error::msg("This repository has no remotes"));
            } else {
                return Err(Error::msg("No upstream set and no 'origin' remote"));
            };
            push_updates(&r, &remote, &[Update { local: Some(local.clone()), remote_ref: local.clone(), force }], progress)?;
            set_tracking(&r, &branch, &remote, &local)
        }
    }
}

/// Push a local branch to `remote` under the same name and track it.
pub fn push_branch(repo: &Path, remote: &str, branch: &str, force: bool, progress: Progress) -> Result<()> {
    ops::check_name(branch)?;
    let r = open(repo)?;
    let local = format!("refs/heads/{branch}");
    push_updates(&r, remote, &[Update { local: Some(local.clone()), remote_ref: local.clone(), force }], progress)?;
    set_tracking(&r, branch, remote, &local)
}

pub fn push_tag(repo: &Path, remote: &str, tag: &str, delete: bool, progress: Progress) -> Result<()> {
    ops::check_name(tag)?;
    let r = open(repo)?;
    let name = format!("refs/tags/{tag}");
    let local = (!delete).then(|| name.clone());
    push_updates(&r, remote, &[Update { local, remote_ref: name, force: false }], progress)
}

pub fn delete_remote_branch(repo: &Path, remote: &str, branch: &str) -> Result<()> {
    ops::check_name(branch)?;
    let r = open(repo)?;
    let update = Update { local: None, remote_ref: format!("refs/heads/{branch}"), force: false };
    push_updates(&r, remote, &[update], &mut |_| {})?;
    // libgit2 leaves the remote-tracking branch behind; git removes it.
    if let Ok(mut tracking) = r.find_reference(&format!("refs/remotes/{remote}/{branch}")) {
        tracking.delete()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Clone and submodules

fn is_local(url: &str) -> bool {
    !url.contains("://") && ssh::parse_url(url).is_none()
}

/// Clone `url` into `parent/name`. Returns the new work tree path.
pub fn clone(parent: &Path, url: &str, name: &str, progress: Progress) -> Result<PathBuf> {
    if url.starts_with('-') || name.is_empty() || name.starts_with('-') || name.contains('/') {
        return Err(Error::msg("Invalid URL or folder name"));
    }
    let dest = parent.join(name);
    if dest.exists() && dest.read_dir().map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(Error::msg(format!("{} already exists and is not empty", dest.display())));
    }
    if is_local(url) && !repos::expand_home(Path::new(url)).exists() {
        return Err(Error::msg(format!("Repository {url} does not exist")));
    }
    prepare(None);
    let created = !dest.exists();
    progress(&format!("Cloning into '{name}'..."));
    let progress = RefCell::new(progress);
    let auth = RefCell::new(Auth::default());
    let result = {
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(&progress, &auth));
        let mut co = CheckoutBuilder::new();
        co.progress(|_, done, total| {
            if total > 0 {
                (progress.borrow_mut())(&format!("Checking out files: {}% ({done}/{total})", done * 100 / total));
            }
        });
        RepoBuilder::new().fetch_options(fo).with_checkout(co).clone(url, &dest).map(|_| ())
    };
    if let Err(e) = result {
        if created {
            let _ = std::fs::remove_dir_all(&dest);
        }
        return Err(net_error(e, &auth, url));
    }
    Ok(dest)
}

fn update_submodules(r: &Repository, progress: Shared) -> Result<()> {
    for mut sm in r.submodules()? {
        let url = sm.url().ok().flatten().unwrap_or("").to_owned();
        let auth = RefCell::new(Auth::default());
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(callbacks(progress, &auth));
        let mut opts = SubmoduleUpdateOptions::new();
        opts.fetch(fo);
        sm.update(true, Some(&mut opts)).map_err(|e| net_error(e, &auth, &url))?;
        if let Ok(sub) = sm.open() {
            update_submodules(&sub, progress)?;
        }
    }
    Ok(())
}

/// Initialise and check out submodules at the recorded commits.
pub fn submodule_update(repo: &Path, progress: Progress) -> Result<()> {
    let r = open(repo)?;
    update_submodules(&r, &RefCell::new(progress))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_stored_credentials() {
        assert_eq!(percent_decode("p%40ss%3Aw"), "p@ss:w");
        assert_eq!(percent_decode("plain%"), "plain%");
    }

    #[test]
    fn names_hosts_in_messages() {
        assert_eq!(host_of("https://tok@gitlab.example.com/a/b.git"), "gitlab.example.com");
        assert_eq!(host_of("git@github.com:o/r.git"), "github.com");
    }
}
