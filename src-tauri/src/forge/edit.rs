//! Changing a request after it's open: title, description, draft,
//! reviewers, labels; closing and reopening it. Labels of a project, for
//! requests and issues.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::issues::Label;
use super::{Project, encode, form_in, get, project_of_remote, request, text};
use crate::error::{Error, Result};

/// What can be changed, as it is now.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetails {
    pub title: String,
    pub body: String,
    pub draft: bool,
    pub open: bool,
    /// Usernames asked to review.
    pub reviewers: Vec<String>,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestEdit {
    pub title: String,
    pub body: String,
    pub draft: bool,
    pub reviewers: Vec<String>,
    pub labels: Vec<String>,
}

/// GitLab marks drafts in the title.
fn without_draft(title: &str) -> &str {
    let t = title.trim_start();
    for prefix in ["Draft:", "[Draft]", "(Draft)", "WIP:", "[WIP]"] {
        if t.len() >= prefix.len() && t[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return t[prefix.len()..].trim_start();
        }
    }
    t
}

fn names(v: &Value, key: &str) -> Vec<String> {
    v.as_array().into_iter().flatten().filter_map(|x| x[key].as_str().map(str::to_owned)).collect()
}

fn details_in(p: &Project, token: &str, number: u64) -> Result<RequestDetails> {
    match p.provider.as_str() {
        "github" => {
            let pr = get(&format!("{}/repos/{}/pulls/{number}", p.api, p.path), token)?;
            Ok(RequestDetails {
                title: text(&pr["title"]),
                body: text(&pr["body"]),
                draft: pr["draft"].as_bool().unwrap_or(false),
                open: pr["state"].as_str() == Some("open"),
                reviewers: names(&pr["requested_reviewers"], "login"),
                labels: names(&pr["labels"], "name"),
            })
        }
        _ => {
            let mr = get(&format!("{}/projects/{}/merge_requests/{number}", p.api, encode(&p.path)), token)?;
            Ok(RequestDetails {
                title: without_draft(&text(&mr["title"])).to_owned(),
                body: text(&mr["description"]),
                draft: mr["draft"].as_bool().unwrap_or(false),
                open: mr["state"].as_str() == Some("opened"),
                reviewers: names(&mr["reviewers"], "username"),
                labels: mr["labels"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(str::to_owned)).collect(),
            })
        }
    }
}

pub(super) fn labels_in(p: &Project, token: &str) -> Result<Vec<Label>> {
    let (url, color_of): (String, fn(&Value) -> String) = match p.provider.as_str() {
        "github" => (format!("{}/repos/{}/labels?per_page=100", p.api, p.path), |l| format!("#{}", text(&l["color"]).to_lowercase())),
        _ => (format!("{}/projects/{}/labels?per_page=100", p.api, encode(&p.path)), |l| text(&l["color"]).to_lowercase()),
    };
    let mut out: Vec<Label> = get(&url, token)?
        .as_array()
        .into_iter()
        .flatten()
        .map(|l| Label { name: text(&l["name"]), color: color_of(l) })
        .filter(|l| !l.name.is_empty())
        .collect();
    out.sort_by_key(|l| l.name.to_lowercase());
    Ok(out)
}

fn edit_in(p: &Project, token: &str, number: u64, edit: &RequestEdit) -> Result<()> {
    let title = without_draft(&edit.title).trim().to_owned();
    if title.is_empty() {
        return Err(Error::msg("Give the request a title"));
    }
    match p.provider.as_str() {
        "github" => {
            let base = format!("{}/repos/{}/pulls/{number}", p.api, p.path);
            let pr = get(&base, token)?;
            request("PATCH", &base, token, Some(&json!({ "title": title, "body": edit.body })))?;
            // Draft or ready: GraphQL only.
            if pr["draft"].as_bool().unwrap_or(false) != edit.draft {
                let mutation = if edit.draft { "convertPullRequestToDraft" } else { "markPullRequestReadyForReview" };
                let query = format!("mutation($id: ID!) {{ {mutation}(input: {{pullRequestId: $id}}) {{ clientMutationId }} }}");
                let data = request("POST", &p.graphql, token, Some(&json!({ "query": query, "variables": { "id": text(&pr["node_id"]) } })))?;
                if let Some(err) = data["errors"].as_array().and_then(|e| e.first()) {
                    return Err(Error::msg(format!("{}: {}", p.host, text(&err["message"]))));
                }
            }
            let now = names(&pr["requested_reviewers"], "login");
            let add: Vec<&String> = edit.reviewers.iter().filter(|r| !now.contains(r)).collect();
            let remove: Vec<&String> = now.iter().filter(|r| !edit.reviewers.contains(r)).collect();
            if !add.is_empty() {
                request("POST", &format!("{base}/requested_reviewers"), token, Some(&json!({ "reviewers": add })))?;
            }
            if !remove.is_empty() {
                request("DELETE", &format!("{base}/requested_reviewers"), token, Some(&json!({ "reviewers": remove })))?;
            }
            let labels_now = names(&pr["labels"], "name");
            if labels_now != edit.labels {
                let url = format!("{}/repos/{}/issues/{number}/labels", p.api, p.path);
                request("PUT", &url, token, Some(&json!({ "labels": edit.labels })))?;
            }
        }
        _ => {
            // Reviewers by id: the project's members say whose.
            let people = form_in(p, token)?.people;
            let mut ids = Vec::new();
            for r in &edit.reviewers {
                match people.iter().find(|u| &u.username == r) {
                    Some(u) => ids.push(u.id),
                    None => return Err(Error::msg(format!("{r} isn't a member of the project"))),
                }
            }
            let body = json!({
                "title": if edit.draft { format!("Draft: {title}") } else { title },
                "description": edit.body,
                "reviewer_ids": ids,
                "labels": edit.labels.join(","),
            });
            request("PUT", &format!("{}/projects/{}/merge_requests/{number}", p.api, encode(&p.path)), token, Some(&body))?;
        }
    }
    Ok(())
}

fn set_open_in(p: &Project, token: &str, number: u64, open: bool) -> Result<()> {
    match p.provider.as_str() {
        "github" => {
            let body = json!({ "state": if open { "open" } else { "closed" } });
            request("PATCH", &format!("{}/repos/{}/pulls/{number}", p.api, p.path), token, Some(&body))?;
        }
        _ => {
            let body = json!({ "state_event": if open { "reopen" } else { "close" } });
            request("PUT", &format!("{}/projects/{}/merge_requests/{number}", p.api, encode(&p.path)), token, Some(&body))?;
        }
    }
    Ok(())
}

pub fn details(repo: &Path, remote: &str, number: u64) -> Result<RequestDetails> {
    let (p, token) = project_of_remote(repo, remote)?;
    details_in(&p, &token, number)
}

pub fn labels(repo: &Path, remote: &str) -> Result<Vec<Label>> {
    let (p, token) = project_of_remote(repo, remote)?;
    labels_in(&p, &token)
}

pub fn edit(repo: &Path, remote: &str, number: u64, edit: &RequestEdit) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    edit_in(&p, &token, number, edit)
}

pub fn set_open(repo: &Path, remote: &str, number: u64, open: bool) -> Result<()> {
    let (p, token) = project_of_remote(repo, remote)?;
    set_open_in(&p, &token, number, open)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{project, serve_bodies};
    use super::*;

    fn edit(draft: bool, reviewers: &[&str], labels: &[&str]) -> RequestEdit {
        RequestEdit {
            title: " Draft: Dark theme ".into(),
            body: "Why".into(),
            draft,
            reviewers: reviewers.iter().map(|s| s.to_string()).collect(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn github_edits_and_draft_reviewers_labels() {
        let (addr, log, bodies) = serve_bodies(vec![
            ("GET /repos/team/app/pulls/4", json!({ "node_id": "PR_4", "title": "Old", "body": "", "draft": true, "state": "open",
                "requested_reviewers": [{ "login": "ada" }, { "login": "bob" }], "labels": [{ "name": "ui" }] })),
            ("PATCH /repos/team/app/pulls/4", json!({})),
            ("POST /graphql", json!({ "data": {} })),
            ("POST /repos/team/app/pulls/4/requested_reviewers", json!({})),
            ("DELETE /repos/team/app/pulls/4/requested_reviewers", json!({})),
            ("PUT /repos/team/app/issues/4/labels", json!([])),
            ("GET /repos/team/app/labels", json!([{ "name": "bug", "color": "D73A4A" }, { "name": "UI", "color": "00ff00" }])),
        ]);
        let p = project("github", &addr, "me");
        let d = details_in(&p, "tok", 4).unwrap();
        assert_eq!((d.draft, d.open, d.reviewers.clone(), d.labels.clone()), (true, true, vec!["ada".to_owned(), "bob".into()], vec!["ui".to_owned()]));
        edit_in(&p, "tok", 4, &edit(false, &["ada", "grace"], &["ui", "bug"])).unwrap();
        let sent = bodies.lock().unwrap().clone();
        let body = |r: &str| sent.iter().find(|(x, _)| x == r).map(|(_, v)| v.clone()).unwrap();
        assert_eq!(body("PATCH /repos/team/app/pulls/4"), json!({ "title": "Dark theme", "body": "Why" }));
        assert!(body("POST /graphql")["query"].as_str().unwrap().contains("markPullRequestReadyForReview"));
        assert_eq!(body("POST /repos/team/app/pulls/4/requested_reviewers")["reviewers"], json!(["grace"]));
        assert_eq!(body("DELETE /repos/team/app/pulls/4/requested_reviewers")["reviewers"], json!(["bob"]));
        assert_eq!(body("PUT /repos/team/app/issues/4/labels")["labels"], json!(["ui", "bug"]));
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));
        let labels = labels_in(&p, "tok").unwrap();
        assert_eq!(labels.iter().map(|l| (l.name.as_str(), l.color.as_str())).collect::<Vec<_>>(), [("bug", "#d73a4a"), ("UI", "#00ff00")]);
    }

    #[test]
    fn gitlab_edits_in_one_put() {
        let (addr, _, bodies) = serve_bodies(vec![
            ("GET /api/v4/projects/team%2Fapp/members/all", json!([{ "id": 7, "username": "ada", "state": "active" }])),
            ("GET /api/v4/projects/team%2Fapp/merge_requests/9", json!({ "title": "Draft: Old", "description": "x", "draft": true,
                "state": "opened", "reviewers": [{ "username": "ada" }], "labels": ["ui"] })),
            ("GET /api/v4/projects/team%2Fapp", json!({ "default_branch": "main" })),
            ("PUT /api/v4/projects/team%2Fapp/merge_requests/9", json!({})),
        ]);
        let p = project("gitlab", &format!("{addr}/api/v4"), "me");
        let d = details_in(&p, "tok", 9).unwrap();
        assert_eq!((d.title.as_str(), d.draft), ("Old", true));
        edit_in(&p, "tok", 9, &edit(true, &["ada"], &["ui", "bug"])).unwrap();
        set_open_in(&p, "tok", 9, false).unwrap();
        let sent = bodies.lock().unwrap().clone();
        assert_eq!(sent[0].1, json!({ "title": "Draft: Dark theme", "description": "Why", "reviewer_ids": [7], "labels": "ui,bug" }));
        assert_eq!(sent[1].1, json!({ "state_event": "close" }));
        assert!(edit_in(&p, "tok", 9, &edit(false, &["stranger"], &[])).is_err());
        assert!(edit_in(&p, "tok", 9, &RequestEdit { title: "Draft:".into(), ..edit(false, &[], &[]) }).is_err());
    }
}
