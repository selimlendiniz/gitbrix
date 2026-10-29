//! Thin wrapper around the `git` executable.
//!
//! Every write and network operation goes through here instead of libgit2
//! so hooks, credential helpers, signing and ssh config behave exactly as
//! they do in the user's terminal.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{Error, Result};

pub struct Output {
    pub stdout: String,
}

fn base(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo);
    // Never block on an interactive prompt: there is no terminal attached.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Stable, parseable output regardless of the user's locale.
    cmd.env("LC_ALL", "C");
    cmd.stdin(Stdio::null());
    cmd
}

pub fn run(repo: &Path, args: &[&str]) -> Result<Output> {
    run_with_input(repo, args, None)
}

pub fn run_with_input(repo: &Path, args: &[&str], input: Option<&str>) -> Result<Output> {
    let mut cmd = base(repo);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = cmd.spawn()?;
    if let Some(text) = input {
        // Dropping the handle closes stdin so git sees EOF.
        let mut stdin = child.stdin.take().expect("stdin is piped");
        stdin.write_all(text.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        let msg = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        let msg = if msg.is_empty() {
            format!("git {} failed ({})", args.first().unwrap_or(&""), out.status)
        } else {
            msg.to_string()
        };
        return Err(Error::Cli(msg));
    }
    Ok(Output { stdout })
}

/// Run git and report progress as it goes. Git writes progress to stderr,
/// redrawing a line with `\r`; each redraw is passed to `on_progress`.
pub fn run_progress(repo: &Path, args: &[&str], mut on_progress: impl FnMut(&str)) -> Result<Output> {
    let mut cmd = base(repo);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;

    // Drain stdout on another thread so a full pipe can't block git.
    let mut stdout_pipe = child.stdout.take().expect("stdout is piped");
    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });

    let mut stderr_pipe = child.stderr.take().expect("stderr is piped");
    let mut stderr = Vec::new();
    let mut line = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stderr_pipe.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        stderr.extend_from_slice(&chunk[..n]);
        for &b in &chunk[..n] {
            if b == b'\r' || b == b'\n' {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim();
                if !text.is_empty() {
                    on_progress(text);
                }
                line.clear();
            } else {
                line.push(b);
            }
        }
    }

    let status = child.wait()?;
    let stdout = String::from_utf8_lossy(&stdout_thread.join().unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&stderr).into_owned();
    if !status.success() {
        // Keep the meaningful lines, not the progress redraws.
        let msg: Vec<&str> = stderr
            .split(['\r', '\n'])
            .map(str::trim)
            .filter(|l| !l.is_empty() && !is_progress_line(l))
            .collect();
        let msg = if msg.is_empty() { format!("git {} failed ({status})", args.first().unwrap_or(&"")) } else { msg.join("\n") };
        return Err(Error::Cli(msg));
    }
    Ok(Output { stdout })
}

fn is_progress_line(l: &str) -> bool {
    const PREFIXES: [&str; 8] = [
        "Counting objects",
        "Compressing objects",
        "Writing objects",
        "Receiving objects",
        "Resolving deltas",
        "Enumerating objects",
        "Total ",
        "Updating files",
    ];
    PREFIXES.iter().any(|p| l.starts_with(p)) || l.starts_with("remote: Counting") || l.starts_with("remote: Compressing")
}
