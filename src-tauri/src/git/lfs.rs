//! Git LFS without the git-lfs program. Files matched by `filter=lfs` in
//! `.gitattributes` are committed as small pointer files; their content
//! lives in `.git/lfs/objects/` and on the server's LFS store, reached
//! through the batch API (https, or `git-lfs-authenticate` over ssh).
//!
//! libgit2 runs no external filters, so the steps git-lfs hooks into git
//! are done here: staging stores the content and stages its pointer,
//! `pull` replaces pointers in the work tree with their content, and push
//! uploads the objects the pushed commits refer to. The index keeps the
//! pointer with the work tree file's stat data, so the replaced files
//! don't show as changed.

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use git2::{AttrCheckFlags, Index, IndexEntry, IndexTime, Oid, Repository};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::ssh;
use crate::accounts;
use crate::error::{Error, Result};

const VERSION: &str = "version https://git-lfs.github.com/spec/v1";
/// Pointers are small; anything bigger is content.
const MAX_POINTER: usize = 1024;
const MEDIA: &str = "application/vnd.git-lfs+json";

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Pointer {
    /// sha256 of the content, hex.
    pub oid: String,
    pub size: u64,
}

impl Pointer {
    pub fn parse(data: &[u8]) -> Option<Pointer> {
        if data.len() > MAX_POINTER {
            return None;
        }
        let text = std::str::from_utf8(data).ok()?;
        let mut lines = text.lines();
        if lines.next()? != VERSION {
            return None;
        }
        let (mut oid, mut size) = (None, None);
        for line in lines {
            if let Some(v) = line.strip_prefix("oid sha256:") {
                oid = Some(v.to_owned());
            } else if let Some(v) = line.strip_prefix("size ") {
                size = v.parse().ok();
            }
        }
        let oid = oid.filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_hexdigit()))?;
        Some(Pointer { oid: oid.to_ascii_lowercase(), size: size? })
    }

    pub fn text(&self) -> String {
        format!("{VERSION}\noid sha256:{}\nsize {}\n", self.oid, self.size)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Where LFS keeps objects: the main repository's git dir, shared by
/// its worktrees.
fn store(r: &Repository) -> PathBuf {
    r.commondir().join("lfs")
}

pub fn object_path(r: &Repository, oid: &str) -> PathBuf {
    store(r).join("objects").join(&oid[0..2]).join(&oid[2..4]).join(oid)
}

fn have(r: &Repository, p: &Pointer) -> bool {
    fs::metadata(object_path(r, &p.oid)).is_ok_and(|m| m.len() == p.size)
}

/// The repository uses LFS: a `.gitattributes` in the index (or the top
/// one in the work tree, maybe not staged yet) mentions it.
pub fn used(r: &Repository) -> bool {
    let top = r.workdir().map(|w| w.join(".gitattributes"));
    if top.and_then(|f| fs::read_to_string(f).ok()).is_some_and(|t| t.contains("filter=lfs")) {
        return true;
    }
    let Ok(index) = r.index() else { return false };
    index.iter().any(|e| {
        e.path.ends_with(b".gitattributes")
            && r.find_blob(e.id).is_ok_and(|b| String::from_utf8_lossy(b.content()).contains("filter=lfs"))
    })
}

pub fn tracked(r: &Repository, path: &str) -> bool {
    r.get_attr(Path::new(path), "filter", AttrCheckFlags::FILE_THEN_INDEX).ok().flatten() == Some("lfs")
}

/// Copy `from` into the object store while hashing it; returns its pointer.
fn store_content(r: &Repository, mut from: impl Read) -> Result<Pointer> {
    let tmp_dir = store(r).join("tmp");
    fs::create_dir_all(&tmp_dir)?;
    let tmp = tmp_dir.join(format!("clean-{}-{:?}", std::process::id(), std::thread::current().id()));
    let mut out = File::create(&tmp)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])?;
        size += n as u64;
    }
    drop(out);
    let pointer = Pointer { oid: hex(&hasher.finalize()), size };
    let dest = object_path(r, &pointer.oid);
    if have(r, &pointer) {
        fs::remove_file(&tmp)?;
    } else {
        fs::create_dir_all(dest.parent().expect("has a parent"))?;
        fs::rename(&tmp, &dest)?;
    }
    Ok(pointer)
}

/// sha256 and size of a file, without storing it.
fn pointer_of_file(path: &Path) -> Result<Pointer> {
    let mut f = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        size += n as u64;
    }
    Ok(Pointer { oid: hex(&hasher.finalize()), size })
}

#[cfg(unix)]
fn stat_entry(meta: &fs::Metadata, path: &str, id: Oid, mode: u32) -> IndexEntry {
    use std::os::unix::fs::MetadataExt;
    IndexEntry {
        ctime: IndexTime::new(meta.ctime() as i32, meta.ctime_nsec() as u32),
        mtime: IndexTime::new(meta.mtime() as i32, meta.mtime_nsec() as u32),
        dev: meta.dev() as u32,
        ino: meta.ino() as u32,
        mode,
        uid: meta.uid(),
        gid: meta.gid(),
        // The work tree file's size: with the times it tells libgit2 the
        // file is unchanged without hashing it (which would give the
        // content's id, not the pointer's).
        file_size: meta.len() as u32,
        id,
        flags: (path.len().min(0xfff)) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

#[cfg(not(unix))]
fn stat_entry(meta: &fs::Metadata, path: &str, id: Oid, mode: u32) -> IndexEntry {
    let secs = |t: std::io::Result<std::time::SystemTime>| {
        t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs() as i32)
    };
    IndexEntry {
        ctime: IndexTime::new(secs(meta.created()), 0),
        mtime: IndexTime::new(secs(meta.modified()), 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: meta.len() as u32,
        id,
        flags: (path.len().min(0xfff)) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

fn file_mode(meta: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            return 0o100755;
        }
    }
    let _ = meta;
    0o100644
}

/// Stage `path` (an LFS file in the work tree) as a pointer to its content,
/// which goes into the object store. The caller writes the index.
pub fn stage(r: &Repository, index: &mut Index, path: &str) -> Result<()> {
    let full = r.workdir().expect("non-bare").join(path);
    let data_head = {
        let mut head = vec![0u8; MAX_POINTER + 1];
        let n = File::open(&full)?.read(&mut head)?;
        head.truncate(n);
        head
    };
    // Already a pointer (not pulled yet): stage it as it is.
    let pointer = match Pointer::parse(&data_head) {
        Some(p) => p,
        None => store_content(r, File::open(&full)?)?,
    };
    let blob = r.blob(pointer.text().as_bytes())?;
    let meta = fs::metadata(&full)?;
    index.add(&stat_entry(&meta, path, blob, file_mode(&meta)))?;
    Ok(())
}

/// The work tree file is the content the index's pointer names (status
/// would otherwise call it modified when its stat data doesn't settle it).
pub fn matches_index(r: &Repository, path: &str, index_id: Oid) -> bool {
    let Ok(blob) = r.find_blob(index_id) else { return false };
    let Some(pointer) = Pointer::parse(blob.content()) else { return false };
    let full = r.workdir().expect("non-bare").join(path);
    match fs::metadata(&full) {
        Ok(m) if m.len() == pointer.size => pointer_of_file(&full).is_ok_and(|p| p == pointer),
        // Still the pointer itself.
        Ok(m) if (m.len() as usize) <= MAX_POINTER => fs::read(&full).is_ok_and(|d| Pointer::parse(&d).as_ref() == Some(&pointer)),
        _ => false,
    }
}

/// Index entries whose work tree file is still a pointer.
pub fn pending(r: &Repository) -> Result<Vec<(String, Pointer)>> {
    if !used(r) {
        return Ok(Vec::new());
    }
    let workdir = r.workdir().expect("non-bare").to_path_buf();
    let index = r.index()?;
    let mut out = Vec::new();
    for e in index.iter() {
        // Stage 0 only; conflicts aren't pulled.
        if (e.flags >> 12) & 0x3 != 0 {
            continue;
        }
        let path = String::from_utf8_lossy(&e.path).into_owned();
        let Ok(blob) = r.find_blob(e.id) else { continue };
        let Some(pointer) = Pointer::parse(blob.content()) else { continue };
        if !tracked(r, &path) {
            continue;
        }
        let full = workdir.join(&path);
        let still_pointer = match fs::metadata(&full) {
            Ok(m) if (m.len() as usize) <= MAX_POINTER => fs::read(&full).is_ok_and(|d| Pointer::parse(&d).is_some()),
            Ok(_) => false,
            // Deleted in the work tree: that's the user's change.
            Err(_) => false,
        };
        if still_pointer && pointer.size > 0 {
            out.push((path, pointer));
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Server

struct Endpoint {
    url: String,
    headers: Vec<(String, String)>,
}

fn lfs_config(r: &Repository, remote: &str) -> Option<String> {
    let keys = [format!("remote.{remote}.lfsurl"), "lfs.url".to_owned()];
    let repo_cfg = r.config().ok();
    let file_cfg = r.workdir().map(|w| w.join(".lfsconfig")).filter(|p| p.exists()).and_then(|p| git2::Config::open(&p).ok());
    keys.iter().find_map(|k| {
        repo_cfg.as_ref().and_then(|c| c.get_string(k).ok()).or_else(|| file_cfg.as_ref().and_then(|c| c.get_string(k).ok()))
    })
}

/// `https://host/group/app(.git)` → `https://host/group/app.git/info/lfs`.
fn default_url(web: &str) -> String {
    let web = web.trim_end_matches('/');
    if web.ends_with(".git") {
        format!("{web}/info/lfs")
    } else {
        format!("{web}.git/info/lfs")
    }
}

fn basic(user: &str, token: &str) -> String {
    use base64::Engine;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{token}")))
}

/// Ask the ssh server for an LFS address and a short-lived authorization.
fn ssh_authenticate(remote_url: &str, operation: &str) -> Result<Endpoint> {
    let (host, port, path) = ssh::parse_url(remote_url).ok_or_else(|| Error::msg(format!("Not an ssh address: {remote_url}")))?;
    if host.starts_with('-') || path.starts_with('-') {
        return Err(Error::msg("Refusing an ssh address that looks like an option"));
    }
    let out = ssh::command(host, port, &format!("git-lfs-authenticate {} {operation}", ssh::quote(&path)))
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| Error::msg(format!("Couldn't run ssh: {e}")))?;
    if !out.status.success() {
        return Err(Error::msg(format!("git-lfs-authenticate failed: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| Error::msg(format!("git-lfs-authenticate: {e}")))?;
    let url = v["href"].as_str().ok_or_else(|| Error::msg("git-lfs-authenticate gave no address"))?.to_owned();
    let headers = v["header"].as_object().map(|h| h.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect()).unwrap_or_default();
    Ok(Endpoint { url, headers })
}

fn endpoint(r: &Repository, remote: &str, operation: &str) -> Result<Endpoint> {
    let remote_url = r
        .find_remote(remote)
        .ok()
        .and_then(|rm| rm.url().ok().map(str::to_owned))
        .ok_or_else(|| Error::msg(format!("No remote named '{remote}'")))?;
    let configured = lfs_config(r, remote);
    let is_web = |u: &str| u.starts_with("https://") || u.starts_with("http://");
    let url = match &configured {
        Some(u) => u.clone(),
        None if is_web(&remote_url) => default_url(&remote_url),
        // ssh: the server says where its LFS store is.
        None if ssh::parse_url(&remote_url).is_some() => {
            if let Ok(ep) = ssh_authenticate(&remote_url, operation) {
                return Ok(ep);
            }
            default_url(&crate::forge::web_url(&remote_url).ok_or_else(|| Error::msg("No LFS address for this remote"))?)
        }
        None => return Err(Error::msg(format!("{remote} is a local path; it has no LFS server"))),
    };
    let mut headers = Vec::new();
    if let Some((user, token)) = accounts::credentials_for(&url, r.workdir()) {
        headers.push(("Authorization".to_owned(), basic(&user, &token)));
    }
    Ok(Endpoint { url: url.trim_end_matches('/').to_owned(), headers })
}

fn agent(redirects: u32) -> ureq::Agent {
    ureq::Agent::config_builder()
        // The batch call carries our token: it follows no redirect. Object
        // transfers may (to a CDN); ureq drops Authorization when they do.
        .max_redirects(redirects)
        .http_status_as_error(false)
        .timeout_connect(Some(Duration::from_secs(20)))
        .build()
        .into()
}

fn status_error(what: &str, status: u16, body: &str) -> Error {
    let detail = serde_json::from_str::<Value>(body).ok().and_then(|v| v["message"].as_str().map(str::to_owned)).unwrap_or_default();
    Error::msg(match status {
        401 | 403 => format!("{what}: not allowed ({status}); add an account for this server in Settings{}", if detail.is_empty() { String::new() } else { format!(": {detail}") }),
        404 => format!("{what}: the server has no LFS store here (404)"),
        _ if !detail.is_empty() => format!("{what}: {detail}"),
        _ => format!("{what}: the server answered {status}"),
    })
}

/// One batch request: the server answers what to do with each object.
fn batch(ep: &Endpoint, operation: &str, objects: &[Pointer]) -> Result<Vec<Value>> {
    let body = json!({
        "operation": operation,
        "transfers": ["basic"],
        "objects": objects.iter().map(|p| json!({ "oid": p.oid, "size": p.size })).collect::<Vec<_>>(),
    });
    let mut req = agent(0).post(&format!("{}/objects/batch", ep.url)).header("Accept", MEDIA).header("Content-Type", MEDIA).header("User-Agent", "gitbrix");
    for (k, v) in &ep.headers {
        req = req.header(k, v);
    }
    let mut res = req.send(body.to_string()).map_err(|e| Error::msg(format!("LFS server unreachable: {e}")))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(status_error("LFS", status, &text));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| Error::msg(format!("LFS: unexpected answer: {e}")))?;
    Ok(v["objects"].as_array().cloned().unwrap_or_default())
}

fn action_request(method: &str, action: &Value) -> Result<ureq::RequestBuilder<ureq::typestate::WithBody>> {
    let href = action["href"].as_str().ok_or_else(|| Error::msg("LFS: an action without an address"))?;
    let agent = agent(5);
    let mut req = if method == "PUT" { agent.put(href) } else { agent.post(href) };
    for (k, v) in action["header"].as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            req = req.header(k, v);
        }
    }
    Ok(req.header("User-Agent", "gitbrix"))
}

fn download(r: &Repository, p: &Pointer, action: &Value) -> Result<()> {
    let href = action["href"].as_str().ok_or_else(|| Error::msg("LFS: a download without an address"))?;
    let mut req = agent(5).get(href).header("User-Agent", "gitbrix");
    for (k, v) in action["header"].as_object().into_iter().flatten() {
        if let Some(v) = v.as_str() {
            req = req.header(k, v);
        }
    }
    let mut res = req.call().map_err(|e| Error::msg(format!("LFS download failed: {e}")))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(status_error("LFS download", status, &res.body_mut().read_to_string().unwrap_or_default()));
    }
    let got = store_content(r, res.body_mut().with_config().limit(p.size + 1).reader())?;
    if &got != p {
        let _ = fs::remove_file(object_path(r, &got.oid));
        return Err(Error::msg(format!("LFS: {} arrived damaged", &p.oid[..12])));
    }
    Ok(())
}

fn upload(r: &Repository, p: &Pointer, actions: &Value) -> Result<()> {
    let Some(up) = actions.get("upload") else { return Ok(()) };
    let file = File::open(object_path(r, &p.oid))?;
    let mut res = action_request("PUT", up)?
        .header("Content-Type", "application/octet-stream")
        .send(file)
        .map_err(|e| Error::msg(format!("LFS upload failed: {e}")))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(status_error("LFS upload", status, &res.body_mut().read_to_string().unwrap_or_default()));
    }
    if let Some(verify) = actions.get("verify") {
        let mut res = action_request("POST", verify)?
            .header("Accept", MEDIA)
            .header("Content-Type", MEDIA)
            .send(json!({ "oid": p.oid, "size": p.size }).to_string())
            .map_err(|e| Error::msg(format!("LFS verify failed: {e}")))?;
        let status = res.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(status_error("LFS verify", status, &res.body_mut().read_to_string().unwrap_or_default()));
        }
    }
    Ok(())
}

fn object_error(o: &Value) -> Option<String> {
    o["error"]["message"].as_str().map(|m| format!("{}: {m}", o["oid"].as_str().unwrap_or("?").get(..12).unwrap_or("?")))
}

/// The remote to talk to: the current branch's, else origin, else the only one.
fn default_remote(r: &Repository) -> Result<String> {
    let from_branch = r.head().ok().filter(|h| h.is_branch()).and_then(|h| {
        let name = h.shorthand().ok()?.to_owned();
        r.config().ok()?.get_string(&format!("branch.{name}.remote")).ok()
    });
    let remotes = r.remotes()?;
    let names: Vec<String> = remotes.iter().flatten().flatten().map(str::to_owned).collect();
    from_branch
        .filter(|n| names.contains(n))
        .or_else(|| names.iter().find(|n| *n == "origin").cloned())
        .or_else(|| names.first().cloned())
        .ok_or_else(|| Error::msg("No remote to download LFS files from"))
}

/// Replace pointer files in the work tree with their content, downloading
/// what isn't stored locally. Returns how many files were filled in.
pub fn pull(repo: &Path, progress: &mut dyn FnMut(&str)) -> Result<usize> {
    let r = super::repo::open(repo)?;
    let pending = pending(&r)?;
    if pending.is_empty() {
        return Ok(0);
    }
    let missing: Vec<Pointer> = pending.iter().map(|(_, p)| p.clone()).filter(|p| !have(&r, p)).collect::<HashSet<_>>().into_iter().collect();
    if !missing.is_empty() {
        let remote = default_remote(&r)?;
        let ep = endpoint(&r, &remote, "download")?;
        let total = missing.len();
        let mut done = 0;
        let mut problems = Vec::new();
        for chunk in missing.chunks(100) {
            for o in batch(&ep, "download", chunk)? {
                if let Some(e) = object_error(&o) {
                    problems.push(e);
                    continue;
                }
                let Some(p) = chunk.iter().find(|p| o["oid"].as_str() == Some(p.oid.as_str())) else { continue };
                match o["actions"].get("download") {
                    Some(action) => {
                        if let Err(e) = download(&r, p, action) {
                            problems.push(e.to_string());
                        }
                    }
                    None if have(&r, p) => {}
                    None => problems.push(format!("{}: the server offered no download", &p.oid[..12])),
                }
                done += 1;
                progress(&format!("Downloading LFS objects: {done}/{total}"));
            }
        }
        if !problems.is_empty() && problems.len() == missing.len() {
            return Err(Error::msg(problems.join("\n")));
        }
    }
    // Write the files, then point the index's stat data at them.
    let workdir = r.workdir().expect("non-bare").to_path_buf();
    let mut index = r.index()?;
    let mut filled = 0;
    for (path, p) in &pending {
        let src = object_path(&r, &p.oid);
        if !have(&r, p) {
            continue;
        }
        let dest = workdir.join(path);
        let tmp = dest.with_file_name(format!(".{}.gitbrix-lfs", dest.file_name().unwrap_or_default().to_string_lossy()));
        fs::copy(&src, &tmp)?;
        if let Ok(old) = fs::metadata(&dest) {
            let _ = fs::set_permissions(&tmp, old.permissions());
        }
        fs::rename(&tmp, &dest)?;
        if let Some(e) = index.get_path(Path::new(path), 0) {
            let meta = fs::metadata(&dest)?;
            index.add(&stat_entry(&meta, path, e.id, e.mode))?;
        }
        filled += 1;
    }
    index.write()?;
    if filled < pending.len() {
        return Err(Error::msg(format!("Filled in {filled} of {} LFS files; the rest couldn't be downloaded", pending.len())));
    }
    Ok(filled)
}

/// LFS objects the commits in `tips` (not reachable from `hide`) refer to.
fn pointers_in(r: &Repository, tips: &[Oid], hide: &[Oid]) -> Result<Vec<Pointer>> {
    let mut walk = r.revwalk()?;
    for t in tips {
        walk.push(*t)?;
    }
    for h in hide {
        let _ = walk.hide(*h);
    }
    let mut found = BTreeMap::new();
    for oid in walk {
        let commit = r.find_commit(oid?)?;
        let tree = commit.tree()?;
        let parent = commit.parents().next().map(|p| p.tree()).transpose()?;
        let diff = r.diff_tree_to_tree(parent.as_ref(), Some(&tree), None)?;
        for d in diff.deltas() {
            let f = d.new_file();
            if f.size() as usize > MAX_POINTER || f.id().is_zero() {
                continue;
            }
            if let Some(p) = r.find_blob(f.id()).ok().and_then(|b| Pointer::parse(b.content())) {
                found.insert(p.oid.clone(), p);
            }
        }
    }
    Ok(found.into_values().collect())
}

/// Upload the LFS objects of commits about to be pushed to `remote` (those
/// not on any of its remote-tracking branches). Objects the server already
/// has are skipped by the server's answer.
pub fn push(r: &Repository, remote: &str, tips: &[Oid], progress: &mut dyn FnMut(&str)) -> Result<()> {
    let hide: Vec<Oid> = r
        .references_glob(&format!("refs/remotes/{remote}/*"))?
        .flatten()
        .filter_map(|rf| rf.target())
        .collect();
    let pointers = pointers_in(r, tips, &hide)?;
    let local: Vec<Pointer> = pointers.into_iter().filter(|p| have(r, p)).collect();
    if local.is_empty() {
        return Ok(());
    }
    let ep = endpoint(r, remote, "upload")?;
    let total = local.len();
    let mut done = 0;
    for chunk in local.chunks(100) {
        for o in batch(&ep, "upload", chunk)? {
            if let Some(e) = object_error(&o) {
                return Err(Error::msg(format!("LFS upload refused: {e}")));
            }
            let Some(p) = chunk.iter().find(|p| o["oid"].as_str() == Some(p.oid.as_str())) else { continue };
            if let Some(actions) = o.get("actions") {
                upload(r, p, actions)?;
            }
            done += 1;
            progress(&format!("Uploading LFS objects: {done}/{total}"));
        }
    }
    Ok(())
}

/// Content of a blob for display: the LFS object when the blob is a
/// pointer and the object is here, else the blob itself.
pub fn display_content(r: &Repository, data: &[u8]) -> Option<Vec<u8>> {
    let p = Pointer::parse(data)?;
    have(r, &p).then(|| fs::read(object_path(r, &p.oid)).ok()).flatten()
}

/// Add `pattern` to the top-level .gitattributes as an LFS pattern.
pub fn track(repo: &Path, pattern: &str) -> Result<()> {
    let pattern = pattern.trim();
    if pattern.is_empty() || pattern.contains('\n') || pattern.starts_with('#') {
        return Err(Error::msg("Give a file pattern, like *.psd"));
    }
    let r = super::repo::open(repo)?;
    let file = r.workdir().expect("non-bare").join(".gitattributes");
    let mut text = fs::read_to_string(&file).unwrap_or_default();
    let line = format!("{} filter=lfs diff=lfs merge=lfs -text", pattern.replace(' ', "[[:space:]]"));
    if text.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&line);
    text.push('\n');
    fs::write(file, text)?;
    Ok(())
}
