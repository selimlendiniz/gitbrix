//! Thin wrapper around the `git` executable.
//!
//! Every write and network operation goes through here instead of libgit2
//! so hooks, credential helpers, signing and ssh config behave exactly as
//! they do in the user's terminal.

use std::io::Write;
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
