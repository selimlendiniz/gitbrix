//! Open issues of a repository's remotes, with the same accounts (and the
//! same rules for the token) as the pull requests.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};

use super::{
    Comment, Created, GITHUB_FULL, Project, each_project, encode, get, gid_number, github_comment, gitlab_me, project_of_remote, request, request_as, text,
};
use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub name: String,
    /// `#rrggbb`, or empty when the service doesn't say.
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// `github` or `gitlab`.
    pub provider: String,
    /// The remote it was found through.
    pub remote: String,
    /// `host/owner/repo`.
    pub project: String,
    /// GitHub's issue number or GitLab's iid.
    pub number: u64,
    pub title: String,
    /// Markdown, cut at `BODY_LIMIT` characters.
    pub body: String,
    /// The body as the service renders it, when it said.
    pub body_html: Option<String>,
    pub author: String,
    pub url: String,
    pub labels: Vec<Label>,
    pub assignees: Vec<String>,
    pub assigned_to_me: bool,
    /// Opened by the account's user.
    pub mine: bool,
    pub comments: u64,
    /// ISO 8601.
    pub created: String,
    pub updated: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issues {
    pub items: Vec<Issue>,
    /// Remotes that couldn't be listed, with the reason.
    pub problems: Vec<String>,
    /// Some remote had an account.
    pub covered: bool,
    /// Projects listed without error, empty ones too.
    pub projects: Vec<String>,
}

const BODY_LIMIT: usize = 20_000;
/// Longer rendered bodies are left to the app (from the cut text).
const HTML_LIMIT: usize = 200_000;

fn body(v: &Value) -> String {
    let s = v.as_str().unwrap_or("");
    match s.char_indices().nth(BODY_LIMIT) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

fn color(c: &str) -> String {
    let hex = c.trim().trim_start_matches('#');
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("#{}", hex.to_ascii_lowercase())
    } else {
        String::new()
    }
}

const GITHUB_ISSUES: &str = "query($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    hasIssuesEnabled
    issues(states: OPEN, first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url body bodyHTML createdAt updatedAt
        author { login }
        viewerDidAuthor
        labels(first: 10) { nodes { name color } }
        assignees(first: 10) { nodes { login } }
        comments { totalCount }
      }
    }
  }
}";

fn github_issues(p: &Project, remote: &str, token: &str) -> Result<Vec<Issue>> {
    let (owner, name) = p.path.split_once('/').ok_or_else(|| Error::msg("Not a GitHub repository path"))?;
    let body_json = json!({ "query": GITHUB_ISSUES, "variables": { "owner": owner, "name": name } });
    let data = request("POST", &p.graphql, token, Some(&body_json))?;
    if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
        return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
    }
    let me = text(&data["data"]["viewer"]["login"]);
    let repo = &data["data"]["repository"];
    if repo["hasIssuesEnabled"].as_bool() == Some(false) {
        return Ok(Vec::new());
    }
    let project = format!("{}/{}", p.host, p.path);
    let names = |v: &Value, key: &str| -> Vec<String> {
        v["nodes"].as_array().into_iter().flatten().filter_map(|n| n[key].as_str().map(str::to_owned)).collect()
    };
    Ok(repo["issues"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|n| {
            let assignees = names(&n["assignees"], "login");
            Issue {
                provider: "github".into(),
                remote: remote.to_owned(),
                project: project.clone(),
                number: n["number"].as_u64().unwrap_or(0),
                title: text(&n["title"]),
                body: body(&n["body"]),
                body_html: n["bodyHTML"].as_str().filter(|h| h.len() <= HTML_LIMIT).map(str::to_owned),
                author: n["author"]["login"].as_str().unwrap_or("ghost").to_owned(),
                url: text(&n["url"]),
                labels: n["labels"]["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|l| Label { name: text(&l["name"]), color: color(l["color"].as_str().unwrap_or("")) })
                    .collect(),
                assigned_to_me: !me.is_empty() && assignees.contains(&me),
                assignees,
                mine: n["viewerDidAuthor"].as_bool().unwrap_or(false),
                comments: n["comments"]["totalCount"].as_u64().unwrap_or(0),
                created: text(&n["createdAt"]),
                updated: text(&n["updatedAt"]),
            }
        })
        .collect())
}

fn gitlab_issues(p: &Project, remote: &str, token: &str) -> Result<Vec<Issue>> {
    let url = format!(
        "{}/projects/{}/issues?state=opened&per_page=50&order_by=updated_at&sort=desc&with_labels_details=true",
        p.api,
        encode(&p.path)
    );
    let list = get(&url, token)?;
    let me = gitlab_me(p, token);
    let html = gitlab_issue_html(p, token);
    let project = format!("{}/{}", p.host, p.path);
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let assignees: Vec<String> = i["assignees"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a["username"].as_str().map(str::to_owned))
                .collect();
            let author = text(&i["author"]["username"]);
            Issue {
                provider: "gitlab".into(),
                remote: remote.to_owned(),
                project: project.clone(),
                number: i["iid"].as_u64().unwrap_or(0),
                title: text(&i["title"]),
                body: body(&i["description"]),
                body_html: i["iid"].as_u64().and_then(|n| html.get(&n).cloned()),
                url: text(&i["web_url"]),
                labels: i["labels"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|l| match l.as_str() {
                        // Without details: names only.
                        Some(name) => Label { name: name.to_owned(), color: String::new() },
                        None => Label { name: text(&l["name"]), color: color(l["color"].as_str().unwrap_or("")) },
                    })
                    .collect(),
                assigned_to_me: me.as_ref().is_some_and(|me| assignees.contains(me)),
                assignees,
                mine: me.as_deref() == Some(author.as_str()),
                author,
                comments: i["user_notes_count"].as_u64().unwrap_or(0),
                created: text(&i["created_at"]),
                updated: text(&i["updated_at"]),
            }
        })
        .collect())
}

const GITLAB_ISSUES_HTML: &str = "query($path: ID!) {
  project(fullPath: $path) {
    issues(state: opened, first: 50, sort: UPDATED_DESC) { nodes { iid descriptionHtml } }
  }
}";

/// The open issues' descriptions as GitLab renders them, by iid; empty
/// when GitLab can't say.
fn gitlab_issue_html(p: &Project, token: &str) -> HashMap<u64, String> {
    let body = json!({ "query": GITLAB_ISSUES_HTML, "variables": { "path": p.path } });
    let Ok(data) = request("POST", &p.graphql, token, Some(&body)) else { return HashMap::new() };
    data["data"]["project"]["issues"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|n| {
            let html = n["descriptionHtml"].as_str().filter(|h| h.len() <= HTML_LIMIT)?;
            Some((n["iid"].as_str()?.parse().ok()?, html.to_owned()))
        })
        .collect()
}

fn list_project(p: &Project, remote: &str, token: &str) -> Result<Vec<Issue>> {
    match p.provider.as_str() {
        "github" => github_issues(p, remote, token),
        _ => gitlab_issues(p, remote, token),
    }
}

/// A new issue.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewIssue {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub assign_me: bool,
}

const GITLAB_ISSUE_NOTES_HTML: &str = "query($path: ID!, $iid: String!) {
  project(fullPath: $path) { issue(iid: $iid) { notes(first: 100) { nodes { id bodyHtml } } } }
}";

fn comments_in(p: &Project, token: &str, number: u64) -> Result<Vec<Comment>> {
    let mut out: Vec<Comment> = match p.provider.as_str() {
        "github" => {
            let url = format!("{}/repos/{}/issues/{number}/comments?per_page=100", p.api, p.path);
            request_as("GET", &url, token, None, GITHUB_FULL)?
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| github_comment(c, false))
                .collect()
        }
        _ => {
            let url = format!("{}/projects/{}/issues/{number}/notes?sort=asc&order_by=created_at&per_page=100", p.api, encode(&p.path));
            let notes = get(&url, token)?;
            // GitLab's rendering, when it says.
            let vars = json!({ "query": GITLAB_ISSUE_NOTES_HTML, "variables": { "path": p.path, "iid": number.to_string() } });
            let html: HashMap<u64, String> = request("POST", &p.graphql, token, Some(&vars))
                .map(|d| {
                    d["data"]["project"]["issue"]["notes"]["nodes"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|n| Some((gid_number(n["id"].as_str()?)?, n["bodyHtml"].as_str()?.to_owned())))
                        .collect()
                })
                .unwrap_or_default();
            notes
                .as_array()
                .into_iter()
                .flatten()
                .map(|n| Comment {
                    id: n["id"].as_u64().map(|i| i.to_string()).unwrap_or_default(),
                    thread: None,
                    resolvable: false,
                    resolved: false,
                    author: text(&n["author"]["username"]),
                    body: text(&n["body"]),
                    html: n["id"].as_u64().and_then(|id| html.get(&id).cloned()),
                    created: text(&n["created_at"]),
                    path: None,
                    line: None,
                    start_line: None,
                    verdict: None,
                    system: n["system"].as_bool().unwrap_or(false),
                })
                .collect()
        }
    };
    out.sort_by(|a, b| a.created.cmp(&b.created));
    Ok(out)
}

fn comment_in(p: &Project, token: &str, number: u64, body: &str) -> Result<()> {
    if body.trim().is_empty() {
        return Err(Error::msg("Write something first"));
    }
    let url = match p.provider.as_str() {
        "github" => format!("{}/repos/{}/issues/{number}/comments", p.api, p.path),
        _ => format!("{}/projects/{}/issues/{number}/notes", p.api, encode(&p.path)),
    };
    request("POST", &url, token, Some(&json!({ "body": body })))?;
    Ok(())
}

fn set_open_in(p: &Project, token: &str, number: u64, open: bool) -> Result<()> {
    match p.provider.as_str() {
        "github" => {
            let body = json!({ "state": if open { "open" } else { "closed" } });
            request("PATCH", &format!("{}/repos/{}/issues/{number}", p.api, p.path), token, Some(&body))?;
        }
        _ => {
            let body = json!({ "state_event": if open { "reopen" } else { "close" } });
            request("PUT", &format!("{}/projects/{}/issues/{number}", p.api, encode(&p.path)), token, Some(&body))?;
        }
    }
    Ok(())
}

fn create_in(p: &Project, token: &str, new: &NewIssue) -> Result<Created> {
    let title = new.title.trim();
    if title.is_empty() {
        return Err(Error::msg("Give the issue a title"));
    }
    match p.provider.as_str() {
        "github" => {
            let mut body = json!({ "title": title, "body": new.body, "labels": new.labels });
            if new.assign_me {
                body["assignees"] = json!([p.username]);
            }
            let issue = request("POST", &format!("{}/repos/{}/issues", p.api, p.path), token, Some(&body))?;
            let number = issue["number"].as_u64().ok_or_else(|| Error::msg(format!("Unexpected answer from {}", p.host)))?;
            Ok(Created { number, url: text(&issue["html_url"]), warning: None })
        }
        _ => {
            let mut body = json!({ "title": title, "description": new.body, "labels": new.labels.join(",") });
            let mut warning = None;
            if new.assign_me {
                match get(&format!("{}/user", p.api), token).ok().and_then(|u| u["id"].as_u64()) {
                    Some(id) => body["assignee_ids"] = json!([id]),
                    None => warning = Some("Not assigned: the token can't say whose it is".to_owned()),
                }
            }
            let issue = request("POST", &format!("{}/projects/{}/issues", p.api, encode(&p.path)), token, Some(&body))?;
            let number = issue["iid"].as_u64().ok_or_else(|| Error::msg(format!("Unexpected answer from {}", p.host)))?;
            Ok(Created { number, url: text(&issue["web_url"]), warning })
        }
    }
}

pub fn comments(repo: &Path, remote: &str, number: u64) -> Result<Vec<Comment>> {
    let (p, token) = project_of_remote(repo, remote)?;
    comments_in(&p, &token, number)
}

pub fn comment(repo: &Path, remote: &str, number: u64, body: &str) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    comment_in(&p, &token, number, body)
}

pub fn set_open(repo: &Path, remote: &str, number: u64, open: bool) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    set_open_in(&p, &token, number, open)
}

pub fn create(repo: &Path, remote: &str, new: &NewIssue) -> Result<Created> {
    let (p, token) = project_of_remote(repo, remote)?;
    create_in(&p, &token, new)
}

/// Open issues of every remote an account covers, most recently updated first.
pub fn list(repo: &Path) -> Result<Issues> {
    let l = each_project(repo, "issues", list_project)?;
    let mut out = Issues { items: l.items, problems: l.problems, covered: l.covered, projects: l.projects };
    out.items.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{project, serve};
    use super::super::Project;
    use super::*;

    #[test]
    fn github_issues_with_labels_and_assignees() {
        let (addr, log) = serve(vec![(
            "POST /graphql",
            json!({ "data": {
                "viewer": { "login": "me" },
                "repository": { "hasIssuesEnabled": true, "issues": { "nodes": [
                    { "number": 12, "title": "Login fails", "url": "https://github.com/team/app/issues/12", "body": "Steps…", "bodyHTML": "<p>Steps…</p>",
                      "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-02T00:00:00Z",
                      "author": { "login": "ada" }, "viewerDidAuthor": false,
                      "labels": { "nodes": [{ "name": "bug", "color": "D73A4A" }] },
                      "assignees": { "nodes": [{ "login": "me" }] },
                      "comments": { "totalCount": 3 } },
                    { "number": 9, "title": "Docs", "url": "u", "body": null, "createdAt": "", "updatedAt": "",
                      "author": null, "viewerDidAuthor": true, "labels": { "nodes": [] }, "assignees": { "nodes": [] },
                      "comments": { "totalCount": 0 } }
                ] } }
            } }),
        )]);
        let p = project("github", &addr, "me");
        let issues = github_issues(&p, "origin", "tok").unwrap();
        assert_eq!(issues.len(), 2);
        let i = &issues[0];
        assert_eq!((i.number, i.title.as_str(), i.author.as_str(), i.comments), (12, "Login fails", "ada", 3));
        assert_eq!(i.labels, vec![Label { name: "bug".into(), color: "#d73a4a".into() }]);
        assert!(i.assigned_to_me && !i.mine);
        assert_eq!(i.project, format!("{}/team/app", p.host));
        assert!(issues[1].mine && issues[1].author == "ghost" && issues[1].body.is_empty());
        assert_eq!((i.body_html.as_deref(), issues[1].body_html.as_deref()), (Some("<p>Steps…</p>"), None));
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));
    }

    #[test]
    fn github_issues_off_is_empty() {
        let (addr, _) = serve(vec![(
            "POST /graphql",
            json!({ "data": { "viewer": { "login": "me" }, "repository": { "hasIssuesEnabled": false, "issues": { "nodes": [
                { "number": 1, "title": "x" }
            ] } } } }),
        )]);
        let p = project("github", &addr, "me");
        assert!(github_issues(&p, "origin", "tok").unwrap().is_empty());
    }

    #[test]
    fn gitlab_issues_with_label_details() {
        let (addr, log) = serve(vec![(
            "GET /api/v4/projects/team%2Fapp/issues",
            json!([
                { "iid": 4, "title": "Crash on start", "web_url": "https://git.test/team/app/-/issues/4", "description": "Trace",
                  "author": { "username": "me" }, "assignees": [{ "username": "grace" }],
                  "labels": [{ "name": "bug", "color": "#FF0000" }, "plain"], "user_notes_count": 2,
                  "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-03T00:00:00Z" }
            ]),
        ), (
            "POST /api/graphql",
            json!({ "data": { "project": { "issues": { "nodes": [{ "iid": "4", "descriptionHtml": "<p>Trace</p>" }] } } } }),
        )]);
        let p = Project { graphql: format!("{addr}/api/graphql"), ..project("gitlab", &format!("{addr}/api/v4"), "me") };
        let issues = gitlab_issues(&p, "origin", "tok").unwrap();
        let i = &issues[0];
        assert_eq!(i.body_html.as_deref(), Some("<p>Trace</p>"));
        assert_eq!((i.number, i.title.as_str(), i.comments), (4, "Crash on start", 2));
        assert!(i.mine && !i.assigned_to_me);
        assert_eq!(i.assignees, vec!["grace".to_owned()]);
        assert_eq!(
            i.labels,
            vec![Label { name: "bug".into(), color: "#ff0000".into() }, Label { name: "plain".into(), color: String::new() }]
        );
        let log = log.lock().unwrap();
        assert!(log[0].contains("state=opened") && log[0].contains("with_labels_details=true"));
        // Without GitLab's HTML, the app renders the text.
        drop(log);
        let (addr, _) = serve(vec![("GET /api/v4/projects/team%2Fapp/issues", json!([{ "iid": 5, "description": "x" }]))]);
        let issues = gitlab_issues(&project("gitlab", &format!("{addr}/api/v4"), "me"), "origin", "tok").unwrap();
        assert_eq!(issues[0].body_html, None);
    }

    #[test]
    fn issue_conversation_comment_close_create() {
        use super::super::tests::serve_bodies;
        let (addr, log, bodies) = serve_bodies(vec![
            ("GET /repos/team/app/issues/12/comments", json!([
                { "id": 5, "user": { "login": "ada" }, "body": "Same here", "body_html": "<p>Same here</p>", "created_at": "2026-10-02T00:00:00Z" }
            ])),
            ("POST /repos/team/app/issues/12/comments", json!({})),
            ("PATCH /repos/team/app/issues/12", json!({})),
            ("POST /repos/team/app/issues", json!({ "number": 13, "html_url": "https://github.com/team/app/issues/13" })),
        ]);
        let gh = project("github", &addr, "me");
        let c = comments_in(&gh, "tok", 12).unwrap();
        assert_eq!((c[0].author.as_str(), c[0].html.as_deref()), ("ada", Some("<p>Same here</p>")));
        comment_in(&gh, "tok", 12, "Thanks").unwrap();
        assert!(comment_in(&gh, "tok", 12, " ").is_err());
        set_open_in(&gh, "tok", 12, false).unwrap();
        let made = create_in(&gh, "tok", &NewIssue { title: " Crash ".into(), body: "Trace".into(), labels: vec!["bug".into()], assign_me: true }).unwrap();
        assert_eq!(made.number, 13);
        assert!(create_in(&gh, "tok", &NewIssue { title: " ".into(), body: String::new(), labels: vec![], assign_me: false }).is_err());
        let sent = bodies.lock().unwrap().clone();
        let body = |r: &str| sent.iter().find(|(x, _)| x == r).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(body("POST /repos/team/app/issues/12/comments"), json!({ "body": "Thanks" }));
        assert_eq!(body("PATCH /repos/team/app/issues/12"), json!({ "state": "closed" }));
        assert_eq!(body("POST /repos/team/app/issues"), json!({ "title": "Crash", "body": "Trace", "labels": ["bug"], "assignees": ["me"] }));
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));

        let (addr, _, bodies) = serve_bodies(vec![
            ("GET /api/v4/projects/team%2Fapp/issues/4/notes", json!([
                { "id": 31, "author": { "username": "grace" }, "body": "On it", "created_at": "2026-10-03T00:00:00Z", "system": false }
            ])),
            ("POST /api/graphql", json!({ "data": { "project": { "issue": { "notes": { "nodes": [{ "id": "gid://gitlab/Note/31", "bodyHtml": "<p>On it</p>" }] } } } } })),
            ("PUT /api/v4/projects/team%2Fapp/issues/4", json!({})),
            ("GET /api/v4/user", json!({ "id": 99 })),
            ("POST /api/v4/projects/team%2Fapp/issues", json!({ "iid": 5, "web_url": "https://git.test/team/app/-/issues/5" })),
        ]);
        let gl = Project { graphql: format!("{addr}/api/graphql"), ..project("gitlab", &format!("{addr}/api/v4"), "me") };
        let c = comments_in(&gl, "tok", 4).unwrap();
        assert_eq!((c[0].id.as_str(), c[0].html.as_deref()), ("31", Some("<p>On it</p>")));
        set_open_in(&gl, "tok", 4, true).unwrap();
        create_in(&gl, "tok", &NewIssue { title: "Slow".into(), body: "x".into(), labels: vec!["perf".into(), "ui".into()], assign_me: true }).unwrap();
        let sent = bodies.lock().unwrap().clone();
        let body = |r: &str| sent.iter().find(|(x, _)| x == r).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(body("PUT /api/v4/projects/team%2Fapp/issues/4"), json!({ "state_event": "reopen" }));
        assert_eq!(body("POST /api/v4/projects/team%2Fapp/issues"), json!({ "title": "Slow", "description": "x", "labels": "perf,ui", "assignee_ids": [99] }));
    }

    #[test]
    fn long_bodies_are_cut() {
        let long = "é".repeat(BODY_LIMIT + 5);
        let cut = body(&Value::String(long));
        assert_eq!(cut.chars().count(), BODY_LIMIT + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(color("zzzzzz"), "");
    }
}

/// A real project's issues with this machine's accounts:
/// `GITBRIX_LIVE_URL=… cargo test live_issues -- --ignored --nocapture`. Only reads.
#[cfg(test)]
#[test]
#[ignore]
fn live_issues() {
    let url = std::env::var("GITBRIX_LIVE_URL").expect("GITBRIX_LIVE_URL");
    let home = std::env::var("HOME").unwrap();
    crate::accounts::init(Path::new(&home).join(".config/dev.gitbrix.app"));
    let dir = tempfile::TempDir::new().unwrap();
    let r = git2::Repository::init(dir.path()).unwrap();
    r.remote("origin", &url).unwrap();
    let res = list(dir.path()).unwrap();
    println!("{res:#?}");
    assert!(res.covered, "no account covers {url}");
    assert!(res.problems.is_empty(), "{:?}", res.problems);
}
