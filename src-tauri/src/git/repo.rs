use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryState};
use serde::Serialize;

use crate::error::{Error, Result};

/// `~` and `~/…` typed by the user mean the home directory.
pub fn expand_home(path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else { return path.to_path_buf() };
    let rest = if s == "~" { Some("") } else { s.strip_prefix("~/") };
    match (rest, std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_path_buf(),
    }
}

pub fn open(path: &Path) -> Result<Repository> {
    let repo = Repository::discover(expand_home(path))?;
    if repo.is_bare() {
        return Err(Error::msg("Bare repositories are not supported"));
    }
    Ok(repo)
}

pub fn workdir(repo: &Repository) -> PathBuf {
    repo.workdir().expect("non-bare repo has a workdir").to_path_buf()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    /// Short branch name, or `None` when HEAD is detached or unborn.
    pub head_branch: Option<String>,
    pub head_oid: Option<String>,
    pub detached: bool,
    /// No commits yet.
    pub unborn: bool,
    /// `clean`, `merge`, `rebase`, `cherry-pick`, `revert`, `bisect`, ...
    pub state: &'static str,
    pub upstream: Option<String>,
    pub ahead: usize,
    pub behind: usize,
}

fn state_name(s: RepositoryState) -> &'static str {
    match s {
        RepositoryState::Clean => "clean",
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "am",
    }
}

pub fn info(repo: &Repository) -> Result<RepoInfo> {
    let path = workdir(repo);
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());

    let detached = repo.head_detached().unwrap_or(false);
    let (head_branch, head_oid, unborn) = match repo.head() {
        Ok(head) => (
            if detached { None } else { head.shorthand().ok().map(str::to_owned) },
            head.target().map(|o| o.to_string()),
            false,
        ),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
            // HEAD points at refs/heads/<name> that doesn't exist yet.
            let name = repo
                .find_reference("HEAD")
                .ok()
                .and_then(|r| r.symbolic_target().ok().flatten().map(str::to_owned))
                .map(|t| t.trim_start_matches("refs/heads/").to_owned());
            (name, None, true)
        }
        Err(e) => return Err(e.into()),
    };

    let mut upstream = None;
    let (mut ahead, mut behind) = (0, 0);
    if let Some(branch) = head_branch.as_deref().filter(|_| !unborn) {
        if let Ok(local) = repo.find_branch(branch, git2::BranchType::Local) {
            if let Ok(up) = local.upstream() {
                upstream = up.name().ok().flatten().map(str::to_owned);
                if let (Some(l), Some(u)) = (local.get().target(), up.get().target()) {
                    (ahead, behind) = repo.graph_ahead_behind(l, u)?;
                }
            }
        }
    }

    Ok(RepoInfo {
        path: path.to_string_lossy().into_owned(),
        name,
        head_branch,
        head_oid,
        detached,
        unborn,
        state: state_name(repo.state()),
        upstream,
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_home() {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        assert_eq!(expand_home(Path::new("~/codes/x")), home.join("codes/x"));
        assert_eq!(expand_home(Path::new("~")), home);
        assert_eq!(expand_home(Path::new("/abs/~/x")), PathBuf::from("/abs/~/x"));
        assert_eq!(expand_home(Path::new("~user/x")), PathBuf::from("~user/x"));
    }
}
