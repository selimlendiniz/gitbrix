//! GitHub / GitLab accounts: an access token per host, used as the
//! password for https remotes on that host. Tokens live in the system
//! keyring (Secret Service: KWallet, GNOME Keyring); the account list
//! itself (no secrets) in the app's config directory.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

const SERVICE: &str = "gitbrix";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    /// `github` or `gitlab`.
    pub provider: String,
    /// Where the service lives, e.g. `https://github.com` or a self-hosted
    /// GitLab such as `https://gitlab.example.com`.
    pub url: String,
    /// The login the token belongs to.
    pub username: String,
    pub name: Option<String>,
}

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the account list is kept; set once at startup.
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

fn list_file() -> Option<PathBuf> {
    DIR.get().map(|d| d.join("accounts.json"))
}

pub fn list() -> Result<Vec<Account>> {
    let Some(file) = list_file() else { return Ok(Vec::new()) };
    match std::fs::read_to_string(file) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| Error::msg(format!("Unreadable account list: {e}"))),
        Err(_) => Ok(Vec::new()),
    }
}

fn save(accounts: &[Account]) -> Result<()> {
    let file = list_file().ok_or_else(|| Error::msg("No place to store accounts"))?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(accounts).map_err(|e| Error::msg(e.to_string()))?;
    std::fs::write(file, json)?;
    Ok(())
}

fn entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, id).map_err(keyring_error)
}

fn keyring_error(e: keyring::Error) -> Error {
    Error::msg(format!("System keyring: {e}"))
}

/// `https://Host:8443/group/` → (`https`, `host:8443`, `/group`).
pub fn split_url(url: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = url.trim().split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return None;
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    // Drop any user:password@ the remote URL carries.
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority).to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some((scheme, host, path.trim_end_matches('/').to_owned()))
}

fn normalize(url: &str) -> Result<String> {
    let (scheme, host, path) =
        split_url(url).ok_or_else(|| Error::msg("Enter the service's address, like https://gitlab.example.com"))?;
    Ok(format!("{scheme}://{host}{path}"))
}

/// Ask the service who the token belongs to; this also proves it works.
fn whoami(provider: &str, url: &str, token: &str) -> Result<(String, Option<String>)> {
    let (_, host, _) = split_url(url).ok_or_else(|| Error::msg("Invalid address"))?;
    let (api, auth_header, auth_value, login_key) = match provider {
        "github" => {
            let api = if host == "github.com" { "https://api.github.com/user".to_owned() } else { format!("{url}/api/v3/user") };
            (api, "Authorization", format!("Bearer {token}"), "login")
        }
        "gitlab" => (format!("{url}/api/v4/user"), "PRIVATE-TOKEN", token.to_owned(), "username"),
        other => return Err(Error::msg(format!("Unknown provider {other}"))),
    };
    let response = ureq::get(&api)
        .header(auth_header, &auth_value)
        .header("User-Agent", "gitbrix")
        .header("Accept", "application/json")
        .call();
    let mut response = match response {
        Ok(r) => r,
        // A GitLab token limited to repository scopes can't read the user;
        // GitLab accepts any username with it, "oauth2" by convention.
        Err(ureq::Error::StatusCode(403)) if provider == "gitlab" => return Ok(("oauth2".to_owned(), None)),
        Err(ureq::Error::StatusCode(401 | 403)) => return Err(Error::msg("The service rejected this token")),
        Err(ureq::Error::StatusCode(404)) => {
            return Err(Error::msg(format!("{api} was not found; is the address right?")))
        }
        Err(e) => return Err(Error::msg(format!("Couldn't reach {host}: {e}"))),
    };
    let user: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| Error::msg(format!("Unexpected answer from {host}: {e}")))?;
    let login = user[login_key].as_str().ok_or_else(|| Error::msg(format!("Unexpected answer from {host}")))?;
    let name = user["name"].as_str().filter(|n| !n.is_empty()).map(str::to_owned);
    Ok((login.to_owned(), name))
}

pub fn add(provider: &str, url: &str, token: &str) -> Result<Account> {
    let token = token.trim();
    if token.is_empty() {
        return Err(Error::msg("Paste an access token"));
    }
    let url = normalize(url)?;
    let (username, name) = whoami(provider, &url, token)?;
    let account = Account { id: format!("{provider}|{url}|{username}"), provider: provider.to_owned(), url, username, name };
    entry(&account.id)?.set_password(token).map_err(keyring_error)?;
    let mut accounts = list()?;
    accounts.retain(|a| a.id != account.id);
    accounts.push(account.clone());
    save(&accounts)?;
    Ok(account)
}

pub fn remove(id: &str) -> Result<()> {
    let mut accounts = list()?;
    accounts.retain(|a| a.id != id);
    save(&accounts)?;
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(keyring_error(e)),
    }
}

/// The account for an https remote URL: same host, and the longest
/// matching path (several GitLab groups on one host may use different
/// accounts; `user@` in the URL picks among them).
pub fn find_for(remote_url: &str, accounts: &[Account]) -> Option<Account> {
    let (scheme, host, path) = split_url(remote_url)?;
    let user_in_url = remote_url.split_once("://").and_then(|(_, r)| {
        let authority = r.split('/').next()?;
        authority.rsplit_once('@').map(|(u, _)| u.split(':').next().unwrap_or(u).to_owned())
    });
    accounts
        .iter()
        .filter_map(|a| {
            let (ascheme, ahost, apath) = split_url(&a.url)?;
            let path_ok = path == apath || path.starts_with(&format!("{apath}/")) || apath.is_empty();
            // Never send an https account's token over plain http.
            (ascheme == scheme && ahost == host && path_ok).then_some((apath.len(), user_in_url.as_deref() == Some(a.username.as_str()), a))
        })
        .max_by_key(|(len, user_match, _)| (*user_match, *len))
        .map(|(_, _, a)| a.clone())
}

/// Username and token to send for `remote_url`, if an account covers it.
pub fn credentials_for(remote_url: &str) -> Option<(String, String)> {
    let account = find_for(remote_url, &list().ok()?)?;
    let token = entry(&account.id).ok()?.get_password().ok()?;
    Some((account.username, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acct(provider: &str, url: &str, user: &str) -> Account {
        Account { id: format!("{provider}|{url}|{user}"), provider: provider.into(), url: url.into(), username: user.into(), name: None }
    }

    #[test]
    fn splits_urls() {
        assert_eq!(split_url("https://GitLab.Example.com:8443/group/"), Some(("https".into(), "gitlab.example.com:8443".into(), "/group".into())));
        assert_eq!(split_url("https://me:pw@github.com/o/r.git"), Some(("https".into(), "github.com".into(), "/o/r.git".into())));
        assert_eq!(split_url("git@github.com:o/r.git"), None);
        assert_eq!(normalize("https://github.com/").unwrap(), "https://github.com");
    }

    #[test]
    fn picks_the_account_for_a_remote() {
        let all = vec![
            acct("github", "https://github.com", "selim"),
            acct("gitlab", "https://git.example.com", "s.cevik"),
            acct("gitlab", "https://git.example.com/infra", "deploy"),
        ];
        let id = |url: &str| find_for(url, &all).map(|a| a.username);
        assert_eq!(id("https://github.com/org/repo.git").as_deref(), Some("selim"));
        assert_eq!(id("https://git.example.com/team/app.git").as_deref(), Some("s.cevik"));
        assert_eq!(id("https://git.example.com/infra/tools.git").as_deref(), Some("deploy"));
        assert_eq!(id("https://s.cevik@git.example.com/infra/tools.git").as_deref(), Some("s.cevik"));
        assert_eq!(id("https://gitlab.com/x/y.git"), None);
        assert_eq!(id("https://git.example.com.evil.org/x.git"), None);
        assert_eq!(id("http://github.com/org/repo.git"), None);
    }
}
