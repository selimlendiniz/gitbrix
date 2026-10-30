//! Programs of the user's system: shells, hooks, gpg, ssh. Inside the
//! Flatpak sandbox they aren't there (or aren't the user's), so they run
//! on the host through `flatpak-spawn --host`, which needs the
//! `org.freedesktop.Flatpak` bus name. Environment variables given to the
//! spawned command must go through `--env`, not `Command::env`.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// Running inside Flatpak.
pub fn sandboxed() -> bool {
    static SANDBOXED: OnceLock<bool> = OnceLock::new();
    *SANDBOXED.get_or_init(|| Path::new("/.flatpak-info").exists())
}

/// The arguments that put `program` on the host, with `envs` set there.
/// Empty outside the sandbox.
pub fn prefix(envs: &[(&str, &OsStr)]) -> Vec<std::ffi::OsString> {
    if !sandboxed() {
        return Vec::new();
    }
    // --watch-bus: the host process ends if the app does.
    let mut out: Vec<std::ffi::OsString> = vec!["flatpak-spawn".into(), "--host".into(), "--watch-bus".into()];
    for (k, v) in envs {
        let mut arg = std::ffi::OsString::from(format!("--env={k}="));
        arg.push(v);
        out.push(arg);
    }
    out
}

/// `program` as a command, run on the host when sandboxed, with `envs`.
/// The working directory set on it carries over (flatpak-spawn passes its
/// own).
pub fn command(program: impl AsRef<OsStr>, envs: &[(&str, &OsStr)]) -> Command {
    let prefix = prefix(envs);
    let mut cmd = match prefix.split_first() {
        Some((spawn, rest)) => {
            let mut c = Command::new(spawn);
            c.args(rest).arg(program.as_ref());
            c
        }
        None => Command::new(program.as_ref()),
    };
    if !sandboxed() {
        for (k, v) in envs {
            cmd.env(k, v);
        }
    }
    cmd
}

/// Where to put files a host program must read: the sandbox's /tmp is
/// its own, but `$XDG_RUNTIME_DIR/app/<id>` is the same folder on both
/// sides.
pub fn shared_temp_dir() -> PathBuf {
    if sandboxed()
        && let (Some(run), Ok(id)) = (std::env::var_os("XDG_RUNTIME_DIR"), std::env::var("FLATPAK_ID"))
    {
        return PathBuf::from(run).join("app").join(id);
    }
    std::env::temp_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_the_sandbox_commands_run_as_given() {
        if sandboxed() {
            return;
        }
        assert!(prefix(&[("A", OsStr::new("1"))]).is_empty());
        let out = command("sh", &[("GITBRIX_T", OsStr::new("ok"))]).args(["-c", "printf %s \"$GITBRIX_T\""]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    }
}
