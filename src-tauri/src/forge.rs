//! Pull requests (GitHub) and merge requests (GitLab) of a repository's
//! remotes. Each remote is matched to the account whose token covers it
//! (see `accounts`); remotes without one are skipped. The token only goes
//! to that account's host, and redirects are never followed.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::accounts::{self, Account};
use crate::error::{Error, Result};
use crate::git::{repo as repos, ssh};

pub mod issues;

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
    /// CI on the latest commit: `success`, `failed`, `running`, `pending`,
    /// `canceled`, `skipped` or `manual`; none without CI.
    pub ci: Option<String>,
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
pub(crate) fn web_url(remote: &str) -> Option<String> {
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
        _ => (format!("{root}/api/v4"), format!("{root}/api/graphql")),
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
    request_as(method, url, token, body, "application/json")
}

/// GitHub's answers with each text also rendered as HTML (`body_html`).
const GITHUB_FULL: &str = "application/vnd.github.full+json";

fn request_as(method: &str, url: &str, token: &str, body: Option<&Value>, accept: &str) -> Result<Value> {
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
            .header("Accept", accept)
            .call(),
        _ => {
            if method == "DELETE" {
                agent
                    .delete(url)
                    .header("Authorization", &auth)
                    .header("User-Agent", "gitbrix")
                    .header("Accept", accept)
                    .call()
            } else {
            let req = if method == "PUT" { agent.put(url) } else { agent.post(url) };
            let req = req
                .header("Authorization", &auth)
                .header("User-Agent", "gitbrix")
                .header("Accept", accept);
            match body {
                Some(b) => req.send_json(b),
                None => req.send_empty(),
            }
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
    let detail = error_detail(&value);
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

/// The reason in an error answer. GitLab sends `message` as text, a list
/// or an object of field → list; GitHub adds `errors[].message`.
fn error_detail(value: &Value) -> String {
    fn flatten(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.trim().to_owned()),
            Value::Array(a) => a.iter().for_each(|x| flatten(x, out)),
            Value::Object(o) => o.iter().for_each(|(k, x)| {
                let mut inner = Vec::new();
                flatten(x, &mut inner);
                if !inner.is_empty() {
                    out.push(format!("{k} {}", inner.join(", ")));
                }
            }),
            _ => {}
        }
    }
    let mut parts = Vec::new();
    flatten(&value["message"], &mut parts);
    if parts.is_empty() {
        flatten(&value["error"], &mut parts);
    }
    for e in value["errors"].as_array().into_iter().flatten() {
        if let Some(m) = e["message"].as_str() {
            parts.push(m.trim().to_owned());
        }
    }
    parts.retain(|p| !p.is_empty());
    parts.join("; ")
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
        assignees(first: 20) { nodes { login } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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
        ci: n["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"].as_str().and_then(ci_state),
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
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
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
    // The list leaves out each MR's pipeline; the project's recent ones
    // (one call) cover the open MRs' latest commits.
    let pipelines = gitlab_pipelines(p, token).unwrap_or_default();
    Ok(mrs
        .iter()
        .zip(approvals)
        .map(|(mr, approval)| {
            let mut pr = gitlab_pr(mr, approval.as_ref(), me.as_deref(), &project, remote, &p.account);
            if pr.ci.is_none() {
                pr.ci = mr["sha"].as_str().and_then(|sha| pipelines.get(sha)).map(|c| c.state.clone());
            }
            pr
        })
        .collect())
}

/// Latest pipeline per commit among the project's 100 most recent.
fn gitlab_pipelines(p: &Project, token: &str) -> Result<HashMap<String, Ci>> {
    let url = format!("{}/projects/{}/pipelines?per_page=100&order_by=id&sort=desc", p.api, encode(&p.path));
    let mut out = HashMap::new();
    for pl in get(&url, token)?.as_array().into_iter().flatten() {
        let (Some(sha), Some(state)) = (pl["sha"].as_str(), pl["status"].as_str().and_then(ci_state)) else { continue };
        // Newest first: keep the first seen.
        out.entry(sha.to_owned()).or_insert(Ci { state, url: text(&pl["web_url"]) });
    }
    Ok(out)
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
        ci: mr["head_pipeline"]["status"].as_str().and_then(ci_state),
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

/// What every remote an account covers lists, gathered: `T`s, the remotes
/// that couldn't be listed and why (`what` names the things in the
/// advice to add an account), and the projects listed.
pub(crate) struct Listed<T> {
    pub items: Vec<T>,
    pub problems: Vec<String>,
    pub covered: bool,
    pub projects: Vec<String>,
}

fn each_project<T>(repo: &Path, what: &str, list: impl Fn(&Project, &str, &str) -> Result<Vec<T>>) -> Result<Listed<T>> {
    let all = accounts::usable(Some(&repos::workdir(&repos::open(repo)?)))?;
    let mut out = Listed { items: Vec::new(), problems: Vec::new(), covered: false, projects: Vec::new() };
    let mut seen = Vec::new();
    for (remote, url) in remotes(repo)? {
        let Some((project, account)) = project_for(&url, &all) else {
            if let Some(host) = known_forge(&url) {
                out.problems.push(format!(
                    "{remote}: add a {host} account in Settings to see its {what}"
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
        match list(&project, &remote, &token) {
            Ok(items) => {
                out.projects.push(format!("{}/{}", project.host, project.path));
                out.items.extend(items);
            }
            Err(e) => out.problems.push(format!("{remote}: {e}")),
        }
    }
    Ok(out)
}

/// Open pull/merge requests of every remote an account covers.
pub fn list(repo: &Path) -> Result<PullRequests> {
    let l = each_project(repo, "requests", list_project)?;
    let mut out = PullRequests { items: l.items, problems: l.problems, covered: l.covered, projects: l.projects };
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
    pub(super) fn serve(routes: Vec<(&'static str, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let (addr, log, _) = serve_bodies(routes);
        (addr, log)
    }

    type Log = Arc<Mutex<Vec<String>>>;
    type Bodies = Arc<Mutex<Vec<(String, Value)>>>;

    /// `serve`, also keeping each request body (`METHOD /path` → JSON).
    fn serve_bodies(routes: Vec<(&'static str, Value)>) -> (String, Log, Bodies) {
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let kept = bodies.clone();
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
                let (mut len, mut auth, mut accept) = (0, String::new(), String::new());
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
                    if lower.starts_with("accept:") {
                        accept = h["accept:".len()..].trim().to_owned();
                    }
                }
                let mut body = vec![0; len];
                reader.read_exact(&mut body).unwrap();
                let request = line
                    .split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ");
                seen.lock().unwrap().push(format!("{request} <{accept}> [{auth}]"));
                if let Ok(v) = serde_json::from_slice::<Value>(&body) {
                    kept.lock().unwrap().push((request.clone(), v));
                }
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
        (addr, log, bodies)
    }

    fn new_request(reviewers: Vec<u64>, draft: bool) -> NewRequest {
        NewRequest {
            source: "feature".into(),
            target: "main".into(),
            title: " Add parser ".into(),
            body: "Why".into(),
            draft,
            reviewers,
        }
    }

    #[test]
    fn gitlab_merge_requests_open_with_reviewers_and_draft() {
        let (addr, _, bodies) = serve_bodies(vec![
            ("GET /api/v4/projects/team%2Fapp/members/all", json!([
                { "id": 7, "username": "ada", "name": "Ada", "state": "active" },
                { "id": 8, "username": "me", "name": "Me", "state": "active" },
                { "id": 9, "username": "gone", "name": "Gone", "state": "blocked" }
            ])),
            ("GET /api/v4/projects/team%2Fapp", json!({ "default_branch": "develop" })),
            ("POST /api/v4/projects/team%2Fapp/merge_requests", json!({ "iid": 12, "web_url": "https://git.test/team/app/-/merge_requests/12" })),
        ]);
        let p = project("gitlab", &format!("{addr}/api/v4"), "me");
        let form = form_in(&p, "tok").unwrap();
        assert_eq!(form.default_branch, "develop");
        // Not yourself, not blocked users.
        assert_eq!(form.people.iter().map(|u| u.username.as_str()).collect::<Vec<_>>(), ["ada"]);

        let created = create_in(&p, "tok", &new_request(vec![7], true)).unwrap();
        assert_eq!(created, Created { number: 12, url: "https://git.test/team/app/-/merge_requests/12".into(), warning: None });
        let bodies = bodies.lock().unwrap();
        let (_, sent) = bodies.iter().find(|(r, _)| r.starts_with("POST")).unwrap();
        assert_eq!(sent["title"], "Draft: Add parser");
        assert_eq!(sent["reviewer_ids"], json!([7]));
        assert_eq!((sent["source_branch"].as_str(), sent["target_branch"].as_str()), (Some("feature"), Some("main")));
    }

    #[test]
    fn github_pull_requests_open_then_ask_reviewers_by_login() {
        let (addr, log, bodies) = serve_bodies(vec![
            ("GET /repos/team/app/collaborators", json!([{ "id": 5, "login": "grace" }, { "id": 6, "login": "me" }])),
            ("GET /repos/team/app", json!({ "default_branch": "main" })),
            ("POST /repos/team/app/pulls/31/requested_reviewers", json!({})),
            ("POST /repos/team/app/pulls", json!({ "number": 31, "html_url": "https://github.com/team/app/pull/31" })),
        ]);
        let p = project("github", &addr, "me");
        let created = create_in(&p, "tok", &new_request(vec![5], false)).unwrap();
        assert_eq!((created.number, created.warning), (31, None));
        let bodies = bodies.lock().unwrap();
        let sent = |prefix: &str| bodies.iter().find(|(r, _)| r == prefix).map(|(_, v)| v.clone()).unwrap();
        let pr = sent("POST /repos/team/app/pulls");
        assert_eq!((pr["head"].as_str(), pr["base"].as_str(), pr["draft"].as_bool()), (Some("feature"), Some("main"), Some(false)));
        assert_eq!(pr["title"], "Add parser");
        assert_eq!(sent("POST /repos/team/app/pulls/31/requested_reviewers")["reviewers"], json!(["grace"]));
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));

        // No title, or the same branch on both sides: refused before asking.
        assert!(create_in(&p, "tok", &NewRequest { title: " ".into(), ..new_request(vec![], false) }).is_err());
        assert!(create_in(&p, "tok", &NewRequest { target: "feature".into(), ..new_request(vec![], false) }).is_err());
    }

    #[test]
    fn github_conversation_merges_comments_reviews_and_lines() {
        let (addr, log) = serve(vec![
            ("GET /repos/team/app/pulls/4/comments", json!([
                { "user": { "login": "ada" }, "body": "Off by one?", "created_at": "2026-10-02T00:00:00Z", "path": "src/a.rs", "line": 12 }
            ])),
            ("GET /repos/team/app/pulls/4/reviews", json!([
                { "user": { "login": "ada" }, "body": "", "state": "COMMENTED", "submitted_at": "2026-10-02T00:00:01Z" },
                { "user": { "login": "grace" }, "body": "Ship it", "state": "APPROVED", "submitted_at": "2026-10-03T00:00:00Z" }
            ])),
            ("GET /repos/team/app/pulls/4", json!({ "body": "Fixes #1", "body_html": "<p>Fixes <a href=\"https://github.com/team/app/issues/1\">#1</a></p>",
                "state": "open", "merged": false, "mergeable": false, "mergeable_state": "dirty" })),
            ("GET /repos/team/app/issues/4/comments", json!([
                { "user": { "login": "me" }, "body": "First", "body_html": "<p>First</p>", "created_at": "2026-10-01T00:00:00Z" }
            ])),
        ]);
        let c = conversation_in(&project("github", &addr, "me"), "tok", 4).unwrap();
        assert_eq!(c.description, "Fixes #1");
        assert_eq!(c.description_html.as_deref(), Some("<p>Fixes <a href=\"https://github.com/team/app/issues/1\">#1</a></p>"));
        assert_eq!(c.comments[0].html.as_deref(), Some("<p>First</p>"));
        // Asked for the rendered text everywhere.
        assert!(log.lock().unwrap().iter().all(|l| l.contains("<application/vnd.github.full+json>")), "{:?}", log.lock().unwrap());
        assert!(c.open);
        assert_eq!((c.mergeable, c.merge_status.as_str()), (Some(false), "has conflicts"));
        type Seen<'a> = (&'a str, Option<&'a str>, Option<u64>, Option<&'a str>);
        let seen: Vec<Seen> = c
            .comments
            .iter()
            .map(|x| (x.body.as_str(), x.path.as_deref(), x.line, x.verdict.as_deref()))
            .collect();
        assert_eq!(
            seen,
            [("First", None, None, None), ("Off by one?", Some("src/a.rs"), Some(12), None), ("Ship it", None, None, Some("APPROVED"))]
        );
    }

    #[test]
    fn gitlab_conversation_reads_notes_and_merge_status() {
        let (addr, _) = serve(vec![
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9/notes", json!([
                { "author": { "username": "bot" }, "body": "added 1 commit", "created_at": "2026-10-01T00:00:00Z", "system": true },
                { "author": { "username": "ada" }, "body": "Rename this", "created_at": "2026-10-02T00:00:00Z", "system": false,
                  "position": { "new_path": "lib.rs", "new_line": 3 } }
            ])),
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9", json!({ "description": "Body", "state": "opened", "detailed_merge_status": "not_approved" })),
        ]);
        let c = conversation_in(&project("gitlab", &format!("{addr}/api/v4"), "me"), "tok", 9).unwrap();
        assert_eq!((c.mergeable, c.merge_status.as_str()), (Some(false), "not approved"));
        assert!(c.comments[0].system && !c.comments[1].system);
        assert_eq!((c.comments[1].path.as_deref(), c.comments[1].line), (Some("lib.rs"), Some(3)));
        // No GraphQL here: the app renders the text itself.
        assert!(c.description_html.is_none() && c.comments.iter().all(|x| x.html.is_none()));
    }

    #[test]
    fn gitlab_conversation_takes_gitlabs_html() {
        let (addr, log, bodies) = serve_bodies(vec![
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9/notes", json!([
                { "id": 11, "author": { "username": "ada" }, "body": "See #12", "created_at": "2026-10-02T00:00:00Z", "system": false,
                  "position": { "new_path": "lib.rs", "new_line": 3 } },
                { "id": 12, "author": { "username": "grace" }, "body": "ok", "created_at": "2026-10-03T00:00:00Z", "system": false }
            ])),
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9", json!({ "description": "**Body**", "state": "opened" })),
            ("POST /api/graphql", json!({ "data": { "project": { "mergeRequest": {
                "descriptionHtml": "<p><strong>Body</strong></p>",
                "notes": { "nodes": [
                    { "id": "gid://gitlab/DiffNote/11", "bodyHtml": "<p>See <a href=\"/team/app/-/issues/12\" class=\"gfm\">#12</a></p>" }
                ] }
            } } } })),
        ]);
        let p = Project { graphql: format!("{addr}/api/graphql"), ..project("gitlab", &format!("{addr}/api/v4"), "me") };
        let c = conversation_in(&p, "tok", 9).unwrap();
        assert_eq!(c.description_html.as_deref(), Some("<p><strong>Body</strong></p>"));
        assert!(c.comments[0].html.as_deref().unwrap().contains("issues/12"));
        // Not in GitLab's answer: rendered by the app.
        assert_eq!(c.comments[1].html, None);
        let bodies = bodies.lock().unwrap();
        let (_, sent) = bodies.iter().find(|(r, _)| r == "POST /api/graphql").unwrap();
        assert_eq!(sent["variables"], json!({ "path": "team/app", "iid": "9" }));
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));
        assert_eq!(gid_number("gid://gitlab/Note/77"), Some(77));
    }

    #[test]
    fn merging_deletes_only_the_projects_own_branch() {
        let (addr, log, bodies) = serve_bodies(vec![
            ("PUT /repos/team/app/pulls/4/merge", json!({ "merged": true })),
            ("DELETE /repos/team/app/git/refs/heads/feature", json!({})),
            ("GET /repos/team/app/pulls/4", json!({ "head": { "ref": "feature", "repo": { "full_name": "team/app" } } })),
            ("POST /repos/team/app/issues/4/comments", json!({})),
        ]);
        let p = project("github", &addr, "me");
        assert_eq!(merge_in(&p, "tok", 4, "squash", true, false).unwrap(), "merged");
        comment_in(&p, "tok", 4, "Thanks").unwrap();
        assert!(comment_in(&p, "tok", 4, "  ").is_err());
        assert!(merge_in(&p, "tok", 4, "octopus", false, false).is_err());
        let log = log.lock().unwrap();
        assert!(log.iter().any(|l| l.starts_with("DELETE /repos/team/app/git/refs/heads/feature")), "{log:?}");
        let bodies = bodies.lock().unwrap();
        let sent = |r: &str| bodies.iter().find(|(x, _)| x == r).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(sent("PUT /repos/team/app/pulls/4/merge")["merge_method"], "squash");
        assert_eq!(sent("POST /repos/team/app/issues/4/comments")["body"], "Thanks");

        let (addr, log, _) = serve_bodies(vec![
            ("PUT /repos/team/app/pulls/5/merge", json!({ "merged": true })),
            ("GET /repos/team/app/pulls/5", json!({ "head": { "ref": "feature", "repo": { "full_name": "someone/fork" } } })),
        ]);
        merge_in(&project("github", &addr, "me"), "tok", 5, "merge", true, false).unwrap();
        assert!(!log.lock().unwrap().iter().any(|l| l.starts_with("DELETE")), "a fork's branch isn't ours to delete");

        let (addr, _, bodies) = serve_bodies(vec![("PUT /api/v4/projects/team%2Fapp/merge_requests/9/merge", json!({}))]);
        let gl = project("gitlab", &format!("{addr}/api/v4"), "me");
        merge_in(&gl, "tok", 9, "squash", true, false).unwrap();
        assert_eq!(bodies.lock().unwrap()[0].1, json!({ "squash": true, "should_remove_source_branch": true }));
        assert!(merge_in(&gl, "tok", 9, "rebase", false, false).is_err());
    }

    #[test]
    fn merging_when_checks_pass() {
        let (addr, log, bodies) = serve_bodies(vec![
            ("GET /repos/team/app/pulls/4", json!({ "node_id": "PR_kw4", "head": { "ref": "feature", "repo": { "full_name": "team/app" } } })),
            ("POST /graphql", json!({ "data": { "enablePullRequestAutoMerge": { "clientMutationId": null } } })),
        ]);
        let p = project("github", &addr, "me");
        assert_eq!(merge_in(&p, "tok", 4, "squash", true, true).unwrap(), "scheduled");
        let sent = bodies.lock().unwrap().iter().find(|(r, _)| r == "POST /graphql").unwrap().1.clone();
        assert_eq!(sent["variables"], json!({ "id": "PR_kw4", "method": "SQUASH" }));
        // Not merged now, nothing deleted.
        assert!(!log.lock().unwrap().iter().any(|l| l.starts_with("PUT") || l.starts_with("DELETE")));

        let (addr, _) = serve(vec![
            ("GET /repos/team/app/pulls/4", json!({ "node_id": "PR_kw4" })),
            ("POST /graphql", json!({ "errors": [{ "message": "Pull request Auto merge is not allowed for this repository" }] })),
        ]);
        let err = merge_in(&project("github", &addr, "me"), "tok", 4, "merge", false, true).unwrap_err();
        assert!(err.to_string().contains("Auto merge is not allowed"), "{err}");

        // GitLab: scheduled while the pipeline runs, merged if it's done.
        let (addr, _, bodies) = serve_bodies(vec![("PUT /api/v4/projects/team%2Fapp/merge_requests/9/merge", json!({ "state": "opened" }))]);
        let gl = project("gitlab", &format!("{addr}/api/v4"), "me");
        assert_eq!(merge_in(&gl, "tok", 9, "merge", false, true).unwrap(), "scheduled");
        let sent = bodies.lock().unwrap()[0].1.clone();
        assert_eq!((sent["merge_when_pipeline_succeeds"].as_bool(), sent["auto_merge"].as_bool()), (Some(true), Some(true)));
        let (addr, _) = serve(vec![("PUT /api/v4/projects/team%2Fapp/merge_requests/9/merge", json!({ "state": "merged" }))]);
        let gl = project("gitlab", &format!("{addr}/api/v4"), "me");
        assert_eq!(merge_in(&gl, "tok", 9, "merge", false, true).unwrap(), "merged");
    }

    #[test]
    fn ci_comes_from_gitlab_pipelines_and_github_rollups() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let (addr, _) = serve(vec![("GET /api/v4/projects/team%2Fapp/pipelines", json!([
            { "sha": a, "status": "running", "web_url": "https://git.test/p/3" },
            { "sha": a, "status": "failed", "web_url": "https://git.test/p/2" },
            { "sha": b, "status": "success", "web_url": "https://git.test/p/1" },
            { "sha": "c".repeat(40), "status": "success", "web_url": "https://git.test/p/0" }
        ]))]);
        let gl = ci_in(&project("gitlab", &format!("{addr}/api/v4"), "me"), "tok", &[a.clone(), b.clone()]).unwrap();
        // The newest pipeline of a commit wins; commits not asked for stay out.
        assert_eq!(gl.len(), 2);
        assert_eq!(gl[&a], Ci { state: "running".into(), url: "https://git.test/p/3".into() });
        assert_eq!(gl[&b].state, "success");

        let (addr, _, bodies) = serve_bodies(vec![("POST /graphql", json!({ "data": { "repository": {
            "c0": { "statusCheckRollup": { "state": "FAILURE" } },
            "c1": { "statusCheckRollup": null }
        } } }))]);
        let gh = ci_in(&project("github", &addr, "me"), "tok", &[a.clone(), b.clone(), "not-a-sha\") { x }".into()]).unwrap();
        assert_eq!(gh.len(), 1);
        assert_eq!(gh[&a], Ci { state: "failed".into(), url: format!("https://git.test/team/app/commit/{a}/checks") });
        let query = bodies.lock().unwrap()[0].1["query"].as_str().unwrap().to_owned();
        assert!(query.contains(&format!("c0: object(oid: \"{a}\")")) && !query.contains("not-a-sha"), "{query}");
        assert_eq!(ci_state("EXPECTED").as_deref(), Some("pending"));
        assert_eq!(ci_state("weird"), None);
    }

    #[test]
    fn line_comments_carry_the_position_each_service_wants() {
        let at = LineRef { path: "src/a.rs".into(), old_path: None, new_line: Some(12), old_line: Some(10) };
        let (addr, _, bodies) = serve_bodies(vec![
            ("POST /repos/team/app/pulls/4/comments", json!({})),
            ("GET /repos/team/app/pulls/4", json!({ "head": { "sha": "abc" } })),
        ]);
        line_comment_in(&project("github", &addr, "me"), "tok", 4, &at, "Off by one?").unwrap();
        let old_only = LineRef { new_line: None, old_line: Some(7), ..at };
        line_comment_in(&project("github", &addr, "me"), "tok", 4, &old_only, "Why gone?").unwrap();
        let sent: Vec<Value> = bodies.lock().unwrap().iter().filter(|(r, _)| r.starts_with("POST")).map(|(_, v)| v.clone()).collect();
        assert_eq!(sent[0], json!({ "body": "Off by one?", "commit_id": "abc", "path": "src/a.rs", "line": 12, "side": "RIGHT" }));
        assert_eq!((sent[1]["line"].as_u64(), sent[1]["side"].as_str()), (Some(7), Some("LEFT")));

        let (addr, _, bodies) = serve_bodies(vec![
            ("POST /api/v4/projects/team%2Fapp/merge_requests/9/discussions", json!({})),
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9", json!({ "diff_refs": { "base_sha": "b", "start_sha": "s", "head_sha": "h" } })),
        ]);
        let gl = project("gitlab", &format!("{addr}/api/v4"), "me");
        let renamed = LineRef { path: "new.rs".into(), old_path: Some("old.rs".into()), new_line: Some(3), old_line: None };
        line_comment_in(&gl, "tok", 9, &renamed, "Nice").unwrap();
        let sent = bodies.lock().unwrap().iter().find(|(r, _)| r.starts_with("POST")).unwrap().1.clone();
        assert_eq!(
            sent["position"],
            json!({ "position_type": "text", "base_sha": "b", "start_sha": "s", "head_sha": "h", "new_path": "new.rs", "old_path": "old.rs", "new_line": 3 })
        );
        assert!(line_comment_in(&gl, "tok", 9, &LineRef { new_line: None, old_line: None, ..renamed }, "x").is_err());
    }

    #[test]
    fn releases_are_made_from_tags() {
        let new = NewRelease { tag: "v1.2.0".into(), name: " ".into(), notes: "- Fix it".into(), draft: true, prerelease: false };
        let (addr, _, bodies) = serve_bodies(vec![("POST /repos/team/app/releases", json!({ "html_url": "https://github.com/team/app/releases/tag/v1.2.0" }))]);
        let url = release_in(&project("github", &addr, "me"), "tok", &new).unwrap();
        assert_eq!(url, "https://github.com/team/app/releases/tag/v1.2.0");
        assert_eq!(
            bodies.lock().unwrap()[0].1,
            json!({ "tag_name": "v1.2.0", "name": "v1.2.0", "body": "- Fix it", "draft": true, "prerelease": false })
        );

        let (addr, _, bodies) = serve_bodies(vec![("POST /api/v4/projects/team%2Fapp/releases", json!({}))]);
        let url = release_in(&project("gitlab", &format!("{addr}/api/v4"), "me"), "tok", &NewRelease { name: "First".into(), ..new }).unwrap();
        assert_eq!(url, "https://git.test/team/app/-/releases/v1.2.0");
        assert_eq!(bodies.lock().unwrap()[0].1, json!({ "tag_name": "v1.2.0", "name": "First", "description": "- Fix it" }));
    }

    #[test]
    fn error_details_come_from_every_shape() {
        assert_eq!(error_detail(&json!({ "message": ["Another open merge request already exists"] })), "Another open merge request already exists");
        assert_eq!(error_detail(&json!({ "message": { "title": ["can't be blank"] } })), "title can't be blank");
        assert_eq!(
            error_detail(&json!({ "message": "Validation Failed", "errors": [{ "message": "A pull request already exists for me:feature." }] })),
            "Validation Failed; A pull request already exists for me:feature."
        );
        assert_eq!(error_detail(&json!({ "error": "insufficient_scope" })), "insufficient_scope");
    }

    pub(super) fn project(provider: &str, api: &str, username: &str) -> Project {
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

// ---------------------------------------------------------------------------
// Opening a request

/// Someone who can be asked to review.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: u64,
    pub username: String,
    pub name: Option<String>,
}

/// What the "new request" form needs to know about the remote's project.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestForm {
    pub provider: String,
    pub project: String,
    pub default_branch: String,
    /// People who may review; empty if the token can't list them.
    pub people: Vec<Person>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRequest {
    pub source: String,
    pub target: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
    /// Ids of `Person`s to ask for a review.
    pub reviewers: Vec<u64>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub number: u64,
    pub url: String,
    /// The request was made but something after it (asking reviewers) failed.
    pub warning: Option<String>,
}

pub fn request_form(repo: &Path, remote: &str) -> Result<RequestForm> {
    let (p, token) = project_of_remote(repo, remote)?;
    form_in(&p, &token)
}

fn form_in(p: &Project, token: &str) -> Result<RequestForm> {
    let token = token.to_owned();
    let (default_branch, people) = match p.provider.as_str() {
        "github" => {
            let info = get(&format!("{}/repos/{}", p.api, p.path), &token)?;
            // Only people with push access may list collaborators.
            let people = get(&format!("{}/repos/{}/collaborators?per_page=100", p.api, p.path), &token)
                .map(|v| {
                    v.as_array()
                        .into_iter()
                        .flatten()
                        .map(|u| Person { id: u["id"].as_u64().unwrap_or(0), username: text(&u["login"]), name: None })
                        .collect()
                })
                .unwrap_or_default();
            (text(&info["default_branch"]), people)
        }
        _ => {
            let base = format!("{}/projects/{}", p.api, encode(&p.path));
            let info = get(&base, &token)?;
            let people = get(&format!("{base}/members/all?per_page=100"), &token)
                .map(|v| {
                    v.as_array()
                        .into_iter()
                        .flatten()
                        .filter(|u| u["state"].as_str().is_none_or(|s| s == "active"))
                        .map(|u| Person {
                            id: u["id"].as_u64().unwrap_or(0),
                            username: text(&u["username"]),
                            name: u["name"].as_str().map(str::to_owned),
                        })
                        .collect()
                })
                .unwrap_or_default();
            (text(&info["default_branch"]), people)
        }
    };
    let mut people: Vec<Person> = people;
    people.retain(|u| !u.username.is_empty() && !u.username.eq_ignore_ascii_case(&p.username));
    people.sort_by_key(|u| u.username.to_lowercase());
    people.dedup_by_key(|u| u.id);
    Ok(RequestForm { provider: p.provider.clone(), project: format!("{}/{}", p.host, p.path), default_branch, people })
}

pub fn create(repo: &Path, remote: &str, new: &NewRequest) -> Result<Created> {
    let (p, token) = project_of_remote(repo, remote)?;
    create_in(&p, &token, new)
}

fn create_in(p: &Project, token: &str, new: &NewRequest) -> Result<Created> {
    let token = token.to_owned();
    if new.title.trim().is_empty() {
        return Err(Error::msg("Give the request a title"));
    }
    if new.source == new.target {
        return Err(Error::msg("The source and target branches are the same"));
    }
    match p.provider.as_str() {
        "github" => {
            let body = json!({
                "title": new.title.trim(),
                "head": new.source,
                "base": new.target,
                "body": new.body,
                "draft": new.draft,
            });
            let pr = request("POST", &format!("{}/repos/{}/pulls", p.api, p.path), &token, Some(&body))?;
            let number = pr["number"].as_u64().ok_or_else(|| Error::msg(format!("Unexpected answer from {}", p.host)))?;
            let mut warning = None;
            if !new.reviewers.is_empty() {
                // GitHub asks for logins; the form knows people by id.
                let form = form_in(p, &token).map(|f| f.people).unwrap_or_default();
                let logins: Vec<&str> = form
                    .iter()
                    .filter(|u| new.reviewers.contains(&u.id))
                    .map(|u| u.username.as_str())
                    .collect();
                let url = format!("{}/repos/{}/pulls/{number}/requested_reviewers", p.api, p.path);
                if let Err(e) = request("POST", &url, &token, Some(&json!({ "reviewers": logins }))) {
                    warning = Some(format!("Reviewers weren't added: {e}"));
                }
            }
            Ok(Created { number, url: text(&pr["html_url"]), warning })
        }
        _ => {
            let title = if new.draft { format!("Draft: {}", new.title.trim()) } else { new.title.trim().to_owned() };
            let body = json!({
                "source_branch": new.source,
                "target_branch": new.target,
                "title": title,
                "description": new.body,
                "reviewer_ids": new.reviewers,
            });
            let url = format!("{}/projects/{}/merge_requests", p.api, encode(&p.path));
            let mr = request("POST", &url, &token, Some(&body))?;
            let number = mr["iid"].as_u64().ok_or_else(|| Error::msg(format!("Unexpected answer from {}", p.host)))?;
            Ok(Created { number, url: text(&mr["web_url"]), warning: None })
        }
    }
}

// ---------------------------------------------------------------------------
// Reviewing a request

/// A comment on a request: on the whole of it, or on a line of a file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub author: String,
    pub body: String,
    /// The body as the service renders it, when it said.
    pub html: Option<String>,
    /// ISO 8601.
    pub created: String,
    pub path: Option<String>,
    pub line: Option<u64>,
    /// A review's verdict on GitHub (`APPROVED`, `CHANGES_REQUESTED`).
    pub verdict: Option<String>,
    /// Made by the service ("added 2 commits"), not a person.
    pub system: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub description: String,
    /// The description as the service renders it, when it said.
    pub description_html: Option<String>,
    pub comments: Vec<Comment>,
    /// Still open (not merged or closed meanwhile).
    pub open: bool,
    /// The service's word on merging: `None` while it is still working it out.
    pub mergeable: Option<bool>,
    /// Why it can't be merged, in the service's words.
    pub merge_status: String,
}

fn github_comment(c: &Value, path: bool) -> Comment {
    Comment {
        author: c["user"]["login"].as_str().unwrap_or("ghost").to_owned(),
        body: text(&c["body"]),
        html: c["body_html"].as_str().map(str::to_owned),
        created: c["created_at"].as_str().or_else(|| c["submitted_at"].as_str()).unwrap_or("").to_owned(),
        path: path.then(|| text(&c["path"])).filter(|p| !p.is_empty()),
        line: if path { c["line"].as_u64().or_else(|| c["original_line"].as_u64()) } else { None },
        verdict: None,
        system: false,
    }
}

/// A merge request's description and notes as GitLab renders them.
#[derive(Default)]
struct GitlabHtml {
    description: Option<String>,
    /// By note id.
    notes: HashMap<u64, String>,
}

const GITLAB_MR_HTML: &str = "query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      descriptionHtml
      notes(first: 100) { nodes { id bodyHtml } }
    }
  }
}";

/// The number at the end of a GraphQL id (`gid://gitlab/DiffNote/123`).
fn gid_number(id: &str) -> Option<u64> {
    id.rsplit('/').next()?.parse().ok()
}

/// Empty when GitLab can't say (an old server, a token without API
/// access): the text is then rendered by the app.
fn gitlab_html(p: &Project, token: &str, number: u64) -> GitlabHtml {
    let body = json!({ "query": GITLAB_MR_HTML, "variables": { "path": p.path, "iid": number.to_string() } });
    let Ok(data) = request("POST", &p.graphql, token, Some(&body)) else { return GitlabHtml::default() };
    let mr = &data["data"]["project"]["mergeRequest"];
    GitlabHtml {
        description: mr["descriptionHtml"].as_str().map(str::to_owned),
        notes: mr["notes"]["nodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| Some((gid_number(n["id"].as_str()?)?, n["bodyHtml"].as_str()?.to_owned())))
            .collect(),
    }
}

fn conversation_in(p: &Project, token: &str, number: u64) -> Result<Conversation> {
    let mut comments = Vec::new();
    let out = match p.provider.as_str() {
        "github" => {
            let base = format!("{}/repos/{}", p.api, p.path);
            let full = |url: &str| request_as("GET", url, token, None, GITHUB_FULL);
            let pr = full(&format!("{base}/pulls/{number}"))?;
            let list = |url: String| full(&url).map(|v| v.as_array().cloned().unwrap_or_default());
            for c in list(format!("{base}/issues/{number}/comments?per_page=100"))? {
                comments.push(github_comment(&c, false));
            }
            for c in list(format!("{base}/pulls/{number}/comments?per_page=100"))? {
                comments.push(github_comment(&c, true));
            }
            for r in list(format!("{base}/pulls/{number}/reviews?per_page=100"))? {
                let state = text(&r["state"]);
                // Inline-only reviews leave an empty "COMMENTED" entry behind.
                if state == "COMMENTED" && text(&r["body"]).trim().is_empty() {
                    continue;
                }
                comments.push(Comment { verdict: Some(state), ..github_comment(&r, false) });
            }
            let state = text(&pr["mergeable_state"]);
            Conversation {
                description: text(&pr["body"]),
                description_html: pr["body_html"].as_str().map(str::to_owned),
                comments: Vec::new(),
                open: pr["state"].as_str() == Some("open") && !pr["merged"].as_bool().unwrap_or(false),
                mergeable: pr["mergeable"].as_bool(),
                merge_status: match state.as_str() {
                    "dirty" => "has conflicts".into(),
                    "blocked" => "blocked by required reviews or checks".into(),
                    "behind" => "behind the target branch".into(),
                    "unstable" => "checks are failing".into(),
                    "draft" => "draft".into(),
                    _ => state,
                },
            }
        }
        _ => {
            let base = format!("{}/projects/{}/merge_requests/{number}", p.api, encode(&p.path));
            let mr = get(&base, token)?;
            let notes = get(&format!("{base}/notes?sort=asc&order_by=created_at&per_page=100"), token)?;
            let html = gitlab_html(p, token, number);
            for n in notes.as_array().into_iter().flatten() {
                let position = &n["position"];
                comments.push(Comment {
                    author: text(&n["author"]["username"]),
                    body: text(&n["body"]),
                    html: n["id"].as_u64().and_then(|id| html.notes.get(&id).cloned()),
                    created: text(&n["created_at"]),
                    path: position["new_path"].as_str().or_else(|| position["old_path"].as_str()).map(str::to_owned),
                    line: position["new_line"].as_u64().or_else(|| position["old_line"].as_u64()),
                    verdict: None,
                    system: n["system"].as_bool().unwrap_or(false),
                });
            }
            let status = mr["detailed_merge_status"].as_str().or_else(|| mr["merge_status"].as_str()).unwrap_or("").to_owned();
            Conversation {
                description: text(&mr["description"]),
                description_html: html.description,
                comments: Vec::new(),
                open: mr["state"].as_str() == Some("opened"),
                mergeable: match status.as_str() {
                    "mergeable" | "can_be_merged" => Some(true),
                    "checking" | "unchecked" | "preparing" | "approvals_syncing" | "" => None,
                    _ => Some(false),
                },
                merge_status: status.replace('_', " "),
            }
        }
    };
    comments.sort_by(|a, b| a.created.cmp(&b.created));
    Ok(Conversation { comments, ..out })
}

fn comment_in(p: &Project, token: &str, number: u64, body: &str) -> Result<()> {
    if body.trim().is_empty() {
        return Err(Error::msg("Write something first"));
    }
    let url = match p.provider.as_str() {
        "github" => format!("{}/repos/{}/issues/{number}/comments", p.api, p.path),
        _ => format!("{}/projects/{}/merge_requests/{number}/notes", p.api, encode(&p.path)),
    };
    request("POST", &url, token, Some(&json!({ "body": body })))?;
    Ok(())
}

/// Where a line comment goes: the file (and its old path when renamed),
/// and the line on the new side, the old side, or both (context lines).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRef {
    pub path: String,
    pub old_path: Option<String>,
    pub new_line: Option<u64>,
    pub old_line: Option<u64>,
}

fn line_comment_in(p: &Project, token: &str, number: u64, at: &LineRef, body: &str) -> Result<()> {
    if body.trim().is_empty() {
        return Err(Error::msg("Write something first"));
    }
    if at.new_line.is_none() && at.old_line.is_none() {
        return Err(Error::msg("No line to comment on"));
    }
    match p.provider.as_str() {
        "github" => {
            let base = format!("{}/repos/{}/pulls/{number}", p.api, p.path);
            let pr = get(&base, token)?;
            let (line, side) = match (at.new_line, at.old_line) {
                (Some(n), _) => (n, "RIGHT"),
                (None, Some(o)) => (o, "LEFT"),
                _ => unreachable!("checked above"),
            };
            let body = json!({ "body": body, "commit_id": text(&pr["head"]["sha"]), "path": at.path, "line": line, "side": side });
            request("POST", &format!("{base}/comments"), token, Some(&body))?;
        }
        _ => {
            let base = format!("{}/projects/{}/merge_requests/{number}", p.api, encode(&p.path));
            let mr = get(&base, token)?;
            let refs = &mr["diff_refs"];
            let mut position = json!({
                "position_type": "text",
                "base_sha": refs["base_sha"],
                "start_sha": refs["start_sha"],
                "head_sha": refs["head_sha"],
                "new_path": at.path,
                "old_path": at.old_path.as_deref().unwrap_or(&at.path),
            });
            if let Some(n) = at.new_line {
                position["new_line"] = json!(n);
            }
            if let Some(o) = at.old_line {
                position["old_line"] = json!(o);
            }
            request("POST", &format!("{base}/discussions"), token, Some(&json!({ "body": body, "position": position })))?;
        }
    }
    Ok(())
}

pub fn line_comment(repo: &Path, remote: &str, number: u64, at: &LineRef, body: &str) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    line_comment_in(&p, &token, number, at, body)
}

/// How to merge: `merge` (a merge commit), `squash`, or `rebase` (GitHub).
/// With `when_checks_pass`, the service merges once CI succeeds (GitHub's
/// auto-merge, GitLab's "merge when pipeline succeeds"); the answer says
/// whether it merged now (`merged`) or later (`scheduled`).
fn merge_in(p: &Project, token: &str, number: u64, method: &str, delete_branch: bool, when_checks_pass: bool) -> Result<String> {
    match p.provider.as_str() {
        "github" => {
            let graphql_method = match method {
                "merge" => "MERGE",
                "squash" => "SQUASH",
                "rebase" => "REBASE",
                _ => return Err(Error::msg(format!("Unknown merge method {method}"))),
            };
            let base = format!("{}/repos/{}", p.api, p.path);
            let pr = get(&format!("{base}/pulls/{number}"), token)?;
            if when_checks_pass {
                // Whether the branch goes afterwards is the repository's setting.
                let query = "mutation($id: ID!, $method: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) { clientMutationId }
}";
                let body = json!({ "query": query, "variables": { "id": text(&pr["node_id"]), "method": graphql_method } });
                let data = request("POST", &p.graphql, token, Some(&body))?;
                if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
                    return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
                }
                return Ok("scheduled".into());
            }
            request("PUT", &format!("{base}/pulls/{number}/merge"), token, Some(&json!({ "merge_method": method })))?;
            // Only the project's own branch, never a fork's.
            let same_repo = pr["head"]["repo"]["full_name"].as_str() == Some(p.path.as_str());
            if delete_branch && same_repo {
                let branch = text(&pr["head"]["ref"]);
                request("DELETE", &format!("{base}/git/refs/heads/{branch}"), token, None)
                    .map_err(|e| Error::msg(format!("Merged, but the branch wasn't deleted: {e}")))?;
            }
            Ok("merged".into())
        }
        _ => {
            if !matches!(method, "merge" | "squash") {
                return Err(Error::msg(format!("GitLab can't merge with {method}")));
            }
            let url = format!("{}/projects/{}/merge_requests/{number}/merge", p.api, encode(&p.path));
            let mut body = json!({ "squash": method == "squash", "should_remove_source_branch": delete_branch });
            if when_checks_pass {
                // `auto_merge` from GitLab 17.11; older ones know the first.
                body["merge_when_pipeline_succeeds"] = json!(true);
                body["auto_merge"] = json!(true);
            }
            let mr = request("PUT", &url, token, Some(&body))?;
            Ok(if when_checks_pass && mr["state"].as_str() != Some("merged") { "scheduled" } else { "merged" }.into())
        }
    }
}

pub fn conversation(repo: &Path, remote: &str, number: u64) -> Result<Conversation> {
    let (p, token) = project_of_remote(repo, remote)?;
    conversation_in(&p, &token, number)
}

pub fn comment(repo: &Path, remote: &str, number: u64, body: &str) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    comment_in(&p, &token, number, body)
}

pub fn merge(repo: &Path, remote: &str, number: u64, method: &str, delete_branch: bool, when_checks_pass: bool) -> Result<String> {
    let (p, token) = project_of_remote(repo, remote)?;
    merge_in(&p, &token, number, method, delete_branch, when_checks_pass)
}

/// A request's conversation and range against a real service, with this
/// machine's accounts: `GITBRIX_LIVE_URL=… GITBRIX_LIVE_NUMBER=1 cargo test
/// live_review -- --ignored --nocapture`. Only reads.
#[cfg(test)]
#[test]
#[ignore]
fn live_review() {
    let url = std::env::var("GITBRIX_LIVE_URL").expect("GITBRIX_LIVE_URL");
    let number: u64 = std::env::var("GITBRIX_LIVE_NUMBER").expect("GITBRIX_LIVE_NUMBER").parse().unwrap();
    let home = std::env::var("HOME").unwrap();
    accounts::init(Path::new(&home).join(".config/dev.gitbrix.app"));
    let dir = tempfile::TempDir::new().unwrap();
    let r = git2::Repository::init(dir.path()).unwrap();
    r.remote("origin", &url).unwrap();
    let c = conversation(dir.path(), "origin", number).unwrap();
    println!("{c:#?}");
    let provider = provider_of_remote(dir.path(), "origin").unwrap();
    let range = crate::git::net::pull_request_range(dir.path(), "origin", &provider, number, "main", &mut |_| {}).unwrap();
    println!("{range:?}");
}

// ---------------------------------------------------------------------------
// CI

/// CI status of a commit, and where to see it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ci {
    pub state: String,
    pub url: String,
}

/// One word for the services' many: see `PullRequest::ci`.
fn ci_state(s: &str) -> Option<String> {
    Some(
        match s.to_ascii_lowercase().as_str() {
            "success" => "success",
            "failure" | "failed" | "error" => "failed",
            "running" => "running",
            "pending" | "expected" | "created" | "waiting_for_resource" | "preparing" | "scheduled" => "pending",
            "canceled" | "cancelled" => "canceled",
            "skipped" => "skipped",
            "manual" => "manual",
            _ => return None,
        }
        .to_owned(),
    )
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// GitHub: one GraphQL query asks for many commits by alias.
fn github_ci(p: &Project, token: &str, shas: &[String]) -> Result<HashMap<String, Ci>> {
    let (owner, name) = p.path.split_once('/').ok_or_else(|| Error::msg("Not a GitHub repository path"))?;
    let mut out = HashMap::new();
    let shas: Vec<&String> = shas.iter().filter(|s| is_sha(s)).collect();
    for chunk in shas.chunks(50) {
        let fields: String = chunk
            .iter()
            .enumerate()
            .map(|(i, sha)| format!("c{i}: object(oid: \"{sha}\") {{ ... on Commit {{ statusCheckRollup {{ state }} }} }}\n"))
            .collect();
        let query = format!("query($owner: String!, $name: String!) {{ repository(owner: $owner, name: $name) {{\n{fields}}} }}");
        let body = json!({ "query": query, "variables": { "owner": owner, "name": name } });
        let data = request("POST", &p.graphql, token, Some(&body))?;
        if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
            return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
        }
        let repo = &data["data"]["repository"];
        for (i, sha) in chunk.iter().enumerate() {
            if let Some(state) = repo[format!("c{i}")]["statusCheckRollup"]["state"].as_str().and_then(ci_state) {
                out.insert((*sha).clone(), Ci { state, url: format!("https://{}/{}/commit/{sha}/checks", p.host, p.path) });
            }
        }
    }
    Ok(out)
}

/// CI status of the given commits, from the project of the first remote
/// (origin first) an account covers. Commits without CI are left out.
pub fn ci_statuses(repo: &Path, shas: &[String]) -> Result<HashMap<String, Ci>> {
    let all = accounts::usable(Some(repo))?;
    let Some((p, account)) = remotes(repo)?.into_iter().find_map(|(_, url)| project_for(&url, &all)) else {
        return Ok(HashMap::new());
    };
    let token = accounts::token(&account).ok_or_else(|| Error::msg("The account's token isn't in the system keyring"))?;
    ci_in(&p, &token, shas)
}

fn ci_in(p: &Project, token: &str, shas: &[String]) -> Result<HashMap<String, Ci>> {
    match p.provider.as_str() {
        "github" => github_ci(p, token, shas),
        _ => Ok(gitlab_pipelines(p, token)?.into_iter().filter(|(sha, _)| shas.contains(sha)).collect()),
    }
}

// ---------------------------------------------------------------------------
// Releases

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRelease {
    pub tag: String,
    pub name: String,
    pub notes: String,
    /// GitHub only.
    pub draft: bool,
    /// GitHub only.
    pub prerelease: bool,
}

/// Make a release of a tag that is already on the remote; returns its page.
fn release_in(p: &Project, token: &str, new: &NewRelease) -> Result<String> {
    if new.tag.trim().is_empty() {
        return Err(Error::msg("Pick a tag"));
    }
    let name = if new.name.trim().is_empty() { new.tag.clone() } else { new.name.trim().to_owned() };
    match p.provider.as_str() {
        "github" => {
            let body = json!({ "tag_name": new.tag, "name": name, "body": new.notes, "draft": new.draft, "prerelease": new.prerelease });
            let rel = request("POST", &format!("{}/repos/{}/releases", p.api, p.path), token, Some(&body))?;
            Ok(text(&rel["html_url"]))
        }
        _ => {
            let body = json!({ "tag_name": new.tag, "name": name, "description": new.notes });
            request("POST", &format!("{}/projects/{}/releases", p.api, encode(&p.path)), token, Some(&body))?;
            Ok(format!("https://{}/{}/-/releases/{}", p.host, p.path, encode(&new.tag)))
        }
    }
}

pub fn release(repo: &Path, remote: &str, new: &NewRelease) -> Result<String> {
    let (p, token) = project_of_remote(repo, remote)?;
    release_in(&p, &token, new)
}
