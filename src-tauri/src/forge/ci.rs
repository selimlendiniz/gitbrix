//! A commit's CI in detail: the pipeline's jobs (GitLab) or the check runs
//! (GitHub), a job's log, running a job again. Logs on GitHub live behind
//! a redirect to storage that takes no token: that hop is made without it.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};

use super::{Project, agent, ci_project, ci_state, encode, get, is_sha, request, text};
use crate::accounts;
use crate::error::{Error, Result};

/// Logs keep their end, where failures are.
const LOG_TAIL: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub name: String,
    /// GitLab's stage; on GitHub the app that runs the check.
    pub stage: String,
    /// As `PullRequest::ci`.
    pub state: String,
    pub url: String,
    /// Seconds.
    pub duration: Option<f64>,
    /// The app can show its log and run it again (GitHub: only Actions).
    pub has_log: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pipeline {
    /// GitLab's pipeline page, GitHub's checks page.
    pub url: String,
    pub state: Option<String>,
    pub jobs: Vec<Job>,
}

fn seconds(from: &Value, to: &Value) -> Option<f64> {
    let parse = |v: &Value| time_of(v.as_str()?);
    Some((parse(to)? - parse(from)?) as f64)
}

/// Seconds since the epoch of an ISO 8601 time (`2026-10-02T10:00:05Z`).
fn time_of(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let clock: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == ':').collect();
    let mut t = clock.split(':').map(|x| x.parse::<i64>().ok());
    let (h, min, sec) = (t.next()??, t.next()??, t.next().flatten().unwrap_or(0));
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + min * 60 + sec)
}

fn gitlab_jobs(p: &Project, token: &str, sha: &str) -> Result<Pipeline> {
    let base = format!("{}/projects/{}", p.api, encode(&p.path));
    let pipelines = get(&format!("{base}/pipelines?sha={sha}&per_page=1&order_by=id&sort=desc"), token)?;
    let Some(pl) = pipelines.as_array().and_then(|a| a.first()) else { return Ok(Pipeline::default()) };
    let id = pl["id"].as_u64().unwrap_or(0);
    let jobs = get(&format!("{base}/pipelines/{id}/jobs?per_page=100"), token)?;
    Ok(Pipeline {
        url: text(&pl["web_url"]),
        state: pl["status"].as_str().and_then(ci_state),
        jobs: jobs
            .as_array()
            .into_iter()
            .flatten()
            .map(|j| Job {
                id: j["id"].as_u64().map(|i| i.to_string()).unwrap_or_default(),
                name: text(&j["name"]),
                stage: text(&j["stage"]),
                state: j["status"].as_str().and_then(ci_state).unwrap_or_else(|| text(&j["status"])),
                url: text(&j["web_url"]),
                duration: j["duration"].as_f64(),
                has_log: true,
            })
            .collect(),
    })
}

fn github_jobs(p: &Project, token: &str, sha: &str) -> Result<Pipeline> {
    let runs = get(&format!("{}/repos/{}/commits/{sha}/check-runs?per_page=100", p.api, p.path), token)?;
    let jobs: Vec<Job> = runs["check_runs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| {
            let state = match r["status"].as_str() {
                Some("completed") => match r["conclusion"].as_str().unwrap_or("") {
                    "timed_out" => "failed".to_owned(),
                    "neutral" => "success".to_owned(),
                    "action_required" => "manual".to_owned(),
                    c => ci_state(c).unwrap_or_else(|| c.to_owned()),
                },
                Some("in_progress") => "running".to_owned(),
                _ => "pending".to_owned(),
            };
            Job {
                id: r["id"].as_u64().map(|i| i.to_string()).unwrap_or_default(),
                name: text(&r["name"]),
                stage: r["app"]["name"].as_str().unwrap_or("").to_owned(),
                state,
                url: text(&r["html_url"]),
                duration: seconds(&r["started_at"], &r["completed_at"]),
                // Actions jobs are check runs with the same id.
                has_log: r["app"]["slug"].as_str() == Some("github-actions"),
            }
        })
        .collect();
    let state = if jobs.iter().any(|j| j.state == "failed") {
        Some("failed".to_owned())
    } else if jobs.iter().any(|j| j.state == "running" || j.state == "pending") {
        Some("running".to_owned())
    } else if jobs.is_empty() {
        None
    } else {
        Some("success".to_owned())
    };
    Ok(Pipeline { url: format!("https://{}/{}/commit/{sha}/checks", p.host, p.path), state, jobs })
}

/// The end of a log, cut at a line.
fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= LOG_TAIL {
        return text.into_owned();
    }
    let mut start = text.len() - LOG_TAIL;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut = &text[start..];
    let cut = cut.find('\n').map_or(cut, |i| &cut[i + 1..]);
    format!("[… the start of the log is left out …]\n{cut}")
}

/// A log as text. The token goes only to the account's host; a redirect
/// (GitHub's storage) is followed without it, over https only.
fn fetch_log(p: &Project, url: &str, token: &str) -> Result<String> {
    let mut response = agent()
        .get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", "gitbrix")
        .call()
        .map_err(|e| Error::msg(format!("Couldn't reach {}: {e}", p.host)))?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        let to = response
            .headers()
            .get("location")
            .and_then(|l| l.to_str().ok())
            .map(str::to_owned)
            .ok_or_else(|| Error::msg("The log moved, but not where to"))?;
        let local = accounts::split_url(&to).is_some_and(|(_, h, _)| h.starts_with("127.0.0.1"));
        if !to.starts_with("https://") && !(cfg!(test) && local) {
            return Err(Error::msg("The log is only offered over plain http"));
        }
        let plain: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into();
        response = plain.get(&to).header("User-Agent", "gitbrix").call().map_err(|e| Error::msg(format!("Couldn't download the log: {e}")))?;
    }
    let status = response.status().as_u16();
    if status == 404 {
        return Err(Error::msg("No log for this job (yet)"));
    }
    if !(200..300).contains(&status) {
        return Err(Error::msg(format!("{} answered {status} for the log", p.host)));
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_to_vec()
        .map_err(|e| Error::msg(format!("Couldn't read the log: {e}")))?;
    Ok(tail(&bytes))
}

fn log_in(p: &Project, token: &str, job: &str) -> Result<String> {
    let job: u64 = job.parse().map_err(|_| Error::msg("Not a job"))?;
    let url = match p.provider.as_str() {
        "github" => format!("{}/repos/{}/actions/jobs/{job}/logs", p.api, p.path),
        _ => format!("{}/projects/{}/jobs/{job}/trace", p.api, encode(&p.path)),
    };
    fetch_log(p, &url, token)
}

fn retry_in(p: &Project, token: &str, job: &str) -> Result<()> {
    let job: u64 = job.parse().map_err(|_| Error::msg("Not a job"))?;
    match p.provider.as_str() {
        "github" => request("POST", &format!("{}/repos/{}/actions/jobs/{job}/rerun", p.api, p.path), token, Some(&json!({})))?,
        _ => request("POST", &format!("{}/projects/{}/jobs/{job}/retry", p.api, encode(&p.path)), token, None)?,
    };
    Ok(())
}

fn project(repo: &Path) -> Result<(Project, String)> {
    ci_project(repo)?.ok_or_else(|| Error::msg("No GitHub or GitLab account covers this repository's remotes"))
}

pub fn jobs(repo: &Path, sha: &str) -> Result<Pipeline> {
    if !is_sha(sha) {
        return Err(Error::msg("Not a commit id"));
    }
    let (p, token) = project(repo)?;
    match p.provider.as_str() {
        "github" => github_jobs(&p, &token, sha),
        _ => gitlab_jobs(&p, &token, sha),
    }
}

pub fn log(repo: &Path, job: &str) -> Result<String> {
    let (p, token) = project(repo)?;
    log_in(&p, &token, job)
}

pub fn retry(repo: &Path, job: &str) -> Result<()> {
    let (p, token) = project(repo)?;
    retry_in(&p, &token, job)
}

#[cfg(test)]
mod tests {
    use super::super::tests::{project, serve};
    use super::*;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn gitlab_pipeline_jobs_log_and_retry() {
        let (addr, log) = serve(vec![
            ("GET /api/v4/projects/team%2Fapp/pipelines?sha=", json!([{ "id": 77, "status": "failed", "web_url": "https://git.test/p/77" }])),
            ("GET /api/v4/projects/team%2Fapp/pipelines/77/jobs", json!([
                { "id": 1, "name": "build", "stage": "build", "status": "success", "web_url": "w1", "duration": 12.5 },
                { "id": 2, "name": "test", "stage": "test", "status": "failed", "web_url": "w2", "duration": 3.0 }
            ])),
            ("GET /api/v4/projects/team%2Fapp/jobs/2/trace", Value::String("$ cargo test\nerror: 1 failed\n".into())),
            ("POST /api/v4/projects/team%2Fapp/jobs/2/retry", json!({})),
        ]);
        let p = project("gitlab", &format!("{addr}/api/v4"), "me");
        let pl = gitlab_jobs(&p, "tok", SHA).unwrap();
        assert_eq!((pl.state.as_deref(), pl.url.as_str()), (Some("failed"), "https://git.test/p/77"));
        assert_eq!(pl.jobs.iter().map(|j| (j.name.as_str(), j.state.as_str())).collect::<Vec<_>>(), [("build", "success"), ("test", "failed")]);
        assert_eq!(log_in(&p, "tok", "2").unwrap(), "$ cargo test\nerror: 1 failed\n");
        retry_in(&p, "tok", "2").unwrap();
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));
        assert!(log_in(&p, "tok", "../x").is_err());
    }

    #[test]
    fn github_check_runs_and_a_log_behind_a_redirect() {
        let (storage, storage_log) = serve(vec![("GET /blob/7", Value::String("##[group]Run tests\nok\n".into()))]);
        let (addr, log) = serve(vec![
            ("GET /repos/team/app/commits/", json!({ "check_runs": [
                { "id": 7, "name": "test", "status": "completed", "conclusion": "failure", "html_url": "h7",
                  "started_at": "2026-10-02T10:00:00Z", "completed_at": "2026-10-02T10:01:05Z", "app": { "slug": "github-actions", "name": "GitHub Actions" } },
                { "id": 8, "name": "codecov", "status": "in_progress", "app": { "slug": "codecov", "name": "Codecov" } }
            ] })),
            ("GET /repos/team/app/actions/jobs/7/logs", json!({ "__redirect": format!("{storage}/blob/7") })),
            ("POST /repos/team/app/actions/jobs/7/rerun", json!({})),
        ]);
        let p = project("github", &addr, "me");
        let pl = github_jobs(&p, "tok", SHA).unwrap();
        assert_eq!(pl.state.as_deref(), Some("failed"));
        assert_eq!((pl.jobs[0].state.as_str(), pl.jobs[0].duration, pl.jobs[0].has_log), ("failed", Some(65.0), true));
        assert_eq!((pl.jobs[1].state.as_str(), pl.jobs[1].has_log), ("running", false));
        assert_eq!(log_in(&p, "tok", "7").unwrap(), "##[group]Run tests\nok\n");
        // The storage never saw the token.
        assert!(storage_log.lock().unwrap().iter().all(|l| l.ends_with("[]")), "{:?}", storage_log.lock().unwrap());
        retry_in(&p, "tok", "7").unwrap();
        assert!(log.lock().unwrap().iter().all(|l| l.ends_with("[Bearer tok]")));
    }

    #[test]
    fn long_logs_keep_their_end() {
        let mut long = "early line\n".repeat(LOG_TAIL / 5);
        long.push_str("the failure\n");
        let t = tail(long.as_bytes());
        assert!(t.starts_with("[… the start of the log is left out …]\nearly line\n"));
        assert!(t.ends_with("the failure\n") && t.len() <= LOG_TAIL + 64);
        assert_eq!(time_of("1970-01-02T00:00:01Z"), Some(86_401));
        assert_eq!(time_of("2026-10-02T10:01:05Z").unwrap() - time_of("2026-10-02T10:00:00Z").unwrap(), 65);
    }
}
