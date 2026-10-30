//! Pull requests (GitHub) and merge requests (GitLab) of a repository's
//! remotes. Each remote is matched to the account whose token covers it
//! (see `accounts`); remotes without one are skipped. The token only goes
//! to that account's host, and redirects are never followed.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use crate::accounts::{self, Account};
use crate::error::{Error, Result};
use crate::git::{repo as repos, ssh};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    /// `github` or `gitlab`.
    pub provider: String,
    /// The remote it was found through; empty in the account-wide list.
    pub remote: String,
    /// The id of the account it was listed with (and is approved with).
    pub account: String,
    /// `host/owner/repo`: the same project seen through several remotes or
    /// repositories has the same key.
    pub project: String,
    /// GitHub's PR number or GitLab's MR iid.
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    /// The source branch lives in this project (not a fork).
    pub same_repo: bool,
    pub url: String,
    pub draft: bool,
    /// ISO 8601.
    pub created: String,
    pub updated: String,
    /// Opened by the account's user.
    pub mine: bool,
    /// The user is asked to review it.
    pub review_requested: bool,
    /// Assigned to the user.
    pub assigned: bool,
    /// The user may approve it (has write access or was asked to review,
    /// and didn't open it).
    pub can_approve: bool,
    pub approved_by_me: bool,
    /// Approved enough to merge, as far as the service says.
    pub approved: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequests {
    pub items: Vec<PullRequest>,
    /// Remotes that couldn't be listed, with the reason.
    pub problems: Vec<String>,
    /// Some remote had an account, so the list means something even when
    /// it's empty.
    pub covered: bool,
    /// Projects listed without error (`host/owner/repo`), empty ones too.
    pub projects: Vec<String>,
}

/// Requests across all accounts that involve the user: asked to review,
/// opened, or assigned.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inbox {
    pub items: Vec<PullRequest>,
    /// Accounts that couldn't be listed, with the reason.
    pub problems: Vec<String>,
    /// Ids of the accounts listed without error.
    pub accounts: Vec<String>,
}

/// Where a remote's project lives and how to reach its API.
#[derive(Debug, Clone, PartialEq)]
struct Project {
    provider: String,
    /// `owner/repo` or `group/subgroup/app`.
    path: String,
    /// `host` or `host:port`.
    host: String,
    /// REST API root, without a trailing slash.
    api: String,
    /// GitHub only.
    graphql: String,
    username: String,
    /// The account's id.
    account: String,
}

/// The web (https) address of a remote URL, for matching it to an account:
/// ssh remotes are reached over https on the same host.
fn web_url(remote: &str) -> Option<String> {
    let remote = remote.trim();
    let lower = remote.to_ascii_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") {
        return Some(remote.to_owned());
    }
    // Local paths are never projects; scp-like syntax needs a host before ':'.
    if remote.starts_with('/') || remote.starts_with('.') || lower.starts_with("file://") {
        return None;
    }
    let (host, _port, path) = ssh::parse_url(remote)?;
    // The ssh login (`git@`) isn't the web account.
    let host = host.rsplit_once('@').map_or(host.as_str(), |(_, h)| h);
    let path = path.trim_start_matches('/');
    (!path.starts_with('~')).then(|| format!("https://{host}/{path}"))
}

/// `owner/repo` from a remote's web URL.
fn project_path(web: &str) -> Option<String> {
    let (_, _, path) = accounts::split_url(web)?;
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    (path.contains('/')).then(|| path.to_owned())
}

fn project_for(remote_url: &str, all: &[Account]) -> Option<(Project, Account)> {
    let web = web_url(remote_url)?;
    let account = accounts::find_for(&web, all)?;
    let project = project_in(&account, project_path(&web)?)?;
    Some((project, account))
}

/// Project `path` on the account's server; the API is always reached on
/// the account's own host.
fn project_in(account: &Account, path: String) -> Option<Project> {
    let (scheme, host, _) = accounts::split_url(&account.url)?;
    let root = format!("{scheme}://{host}");
    let (api, graphql) = match account.provider.as_str() {
        "github" if host == "github.com" => (
            "https://api.github.com".to_owned(),
            "https://api.github.com/graphql".to_owned(),
        ),
        "github" => (format!("{root}/api/v3"), format!("{root}/api/graphql")),
        _ => (format!("{root}/api/v4"), String::new()),
    };
    Some(Project {
        provider: account.provider.clone(),
        path,
        host,
        api,
        graphql,
        username: account.username.clone(),
        account: account.id.clone(),
    })
}

/// Hosts everyone knows the provider of: a missing account there is worth
/// mentioning; for others we can't tell a forge from a plain git server.
fn known_forge(remote_url: &str) -> Option<&'static str> {
    let web = web_url(remote_url)?;
    match accounts::split_url(&web)?.1.as_str() {
        "github.com" => Some("github.com"),
        "gitlab.com" => Some("gitlab.com"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// HTTP

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        // The token must not follow a redirect to another host.
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .into()
}

fn request(method: &str, url: &str, token: &str, body: Option<&Value>) -> Result<Value> {
    let host = accounts::split_url(url)
        .map(|(_, h, _)| h)
        .unwrap_or_default();
    let agent = agent();
    let auth = format!("Bearer {token}");
    let response = match method {
        "GET" => agent
            .get(url)
            .header("Authorization", &auth)
            .header("User-Agent", "gitbrix")
            .header("Accept", "application/json")
            .call(),
        _ => {
            let req = agent
                .post(url)
                .header("Authorization", &auth)
                .header("User-Agent", "gitbrix")
                .header("Accept", "application/json");
            match body {
                Some(b) => req.send_json(b),
                None => req.send_empty(),
            }
        }
    };
    let mut response = response.map_err(|e| Error::msg(format!("Couldn't reach {host}: {e}")))?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().unwrap_or_default();
    let value: Value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::Null)
    };
    if (200..300).contains(&status) {
        return Ok(value);
    }
    let detail = value["message"]
        .as_str()
        .or_else(|| value["error"].as_str())
        .unwrap_or("")
        .trim()
        .to_owned();
    Err(Error::msg(match status {
        401 => format!("{host} rejected the token; it may have expired"),
        403 if detail.to_lowercase().contains("scope") => {
            format!(
                "The token for {host} lacks API access (GitLab: read_api or api scope; GitHub: pull requests)"
            )
        }
        403 => format!(
            "{host} refused: {}",
            if detail.is_empty() {
                "no permission"
            } else {
                &detail
            }
        ),
        404 => format!("{host}: not found, or the token can't see it"),
        300..=399 => format!("{host} redirected the request; is the account address right?"),
        _ if !detail.is_empty() => format!("{host}: {detail}"),
        _ => format!("{host} answered {status}"),
    }))
}

fn get(url: &str, token: &str) -> Result<Value> {
    request("GET", url, token, None)
}

/// Percent-encode a path segment (GitLab takes `group%2Fapp` as an id).
fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_owned()
}

// ---------------------------------------------------------------------------
// GitHub

const GITHUB_QUERY: &str = "query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    viewerPermission
    pullRequests(states: OPEN, first: 50, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft createdAt updatedAt
        headRefName baseRefName isCrossRepository
        author { login }
        viewerDidAuthor
        reviewDecision
        viewerLatestReview { state }
        reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
      }
    }
  }
}";

fn github_list(p: &Project, remote: &str, token: &str) -> Result<Vec<PullRequest>> {
    let (owner, name) = p
        .path
        .split_once('/')
        .ok_or_else(|| Error::msg("Not a GitHub repository path"))?;
    let body = json!({ "query": GITHUB_QUERY, "variables": { "owner": owner, "name": name } });
    let data = request("POST", &p.graphql, token, Some(&body))?;
    if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
        return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
    }
    let me = text(&data["data"]["viewer"]["login"]);
    let repo = &data["data"]["repository"];
    let can_write = matches!(
        repo["viewerPermission"].as_str(),
        Some("ADMIN" | "MAINTAIN" | "WRITE")
    );
    let nodes = repo["pullRequests"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let project = format!("{}/{}", p.host, p.path);
    Ok(nodes
        .iter()
        .map(|n| github_pr(n, &me, can_write, &project, remote, &p.account))
        .collect())
}

fn github_pr(n: &Value, me: &str, can_write: bool, project: &str, remote: &str, account: &str) -> PullRequest {
    let mine = n["viewerDidAuthor"].as_bool().unwrap_or(false);
    let review_requested = n["reviewRequests"]["nodes"].as_array().is_some_and(|r| {
        r.iter()
            .any(|r| !me.is_empty() && r["requestedReviewer"]["login"].as_str() == Some(me))
    });
    let approved_by_me = n["viewerLatestReview"]["state"].as_str() == Some("APPROVED");
    PullRequest {
        provider: "github".into(),
        remote: remote.to_owned(),
        account: account.to_owned(),
        project: project.to_owned(),
        number: n["number"].as_u64().unwrap_or(0),
        title: text(&n["title"]),
        // Deleted users come back as null ("ghost" on the web).
        author: n["author"]["login"].as_str().unwrap_or("ghost").to_owned(),
        source_branch: text(&n["headRefName"]),
        target_branch: text(&n["baseRefName"]),
        same_repo: !n["isCrossRepository"].as_bool().unwrap_or(false),
        url: text(&n["url"]),
        draft: n["isDraft"].as_bool().unwrap_or(false),
        created: text(&n["createdAt"]),
        updated: text(&n["updatedAt"]),
        mine,
        review_requested,
        assigned: n["assignees"]["nodes"]
            .as_array()
            .is_some_and(|a| a.iter().any(|a| !me.is_empty() && a["login"].as_str() == Some(me))),
        can_approve: !mine && !approved_by_me && (can_write || review_requested),
        approved_by_me,
        approved: n["reviewDecision"].as_str() == Some("APPROVED"),
    }
}

/// The searches behind the account-wide list. `review-requested` includes
/// requests to the user's teams and drops a request once it's reviewed.
const GITHUB_INBOX: &str = "query {
  viewer { login }
  review: search(query: \"is:pr is:open archived:false review-requested:@me\", type: ISSUE, first: 50) { nodes { ...pr } }
  mine: search(query: \"is:pr is:open archived:false author:@me\", type: ISSUE, first: 50) { nodes { ...pr } }
  assigned: search(query: \"is:pr is:open archived:false assignee:@me\", type: ISSUE, first: 50) { nodes { ...pr } }
}
fragment pr on PullRequest {
  number title url isDraft createdAt updatedAt
  headRefName baseRefName isCrossRepository
  author { login }
  viewerDidAuthor
  reviewDecision
  viewerLatestReview { state }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  assignees(first: 20) { nodes { login } }
  repository { nameWithOwner viewerPermission }
}";

fn github_inbox(p: &Project, token: &str) -> Result<Vec<PullRequest>> {
    let data = request("POST", &p.graphql, token, Some(&json!({ "query": GITHUB_INBOX })))?;
    if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
        return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
    }
    let me = text(&data["data"]["viewer"]["login"]);
    let mut out: Vec<PullRequest> = Vec::new();
    for search in ["review", "mine", "assigned"] {
        for n in data["data"][search]["nodes"].as_array().into_iter().flatten() {
            // Search results can be issues; those have no head branch.
            if n["number"].is_null() || n["headRefName"].is_null() {
                continue;
            }
            let repo = &n["repository"];
            let can_write = matches!(repo["viewerPermission"].as_str(), Some("ADMIN" | "MAINTAIN" | "WRITE"));
            let project = format!("{}/{}", p.host, text(&repo["nameWithOwner"]));
            let mut pr = github_pr(n, &me, can_write, &project, "", &p.account);
            if search == "review" && !pr.approved_by_me {
                pr.review_requested = true;
                pr.can_approve = !pr.mine;
            }
            match out.iter_mut().find(|o| o.url == pr.url) {
                Some(o) => {
                    o.review_requested |= pr.review_requested;
                    o.can_approve |= pr.can_approve;
                }
                None => out.push(pr),
            }
        }
    }
    Ok(out)
}

fn github_approve(p: &Project, token: &str, number: u64) -> Result<()> {
    let url = format!("{}/repos/{}/pulls/{number}/reviews", p.api, p.path);
    request("POST", &url, token, Some(&json!({ "event": "APPROVE" })))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// GitLab

fn gitlab_me(p: &Project, token: &str) -> Option<String> {
    // Tokens limited to repository scopes are saved as "oauth2"; ask then.
    if p.username != "oauth2" {
        return Some(p.username.clone());
    }
    get(&format!("{}/user", p.api), token)
        .ok()
        .and_then(|u| u["username"].as_str().map(str::to_owned))
}

fn gitlab_list(p: &Project, remote: &str, token: &str) -> Result<Vec<PullRequest>> {
    let base = format!("{}/projects/{}", p.api, encode(&p.path));
    let list = get(
        &format!("{base}/merge_requests?state=opened&per_page=50&order_by=created_at&sort=desc"),
        token,
    )?;
    let me = gitlab_me(p, token);
    let mrs = list.as_array().cloned().unwrap_or_default();
    let project = format!("{}/{}", p.host, p.path);
    let approvals = gitlab_approvals(p, &mrs, me.as_deref(), token);
    Ok(mrs
        .iter()
        .zip(approvals)
        .map(|(mr, approval)| gitlab_pr(mr, approval.as_ref(), me.as_deref(), &project, remote, &p.account))
        .collect())
}

/// Each MR's approvals (the only place that says whether the user may
/// approve), asked for side by side rather than one after another. None
/// for the user's own MRs and on errors.
fn gitlab_approvals(p: &Project, mrs: &[Value], me: Option<&str>, token: &str) -> Vec<Option<Value>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = mrs
            .iter()
            .map(|mr| {
                let url = format!(
                    "{}/projects/{}/merge_requests/{}/approvals",
                    p.api,
                    mr["project_id"].as_u64().map_or_else(|| encode(&p.path), |id| id.to_string()),
                    mr["iid"].as_u64().unwrap_or(0)
                );
                let mine = me.is_some() && mr["author"]["username"].as_str() == me;
                scope.spawn(move || if mine { None } else { get(&url, token).ok() })
            })
            .collect();
        handles.into_iter().map(|h| h.join().ok().flatten()).collect()
    })
}

fn gitlab_pr(mr: &Value, approval: Option<&Value>, me: Option<&str>, project: &str, remote: &str, account: &str) -> PullRequest {
    let author = mr["author"]["username"].as_str().unwrap_or("").to_owned();
    let mine = me == Some(author.as_str());
    let listed = |field: &str| {
        me.is_some_and(|me| mr[field].as_array().is_some_and(|r| r.iter().any(|r| r["username"].as_str() == Some(me))))
    };
    let review_requested = listed("reviewers");
    let (can_approve, approved_by_me, approved) = match approval {
        Some(a) => (
            a["user_can_approve"].as_bool().unwrap_or(false),
            a["user_has_approved"].as_bool().unwrap_or(false),
            a["approved"].as_bool().unwrap_or(false),
        ),
        None => (!mine && review_requested, false, false),
    };
    PullRequest {
        provider: "gitlab".into(),
        remote: remote.to_owned(),
        account: account.to_owned(),
        project: project.to_owned(),
        number: mr["iid"].as_u64().unwrap_or(0),
        title: text(&mr["title"]),
        author,
        source_branch: text(&mr["source_branch"]),
        target_branch: text(&mr["target_branch"]),
        same_repo: mr["source_project_id"] == mr["target_project_id"],
        url: text(&mr["web_url"]),
        draft: mr["draft"]
            .as_bool()
            .or_else(|| mr["work_in_progress"].as_bool())
            .unwrap_or(false),
        created: text(&mr["created_at"]),
        updated: text(&mr["updated_at"]),
        mine,
        review_requested,
        assigned: listed("assignees"),
        // GitLab says the user may approve their own MR when the
        // project allows it; that's not a request for their review.
        can_approve: can_approve && !mine && !approved_by_me,
        approved_by_me,
        approved,
    }
}

/// `group/sub/app` from an MR's web address (`.../group/sub/app/-/merge_requests/3`).
fn gitlab_project_of(web_url: &str) -> Option<String> {
    let (_, _, path) = accounts::split_url(web_url)?;
    let (project, _) = path.split_once("/-/")?;
    Some(project.trim_matches('/').to_owned())
}

fn gitlab_inbox(p: &Project, token: &str) -> Result<Vec<PullRequest>> {
    let me = gitlab_me(p, token).ok_or_else(|| Error::msg(format!("{}: the token can't read who it belongs to (needs read_api)", p.host)))?;
    let list = |filter: &str| -> Result<Vec<Value>> {
        let url = format!("{}/merge_requests?state=opened&per_page=50&order_by=created_at&sort=desc&{filter}", p.api);
        Ok(get(&url, token)?.as_array().cloned().unwrap_or_default())
    };
    let mut mrs: Vec<Value> = Vec::new();
    for filter in [format!("scope=all&reviewer_username={}", encode(&me)), "scope=created_by_me".into(), "scope=assigned_to_me".into()] {
        for mr in list(&filter)? {
            if !mrs.iter().any(|m| m["id"] == mr["id"]) {
                mrs.push(mr);
            }
        }
    }
    let approvals = gitlab_approvals(p, &mrs, Some(&me), token);
    Ok(mrs
        .iter()
        .zip(approvals)
        .filter_map(|(mr, approval)| {
            let project = format!("{}/{}", p.host, gitlab_project_of(mr["web_url"].as_str()?)?);
            Some(gitlab_pr(mr, approval.as_ref(), Some(&me), &project, "", &p.account))
        })
        .collect())
}

fn gitlab_approve(p: &Project, token: &str, number: u64) -> Result<()> {
    let url = format!(
        "{}/projects/{}/merge_requests/{number}/approve",
        p.api,
        encode(&p.path)
    );
    request("POST", &url, token, None)?;
    Ok(())
}

// ---------------------------------------------------------------------------

fn list_project(p: &Project, remote: &str, token: &str) -> Result<Vec<PullRequest>> {
    match p.provider.as_str() {
        "github" => github_list(p, remote, token),
        _ => gitlab_list(p, remote, token),
    }
}

/// The remotes of a repository with their URLs.
fn remotes(repo: &Path) -> Result<Vec<(String, String)>> {
    let r = repos::open(repo)?;
    let names = r.remotes()?;
    let mut out: Vec<(String, String)> = names
        .iter()
        .flatten()
        .flatten()
        .filter_map(|name| {
            Some((
                name.to_owned(),
                r.find_remote(name).ok()?.url().ok()?.to_owned(),
            ))
        })
        .collect();
    // "origin" first, so a project reachable through several remotes is
    // listed under it.
    out.sort_by_key(|(name, _)| name != "origin");
    Ok(out)
}

/// Open pull/merge requests of every remote an account covers.
pub fn list(repo: &Path) -> Result<PullRequests> {
    let all = accounts::usable(Some(&repos::workdir(&repos::open(repo)?)))?;
    let mut out = PullRequests::default();
    let mut seen = Vec::new();
    for (remote, url) in remotes(repo)? {
        let Some((project, account)) = project_for(&url, &all) else {
            if let Some(host) = known_forge(&url) {
                out.problems.push(format!(
                    "{remote}: add a {host} account in Settings to see its requests"
                ));
            }
            continue;
        };
        if seen.contains(&project) {
            continue;
        }
        seen.push(project.clone());
        out.covered = true;
        let Some(token) = accounts::token(&account) else {
            out.problems.push(format!(
                "{remote}: the token for {} isn't in the system keyring",
                project.host
            ));
            continue;
        };
        match list_project(&project, &remote, &token) {
            Ok(items) => {
                out.projects.push(format!("{}/{}", project.host, project.path));
                out.items.extend(items);
            }
            Err(e) => out.problems.push(format!("{remote}: {e}")),
        }
    }
    out.items.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

fn project_of_remote(repo: &Path, remote: &str) -> Result<(Project, String)> {
    let r = repos::open(repo)?;
    let url = r
        .find_remote(remote)
        .ok()
        .and_then(|rm| rm.url().ok().map(str::to_owned))
        .ok_or_else(|| Error::msg(format!("No remote named '{remote}'")))?;
    let (project, account) = project_for(&url, &accounts::usable(r.workdir())?).ok_or_else(|| {
        Error::msg(format!(
            "No GitHub or GitLab account covers {remote} ({url})"
        ))
    })?;
    let token = accounts::token(&account)
        .ok_or_else(|| Error::msg("The account's token isn't in the system keyring"))?;
    Ok((project, token))
}

/// Requests involving the user, across every account.
pub fn inbox() -> Result<Inbox> {
    let all = accounts::usable(None)?;
    let results: Vec<(Account, Result<Vec<PullRequest>>)> = std::thread::scope(|scope| {
        let handles: Vec<_> = all
            .iter()
            .map(|account| {
                scope.spawn(move || {
                    let project = project_in(account, String::new())
                        .ok_or_else(|| Error::msg(format!("Invalid address {}", account.url)))?;
                    let token = accounts::token(account)
                        .ok_or_else(|| Error::msg("the token isn't in the system keyring"))?;
                    match account.provider.as_str() {
                        "github" => github_inbox(&project, &token),
                        _ => gitlab_inbox(&project, &token),
                    }
                })
            })
            .collect();
        all.iter().cloned().zip(handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(Error::msg("crashed"))))).collect()
    });
    let mut out = Inbox::default();
    for (account, result) in results {
        match result {
            Ok(items) => {
                out.accounts.push(account.id.clone());
                out.items.extend(items);
            }
            Err(e) => out.problems.push(format!("{} ({}): {e}", account.username, account.url)),
        }
    }
    out.items.sort_by(|a, b| b.created.cmp(&a.created));
    Ok(out)
}

/// Approve a pull/merge request as the account's user. `project` is the
/// request's `host/owner/repo` key and must be on the account's host.
pub fn approve(account_id: &str, project: &str, number: u64) -> Result<()> {
    let account = accounts::list()?
        .into_iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| Error::msg("That account was removed"))?;
    let (_, host, _) = accounts::split_url(&account.url).ok_or_else(|| Error::msg("Invalid account address"))?;
    let path = project
        .strip_prefix(&format!("{host}/"))
        .filter(|p| p.contains('/'))
        .ok_or_else(|| Error::msg(format!("{project} isn't on {host}")))?;
    let project = project_in(&account, path.to_owned()).ok_or_else(|| Error::msg("Invalid account address"))?;
    let token = accounts::token(&account).ok_or_else(|| Error::msg("The account's token isn't in the system keyring"))?;
    match project.provider.as_str() {
        "github" => github_approve(&project, &token, number),
        _ => gitlab_approve(&project, &token, number),
    }
}

/// The provider of the account covering `remote` (for the request's ref).
pub fn provider_of_remote(repo: &Path, remote: &str) -> Result<String> {
    Ok(project_of_remote(repo, remote)?.0.provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    fn acct(provider: &str, url: &str, user: &str) -> Account {
        Account {
            id: format!("{provider}|{url}|{user}"),
            provider: provider.into(),
            url: url.into(),
            username: user.into(),
            name: None,
        }
    }

    #[test]
    fn remote_urls_map_to_web_addresses() {
        assert_eq!(
            web_url("git@github.com:o/r.git").as_deref(),
            Some("https://github.com/o/r.git")
        );
        assert_eq!(
            web_url("ssh://git@git.corp:2222/team/app.git").as_deref(),
            Some("https://git.corp/team/app.git")
        );
        assert_eq!(
            web_url("https://gitlab.com/g/sub/app.git").as_deref(),
            Some("https://gitlab.com/g/sub/app.git")
        );
        assert_eq!(web_url("/srv/git/app.git"), None);
        assert_eq!(web_url("../app"), None);
        assert_eq!(web_url("file:///srv/app"), None);
        assert_eq!(
            project_path("https://gitlab.com/g/sub/app.git/").as_deref(),
            Some("g/sub/app")
        );
        assert_eq!(project_path("https://github.com/o"), None);
        assert_eq!(encode("g/sub app"), "g%2Fsub%20app");
    }

    #[test]
    fn projects_take_the_covering_account() {
        let all = vec![
            acct("github", "https://github.com", "me"),
            acct("gitlab", "https://git.corp", "s.cevik"),
        ];
        let (gh, _) = project_for("git@github.com:o/r.git", &all).unwrap();
        assert_eq!(
            (gh.api.as_str(), gh.graphql.as_str(), gh.path.as_str()),
            (
                "https://api.github.com",
                "https://api.github.com/graphql",
                "o/r"
            )
        );
        let (gl, _) = project_for("ssh://git@git.corp:2222/team/app.git", &all).unwrap();
        assert_eq!(
            (gl.provider.as_str(), gl.api.as_str(), gl.path.as_str()),
            ("gitlab", "https://git.corp/api/v4", "team/app")
        );
        assert!(project_for("https://gitlab.com/x/y.git", &all).is_none());
        assert_eq!(known_forge("git@gitlab.com:x/y.git"), Some("gitlab.com"));
        assert_eq!(known_forge("https://git.corp/x/y.git"), None);
    }

    /// A one-thread HTTP server answering from `routes` (method + path
    /// prefix → JSON) and recording each request line with its token.
    fn serve(routes: Vec<(&'static str, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let seen = log.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let (mut len, mut auth) = (0, String::new());
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                    let lower = h.to_ascii_lowercase();
                    if let Some(v) = lower.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap();
                    }
                    if lower.starts_with("authorization:") {
                        auth = h["authorization:".len()..].trim().to_owned();
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let request = line
                    .split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ");
                seen.lock().unwrap().push(format!("{request} [{auth}]"));
                let answer = routes
                    .iter()
                    .find(|(prefix, _)| request.starts_with(prefix))
                    .map(|(_, v)| v.to_string());
                let (status, text) = match answer {
                    Some(t) => ("200 OK", t),
                    None => ("404 Not Found", r#"{"message":"404 Not Found"}"#.to_owned()),
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
            }
        });
        (addr, log)
    }

    fn project(provider: &str, api: &str, username: &str) -> Project {
        Project {
            provider: provider.into(),
            path: "team/app".into(),
            host: "git.test".into(),
            api: api.into(),
            graphql: format!("{api}/graphql"),
            username: username.into(),
            account: "acct".into(),
        }
    }

    #[test]
    fn gitlab_inbox_merges_the_three_lists() {
        let mr = |id: u64, iid: u64, author: &str, reviewers: Value, assignees: Value| {
            json!({ "id": id, "iid": iid, "project_id": 40 + id, "title": format!("MR {iid}"), "author": { "username": author },
                    "reviewers": reviewers, "assignees": assignees, "source_branch": "f", "target_branch": "main",
                    "source_project_id": 1, "target_project_id": 1, "draft": false,
                    "web_url": format!("https://git.test/grp/app{id}/-/merge_requests/{iid}"),
                    "created_at": format!("2026-10-2{id}T10:00:00Z"), "updated_at": "2026-10-29T10:00:00Z" })
        };
        let list = "GET /api/v4/merge_requests?state=opened&per_page=50&order_by=created_at&sort=desc&";
        let review = mr(1, 5, "ada", json!([{ "username": "me" }]), json!([]));
        let mine = mr(2, 6, "me", json!([]), json!([{ "username": "me" }]));
        let (addr, log) = serve(vec![
            (Box::leak(format!("{list}scope=all&reviewer_username=me").into_boxed_str()), json!([review.clone()])),
            (Box::leak(format!("{list}scope=created_by_me").into_boxed_str()), json!([mine.clone()])),
            // Assigned and created overlap: listed once.
            (Box::leak(format!("{list}scope=assigned_to_me").into_boxed_str()), json!([mine])),
            ("GET /api/v4/projects/41/merge_requests/5/approvals", json!({ "user_can_approve": true, "user_has_approved": false, "approved": false })),
        ]);
        let items = gitlab_inbox(&project("gitlab", &format!("{addr}/api/v4"), "me"), "tok").unwrap();
        assert_eq!(items.len(), 2);
        let by = |n: u64| items.iter().find(|i| i.number == n).unwrap();
        assert!(by(5).review_requested && by(5).can_approve && !by(5).mine);
        assert_eq!(by(5).project, "git.test/grp/app1");
        assert_eq!((by(5).account.as_str(), by(5).remote.as_str()), ("acct", ""));
        assert!(by(6).mine && by(6).assigned && !by(6).can_approve);
        assert!(!log.lock().unwrap().iter().any(|l| l.contains("/6/approvals")));
    }

    #[test]
    fn github_inbox_flags_requests_from_the_review_search() {
        let pr = |n: u64, repo: &str, permission: &str, did_author: bool| {
            json!({ "number": n, "title": format!("PR {n}"), "url": format!("https://github.com/{repo}/pull/{n}"),
                    "isDraft": false, "createdAt": format!("2026-10-2{n}T10:00:00Z"), "updatedAt": "2026-10-29T10:00:00Z",
                    "headRefName": "f", "baseRefName": "main", "isCrossRepository": false, "author": { "login": "ada" },
                    "viewerDidAuthor": did_author, "reviewDecision": null, "viewerLatestReview": null,
                    "reviewRequests": { "nodes": [] }, "assignees": { "nodes": [{ "login": "me" }] },
                    "repository": { "nameWithOwner": repo, "viewerPermission": permission } })
        };
        let data = json!({ "data": { "viewer": { "login": "me" },
            // Requested through a team: not in reviewRequests by name.
            "review": { "nodes": [pr(1, "org/api", "READ", false)] },
            "mine": { "nodes": [pr(2, "me/tool", "ADMIN", true)] },
            "assigned": { "nodes": [pr(2, "me/tool", "ADMIN", true), pr(3, "org/web", "WRITE", false), { "number": 9 }] } } });
        let (addr, _) = serve(vec![("POST /graphql", data)]);
        let items = github_inbox(&project("github", &addr, "me"), "tok").unwrap();
        assert_eq!(items.iter().map(|i| (i.number, i.can_approve)).collect::<Vec<_>>(), vec![(1, true), (2, false), (3, true)]);
        assert!(items[0].review_requested && items[2].assigned);
        assert_eq!(items[0].project, "git.test/org/api");
    }

    #[test]
    fn gitlab_requests_say_who_may_approve() {
        let mr = |iid: u64, author: &str, reviewers: Value| {
            json!({ "iid": iid, "title": format!("MR {iid}"), "author": { "username": author }, "reviewers": reviewers,
                    "source_branch": "feature", "target_branch": "main", "source_project_id": 1, "target_project_id": 1,
                    "web_url": format!("https://git.test/team/app/-/merge_requests/{iid}"), "draft": iid == 3,
                    "created_at": format!("2026-10-2{iid}T10:00:00Z"), "updated_at": "2026-10-29T10:00:00Z" })
        };
        let (addr, log) = serve(vec![
            (
                "GET /api/v4/projects/team%2Fapp/merge_requests?",
                json!([
                    mr(1, "ada", json!([{ "username": "me" }])),
                    mr(2, "me", json!([])),
                    mr(3, "bob", json!([]))
                ]),
            ),
            (
                "GET /api/v4/projects/team%2Fapp/merge_requests/1/approvals",
                json!({ "user_can_approve": true, "user_has_approved": false, "approved": false }),
            ),
            (
                "GET /api/v4/projects/team%2Fapp/merge_requests/3/approvals",
                json!({ "user_can_approve": true, "user_has_approved": true, "approved": true }),
            ),
            (
                "POST /api/v4/projects/team%2Fapp/merge_requests/1/approve",
                json!({}),
            ),
        ]);
        let p = project("gitlab", &format!("{addr}/api/v4"), "me");
        let items = gitlab_list(&p, "origin", "tok").unwrap();
        let by = |n: u64| items.iter().find(|i| i.number == n).unwrap();
        assert!(by(1).can_approve && by(1).review_requested && !by(1).mine);
        assert!(
            by(2).mine && !by(2).can_approve,
            "your own MR is not yours to approve"
        );
        assert!(!by(3).can_approve && by(3).approved_by_me && by(3).approved && by(3).draft);
        assert_eq!(by(1).project, "git.test/team/app");
        // The author's own MR needs no approvals lookup.
        assert!(
            !log.lock()
                .unwrap()
                .iter()
                .any(|l| l.contains("/2/approvals"))
        );
        gitlab_approve(&p, "tok", 1).unwrap();
        let log = log.lock().unwrap();
        assert!(log.iter().all(|l| l.ends_with("[Bearer tok]")), "{log:?}");
        assert!(log.iter().any(|l| l.starts_with("POST /api/v4/projects/team%2Fapp/merge_requests/1/approve")));
    }

    #[test]
    fn github_requests_come_from_one_query() {
        let pr = |n: u64, did_author: bool, requested: &str, review: Value| {
            json!({ "number": n, "title": format!("PR {n}"), "url": format!("https://github.com/team/app/pull/{n}"),
                    "isDraft": false, "createdAt": format!("2026-10-2{n}T10:00:00Z"), "updatedAt": "2026-10-29T10:00:00Z",
                    "headRefName": "feature", "baseRefName": "main", "isCrossRepository": n == 2,
                    "author": if n == 3 { Value::Null } else { json!({ "login": "ada" }) }, "viewerDidAuthor": did_author,
                    "reviewDecision": if n == 3 { "APPROVED" } else { "REVIEW_REQUIRED" }, "viewerLatestReview": review,
                    "reviewRequests": { "nodes": [{ "requestedReviewer": { "login": requested } }] } })
        };
        let data = |permission: &str| {
            json!({ "data": { "viewer": { "login": "me" }, "repository": { "viewerPermission": permission,
                "pullRequests": { "nodes": [pr(1, false, "me", Value::Null), pr(2, true, "x", Value::Null), pr(3, false, "x", json!({ "state": "APPROVED" }))] } } } })
        };
        let (addr, log) = serve(vec![
            ("POST /graphql", data("READ")),
            ("POST /repos/team/app/pulls/1/reviews", json!({})),
        ]);
        let p = project("github", &addr, "me");
        let items = github_list(&p, "origin", "tok").unwrap();
        // Read access: only the request asking for your review.
        assert_eq!(
            items
                .iter()
                .map(|i| (i.number, i.can_approve))
                .collect::<Vec<_>>(),
            vec![(1, true), (2, false), (3, false)]
        );
        assert!(items[1].mine && !items[1].same_repo);
        assert_eq!(items[2].author, "ghost");
        assert!(items[2].approved && items[2].approved_by_me);
        github_approve(&p, "tok", 1).unwrap();
        assert_eq!(log.lock().unwrap().len(), 2);

        let (addr, _) = serve(vec![("POST /graphql", data("WRITE"))]);
        let items = github_list(&project("github", &addr, "me"), "origin", "tok").unwrap();
        // Write access: anything you didn't open or approve already.
        assert_eq!(
            items.iter().map(|i| i.can_approve).collect::<Vec<_>>(),
            vec![true, false, false]
        );
    }

    #[test]
    fn errors_name_the_problem() {
        let (addr, _) = serve(vec![(
            "POST /graphql",
            json!({ "errors": [{ "message": "Could not resolve to a Repository" }] }),
        )]);
        let e = github_list(&project("github", &addr, "me"), "origin", "tok")
            .unwrap_err()
            .to_string();
        assert!(e.contains("Could not resolve"), "{e}");
        let (addr, _) = serve(vec![]);
        let e = gitlab_list(
            &project("gitlab", &format!("{addr}/api/v4"), "me"),
            "origin",
            "tok",
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("not found"), "{e}");
    }
}

/// Against a real service with the accounts saved on this machine:
/// `GITBRIX_LIVE_URL=https://gitlab.com/me/project.git cargo test live_pull_requests -- --ignored --nocapture`.
/// Only reads.
#[cfg(test)]
#[test]
#[ignore]
fn live_pull_requests() {
    let url = std::env::var("GITBRIX_LIVE_URL").expect("GITBRIX_LIVE_URL");
    let home = std::env::var("HOME").unwrap();
    accounts::init(Path::new(&home).join(".config/dev.gitbrix.app"));
    let dir = tempfile::TempDir::new().unwrap();
    let r = git2::Repository::init(dir.path()).unwrap();
    r.remote("origin", &url).unwrap();
    let res = list(dir.path()).unwrap();
    println!("{res:#?}");
    assert!(res.covered, "no account covers {url}");
    assert!(res.problems.is_empty(), "{:?}", res.problems);
}

/// `cargo test live_inbox -- --ignored --nocapture`, with this machine's accounts. Only reads.
#[cfg(test)]
#[test]
#[ignore]
fn live_inbox() {
    let home = std::env::var("HOME").unwrap();
    accounts::init(Path::new(&home).join(".config/dev.gitbrix.app"));
    let res = inbox().unwrap();
    println!("{res:#?}");
    assert!(res.problems.is_empty(), "{:?}", res.problems);
}
