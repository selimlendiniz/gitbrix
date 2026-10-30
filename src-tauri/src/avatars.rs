//! Author pictures: Gravatar's, found by the SHA-256 of the e-mail address,
//! or GitHub's own for its noreply addresses. Each is kept on disk for a
//! week (a missing one for a day), so a repository's authors are asked for
//! once, not on every start. Nothing but the address hash (or the GitHub
//! user id) leaves the machine; no credentials are sent.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use base64::Engine;
use sha2::{Digest, Sha256};

static DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

const KEEP: Duration = Duration::from_secs(7 * 86400);
const KEEP_MISSING: Duration = Duration::from_secs(86400);
const MAX_BYTES: u64 = 512 * 1024;
/// Pixels asked for: twice the largest size shown, for HiDPI screens.
const SIZE: u32 = 80;

/// Where pictures come from; tests point both at a local server.
pub struct Sources {
    pub gravatar: String,
    pub github: String,
}

impl Default for Sources {
    fn default() -> Self {
        Sources { gravatar: "https://gravatar.com".into(), github: "https://avatars.githubusercontent.com".into() }
    }
}

fn sha256(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Gravatar's key for an address: trimmed, lowercased, SHA-256 in hex.
pub fn gravatar_hash(email: &str) -> String {
    sha256(&email.trim().to_lowercase())
}

/// The GitHub user id in a `12345+name@users.noreply.github.com` address.
fn github_id(email: &str) -> Option<&str> {
    let email = email.trim();
    let (local, domain) = email.rsplit_once('@')?;
    if !domain.eq_ignore_ascii_case("users.noreply.github.com") {
        return None;
    }
    let (id, _) = local.split_once('+')?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

pub fn url_for(email: &str, src: &Sources) -> String {
    match github_id(email) {
        Some(id) => format!("{}/u/{id}?s={SIZE}&v=4", src.github),
        // d=404: no made-up picture; the app draws initials instead.
        None => format!("{}/avatar/{}?s={SIZE}&d=404", src.gravatar, gravatar_hash(email)),
    }
}

enum Got {
    Image(String),
    Missing,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        // gravatar.com sends its pictures from another of its hosts.
        .max_redirects(3)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(10)))
        .build()
        .into()
}

fn download(url: &str) -> Option<Got> {
    let mut res = agent().get(url).header("User-Agent", "gitbrix").call().ok()?;
    match res.status().as_u16() {
        404 => return Some(Got::Missing),
        200 => {}
        _ => return None,
    }
    let mime = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let mime = mime.split(';').next().unwrap_or("").trim().to_owned();
    if !mime.starts_with("image/") || mime.contains("svg") {
        return None;
    }
    let mut bytes = Vec::new();
    res.body_mut().as_reader().take(MAX_BYTES + 1).read_to_end(&mut bytes).ok()?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(Got::Image(format!("data:{mime};base64,{data}")))
}

fn fresh(path: &Path, keep: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < keep)
}

/// What the disk remembers: a picture, a known absence, or nothing.
fn cached(dir: &Path, key: &str) -> Option<Option<String>> {
    let image = dir.join(format!("{key}.txt"));
    if fresh(&image, KEEP) {
        return std::fs::read_to_string(image).ok().map(Some);
    }
    fresh(&dir.join(format!("{key}.none")), KEEP_MISSING).then_some(None)
}

fn remember(dir: &Path, key: &str, got: &Got) {
    let _ = std::fs::create_dir_all(dir);
    let (name, text, stale) = match got {
        Got::Image(url) => (format!("{key}.txt"), url.as_str(), format!("{key}.none")),
        Got::Missing => (format!("{key}.none"), "", format!("{key}.txt")),
    };
    let _ = std::fs::remove_file(dir.join(stale));
    let _ = std::fs::write(dir.join(name), text);
}

/// Pictures for the addresses, as data URLs; `None` where there is none or
/// it couldn't be fetched (offline: not remembered, asked again next time).
pub fn lookup(dir: &Path, emails: &[String], src: &Sources) -> HashMap<String, Option<String>> {
    let mut out = HashMap::new();
    let mut todo = Vec::new();
    for email in emails {
        if out.contains_key(email) || todo.iter().any(|(e, _, _)| e == email) {
            continue;
        }
        if email.trim().is_empty() || !email.contains('@') {
            out.insert(email.clone(), None);
            continue;
        }
        let url = url_for(email, src);
        let key = sha256(&url);
        match cached(dir, &key) {
            Some(hit) => {
                out.insert(email.clone(), hit);
            }
            None => todo.push((email.clone(), url, key)),
        }
    }
    // A few at a time: a repository can have hundreds of authors.
    for chunk in todo.chunks(6) {
        let got: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk.iter().map(|(_, url, _)| s.spawn(move || download(url))).collect();
            handles.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        for ((email, _, key), got) in chunk.iter().zip(got) {
            if let Some(g) = &got {
                remember(dir, key, g);
            }
            out.insert(email.clone(), match got {
                Some(Got::Image(url)) => Some(url),
                _ => None,
            });
        }
    }
    out
}

pub fn avatars(emails: &[String]) -> HashMap<String, Option<String>> {
    match DIR.get() {
        Some(dir) => lookup(dir, emails, &Sources::default()),
        None => emails.iter().map(|e| (e.clone(), None)).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    #[test]
    fn hashes_and_urls() {
        // The example address from Gravatar's documentation.
        assert_eq!(
            gravatar_hash(" MyEmailAddress@example.com "),
            "84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"
        );
        let src = Sources::default();
        assert_eq!(
            url_for("12345+octo@users.noreply.github.com", &src),
            "https://avatars.githubusercontent.com/u/12345?s=80&v=4"
        );
        assert!(url_for("octo@users.noreply.github.com", &src).starts_with("https://gravatar.com/avatar/"));
        assert!(url_for("a@b.c", &src).ends_with("?s=80&d=404"));
    }

    /// Answers `/avatar/<known hash>` and `/u/1` with a PNG, anything else 404.
    fn server(known: String) -> (String, Arc<Mutex<Vec<String>>>) {
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
                loop {
                    let mut h = String::new();
                    reader.read_line(&mut h).unwrap();
                    if h.trim().is_empty() {
                        break;
                    }
                }
                let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                seen.lock().unwrap().push(path.clone());
                let hit = path.starts_with(&format!("/avatar/{known}")) || path.starts_with("/u/1?");
                let res = if hit {
                    "HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 3\r\nconnection: close\r\n\r\nPNG".to_owned()
                } else {
                    "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_owned()
                };
                let _ = stream.write_all(res.as_bytes());
            }
        });
        (addr, log)
    }

    #[test]
    fn fetches_once_and_remembers() {
        let dir = tempfile::tempdir().unwrap();
        let (addr, log) = server(gravatar_hash("ada@example.com"));
        let src = Sources { gravatar: addr.clone(), github: addr };
        let emails: Vec<String> =
            ["Ada@Example.com", "nobody@example.com", "1+octo@users.noreply.github.com", "not an address", "Ada@Example.com"]
                .map(String::from)
                .into();
        let got = lookup(dir.path(), &emails, &src);
        assert_eq!(got["Ada@Example.com"].as_deref(), Some("data:image/png;base64,UE5H"));
        assert_eq!(got["1+octo@users.noreply.github.com"].as_deref(), Some("data:image/png;base64,UE5H"));
        assert_eq!(got["nobody@example.com"], None);
        assert_eq!(got["not an address"], None);
        assert_eq!(log.lock().unwrap().len(), 3);

        // Second time: all from disk, missing ones included.
        let again = lookup(dir.path(), &emails, &src);
        assert_eq!(again, got);
        assert_eq!(log.lock().unwrap().len(), 3);
    }

    #[test]
    fn offline_is_not_remembered() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing listens there.
        let src = Sources { gravatar: "http://127.0.0.1:9".into(), github: "http://127.0.0.1:9".into() };
        let emails = vec!["ada@example.com".to_owned()];
        assert_eq!(lookup(dir.path(), &emails, &src)["ada@example.com"], None);
        assert_eq!(std::fs::read_dir(dir.path()).map(|d| d.count()).unwrap_or(0), 0);
    }
}
