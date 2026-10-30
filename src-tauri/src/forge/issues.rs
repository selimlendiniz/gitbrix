//! Open issues of a repository's remotes, with the same accounts (and the
//! same rules for the token) as the pull requests.

use std::path::Path;

use serde::Serialize;
use serde_json::{Value, json};

use super::{Project, each_project, encode, get, gitlab_me, request, text};
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
        number title url body createdAt updatedAt
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

fn list_project(p: &Project, remote: &str, token: &str) -> Result<Vec<Issue>> {
    match p.provider.as_str() {
        "github" => github_issues(p, remote, token),
        _ => gitlab_issues(p, remote, token),
    }
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
    use super::*;

    #[test]
    fn github_issues_with_labels_and_assignees() {
        let (addr, log) = serve(vec![(
            "POST /graphql",
            json!({ "data": {
                "viewer": { "login": "me" },
                "repository": { "hasIssuesEnabled": true, "issues": { "nodes": [
                    { "number": 12, "title": "Login fails", "url": "https://github.com/team/app/issues/12", "body": "Steps…",
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
        )]);
        let p = project("gitlab", &format!("{addr}/api/v4"), "me");
        let issues = gitlab_issues(&p, "origin", "tok").unwrap();
        let i = &issues[0];
        assert_eq!((i.number, i.title.as_str(), i.comments), (4, "Crash on start", 2));
        assert!(i.mine && !i.assigned_to_me);
        assert_eq!(i.assignees, vec!["grace".to_owned()]);
        assert_eq!(
            i.labels,
            vec![Label { name: "bug".into(), color: "#ff0000".into() }, Label { name: "plain".into(), color: String::new() }]
        );
        let log = log.lock().unwrap();
        assert!(log[0].contains("state=opened") && log[0].contains("with_labels_details=true"));
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
