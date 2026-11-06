//! Profiles: separate identities, e.g. work and personal. A profile gives
//! the name and email commits are made with and limits which accounts are
//! used. One profile is active; folder rules pick another one for the
//! repositories under a folder (`~/work` → work profile).
//!
//! A repository's own `user.name` / `user.email` (or the GIT_AUTHOR_*
//! environment) still wins over any profile: it was set on purpose.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use git2::{ConfigLevel, Repository};
use serde::{Deserialize, Serialize};

use crate::accounts::Account;
use crate::error::{Error, Result};
use crate::git::repo::expand_home;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    pub id: String,
    /// What the user calls it ("Work").
    pub name: String,
    pub user_name: String,
    pub user_email: String,
    /// Repositories under these folders use this profile.
    pub folders: Vec<String>,
    /// Account ids this profile may use; empty means all of them.
    pub accounts: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profiles {
    /// The profile used outside the folder rules; none = plain git config.
    pub active: Option<String>,
    pub list: Vec<Profile>,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();
/// Read on every commit and network call; cached after the first read.
static CACHE: Mutex<Option<Profiles>> = Mutex::new(None);

pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("profiles.json"))
}

pub fn load() -> Profiles {
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(p) = cache.as_ref() {
        return p.clone();
    }
    let loaded = file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    *cache = Some(loaded);
    cache.clone().unwrap_or_default()
}

/// Use these profiles without a file (tests).
#[cfg(test)]
pub fn set_cached(profiles: Profiles) {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(profiles);
}

pub fn save(mut profiles: Profiles) -> Result<Profiles> {
    for p in &mut profiles.list {
        p.name = p.name.trim().to_owned();
        p.user_name = p.user_name.trim().to_owned();
        p.user_email = p.user_email.trim().to_owned();
        p.folders = p.folders.iter().map(|f| f.trim().trim_end_matches('/').to_owned()).filter(|f| !f.is_empty()).collect();
        if p.name.is_empty() {
            return Err(Error::msg("Give every profile a name"));
        }
        if p.user_name.is_empty() || p.user_email.is_empty() {
            return Err(Error::msg(format!("Profile \"{}\" needs a name and an email for commits", p.name)));
        }
    }
    if profiles.active.as_ref().is_some_and(|a| !profiles.list.iter().any(|p| &p.id == a)) {
        profiles.active = None;
    }
    let file = file().ok_or_else(|| Error::msg("No place to store profiles"))?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(&profiles).map_err(|e| Error::msg(e.to_string()))?;
    std::fs::write(file, json)?;
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(profiles.clone());
    Ok(profiles)
}

/// The profile for a repository: the folder rule with the longest folder
/// that contains it, else the active profile. Without a repository (the
/// account-wide request list) the active one.
pub fn pick<'a>(profiles: &'a Profiles, repo: Option<&Path>) -> Option<&'a Profile> {
    let by_folder = repo.and_then(|repo| {
        profiles
            .list
            .iter()
            .flat_map(|p| p.folders.iter().map(move |f| (p, expand_home(Path::new(f)))))
            .filter(|(_, folder)| repo.starts_with(folder))
            .max_by_key(|(_, folder)| folder.components().count())
            .map(|(p, _)| p)
    });
    by_folder.or_else(|| profiles.list.iter().find(|p| Some(&p.id) == profiles.active.as_ref()))
}

pub fn for_repo(repo: Option<&Path>) -> Option<Profile> {
    pick(&load(), repo).cloned()
}

/// The accounts a repository's profile may use.
/// Ids of accounts removed since are ignored; if none of the profile's
/// accounts are left it uses them all, as when none were picked.
pub fn allowed(accounts: Vec<Account>, repo: Option<&Path>) -> Vec<Account> {
    let Some(p) = for_repo(repo) else { return accounts };
    if !accounts.iter().any(|a| p.accounts.contains(&a.id)) {
        return accounts;
    }
    accounts.into_iter().filter(|a| p.accounts.contains(&a.id)).collect()
}

/// Who commits in `r`, and why.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
    /// `environment`, `repository`, `profile` or `git config`.
    pub source: &'static str,
    /// The profile's name when `source` is `profile`.
    pub profile: Option<String>,
}

fn local_identity(r: &Repository) -> Option<(String, String)> {
    let cfg = r.config().ok()?;
    let local = cfg.open_level(ConfigLevel::Local).ok();
    let worktree = cfg.open_level(ConfigLevel::Worktree).ok();
    let get = |key: &str| {
        [worktree.as_ref(), local.as_ref()].into_iter().flatten().find_map(|c| c.get_string(key).ok())
    };
    Some((get("user.name")?, get("user.email")?))
}

/// The profile identity to commit with in `r`, unless the repository or
/// the environment says otherwise.
pub fn signature_override(r: &Repository) -> Option<(String, String)> {
    if std::env::var_os("GIT_AUTHOR_NAME").is_some() || std::env::var_os("GIT_COMMITTER_NAME").is_some() {
        return None;
    }
    if local_identity(r).is_some() {
        return None;
    }
    let p = for_repo(r.workdir())?;
    Some((p.user_name, p.user_email))
}

pub fn identity(r: &Repository) -> Identity {
    if let (Ok(name), Ok(email)) = (std::env::var("GIT_AUTHOR_NAME"), std::env::var("GIT_AUTHOR_EMAIL")) {
        return Identity { name: Some(name), email: Some(email), source: "environment", profile: None };
    }
    if let Some((name, email)) = local_identity(r) {
        return Identity { name: Some(name), email: Some(email), source: "repository", profile: None };
    }
    if let Some(p) = for_repo(r.workdir()) {
        return Identity { name: Some(p.user_name), email: Some(p.user_email), source: "profile", profile: Some(p.name) };
    }
    let cfg = r.config().ok();
    let get = |k: &str| cfg.as_ref().and_then(|c| c.get_string(k).ok());
    Identity { name: get("user.name"), email: get("user.email"), source: "git config", profile: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, folders: &[&str], accounts: &[&str]) -> Profile {
        Profile {
            id: id.into(),
            name: id.into(),
            user_name: format!("{id} user"),
            user_email: format!("{id}@example.com"),
            folders: folders.iter().map(|s| s.to_string()).collect(),
            accounts: accounts.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn folders_pick_the_profile_before_the_active_one() {
        let all = Profiles {
            active: Some("home".into()),
            list: vec![
                profile("home", &[], &[]),
                profile("work", &["/src/work"], &[]),
                profile("infra", &["/src/work/infra"], &[]),
            ],
        };
        let id = |p: &str| pick(&all, Some(Path::new(p))).map(|p| p.id.as_str());
        assert_eq!(id("/src/work/app"), Some("work"));
        assert_eq!(id("/src/work/infra/tools"), Some("infra"));
        // Path components, not text: /src/workshop isn't under /src/work.
        assert_eq!(id("/src/workshop"), Some("home"));
        assert_eq!(pick(&all, None).map(|p| p.id.as_str()), Some("home"));
        assert_eq!(pick(&Profiles { active: None, ..all.clone() }, Some(Path::new("/x"))), None);
    }

    #[test]
    fn home_folders_expand() {
        let home = crate::host::home_dir().unwrap();
        let all = Profiles { active: None, list: vec![profile("work", &["~/work"], &[])] };
        assert!(pick(&all, Some(&home.join("work/app"))).is_some());
    }
}
