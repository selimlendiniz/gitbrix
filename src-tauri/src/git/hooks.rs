//! The repository's hooks. libgit2 never runs them, so the operations
//! that git would run them for call in here: a failing `pre-commit` or
//! `commit-msg` stops the commit, `post-*` hooks are informational.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use git2::Repository;

use crate::error::{Error, Result};

fn hooks_dir(r: &Repository) -> PathBuf {
    if let Ok(p) = r.config().and_then(|c| c.get_path("core.hooksPath")) {
        if p.is_absolute() {
            return p;
        }
        if let Some(wd) = r.workdir() {
            return wd.join(p);
        }
    }
    r.commondir().join("hooks")
}

/// The hook's path, if it exists and is executable (git ignores the rest).
fn find(r: &Repository, name: &str) -> Option<PathBuf> {
    let path = hooks_dir(r).join(name);
    let meta = std::fs::metadata(&path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    #[cfg(not(unix))]
    if !meta.is_file() {
        return None;
    }
    Some(path)
}

pub fn exists(r: &Repository, name: &str) -> bool {
    find(r, name).is_some()
}

/// Run hook `name` if there is one. A non-zero exit is an error carrying
/// the hook's output.
pub fn run(r: &Repository, name: &str, args: &[&str], stdin: Option<&str>) -> Result<()> {
    let Some(hook) = find(r, name) else { return Ok(()) };
    let mut cmd = Command::new(&hook);
    cmd.args(args)
        .current_dir(r.workdir().unwrap_or_else(|| r.path()))
        .env("GIT_INDEX_FILE", r.path().join("index"))
        .env("GIT_EDITOR", ":")
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| Error::msg(format!("Couldn't run the {name} hook: {e}")))?;
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().expect("stdin is piped");
        // A hook may exit without reading its input; that isn't our error.
        let _ = pipe.write_all(text.as_bytes());
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let mut text = String::from_utf8_lossy(&out.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&out.stdout);
        if !stdout.trim().is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(stdout.trim());
        }
        return Err(Error::msg(if text.is_empty() {
            format!("The {name} hook failed ({})", out.status)
        } else {
            format!("The {name} hook failed:\n{text}")
        }));
    }
    Ok(())
}

/// Run a hook whose outcome changes nothing (`post-commit`, ...).
pub fn notify(r: &Repository, name: &str, args: &[&str]) {
    let _ = run(r, name, args, None);
}

/// Pass a commit message through `prepare-commit-msg` and `commit-msg`,
/// which may edit it in place. `source` is what git would pass
/// (`message`, `commit` with the amended commit's id, `merge`).
pub fn commit_message(r: &Repository, message: &str, source: &[&str]) -> Result<String> {
    if !exists(r, "prepare-commit-msg") && !exists(r, "commit-msg") {
        return Ok(message.to_owned());
    }
    let file = r.path().join("COMMIT_EDITMSG");
    // git hands hooks a message ending in a newline; scripts append to it.
    let mut text = message.to_owned();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    std::fs::write(&file, text)?;
    let path = file.to_string_lossy().into_owned();
    let mut args = vec![path.as_str()];
    args.extend_from_slice(source);
    run(r, "prepare-commit-msg", &args, None)?;
    run(r, "commit-msg", &[&path], None)?;
    Ok(std::fs::read_to_string(&file)?)
}
