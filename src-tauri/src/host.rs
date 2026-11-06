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
    // A GUI app starting a console program would flash a window for it.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The user's home folder: `$HOME` when set, as git reads it, else the
/// system's own idea of it (`%USERPROFILE%` on Windows).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").filter(|h| !h.is_empty()).map(PathBuf::from).or_else(std::env::home_dir)
}

/// A path from `canonicalize` without the `\\?\` that Windows puts on it,
/// which people shouldn't see and not every program takes.
pub fn plain_path(path: &str) -> String {
    match path.strip_prefix(r"\\?\") {
        Some(rest) => match rest.strip_prefix(r"UNC\") {
            Some(share) => format!(r"\\{share}"),
            None => rest.to_owned(),
        },
        None => path.to_owned(),
    }
}

/// A script of the repository's (a hook) as a command. Windows can't start
/// a `#!` script itself, so there it goes through sh, whose `exec` honours
/// the `#!` line; `None` when there is no sh to do that.
pub fn script(path: &Path, envs: &[(&str, &OsStr)]) -> Option<Command> {
    #[cfg(windows)]
    {
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return Some(command(path, envs));
        }
        let mut cmd = command(sh()?, envs);
        cmd.args(["-c", r#"exec "$0" "$@""#]).arg(path.to_string_lossy().replace('\\', "/"));
        Some(cmd)
    }
    #[cfg(not(windows))]
    Some(command(path, envs))
}

/// `text` as a shell command line followed by `args`, for commands written
/// for git (`core.sshCommand`, a bisect's test): through sh like git runs
/// them. On Windows without sh, through cmd.
pub fn shell_command(text: &str, args: &[String], envs: &[(&str, &OsStr)]) -> Command {
    #[cfg(windows)]
    let Some(sh) = sh() else {
        return cmd_command(&cmd_line(text, args), envs);
    };
    #[cfg(not(windows))]
    let sh = "sh";
    let mut cmd = command(sh, envs);
    if args.is_empty() {
        cmd.args(["-c", text]);
    } else {
        // Like git: the command is shell text, the arguments follow.
        cmd.arg("-c").arg(format!("{text} \"$@\"")).arg(text).args(args);
    }
    cmd
}

/// `text` run by the system's own shell, for commands written for this
/// machine (an editor from Settings; on Windows `code` is a `.cmd`).
pub fn native_shell(text: &str, envs: &[(&str, &OsStr)]) -> Command {
    #[cfg(windows)]
    {
        cmd_command(text, envs)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = command("sh", envs);
        cmd.args(["-c", text]);
        cmd
    }
}

/// `s` as one word for `native_shell`.
pub fn native_quote(s: &str) -> String {
    #[cfg(windows)]
    {
        cmd_quote(s)
    }
    #[cfg(not(windows))]
    {
        crate::git::ssh::quote(s)
    }
}

/// `line` through cmd. `/S` with the outer quotes leaves the rest as it is,
/// which is why it can't go through `Command::arg` and its own quoting.
#[cfg(windows)]
fn cmd_command(line: &str, envs: &[(&str, &OsStr)]) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = command("cmd", envs);
    cmd.raw_arg(format!(r#"/S /C "{line}""#));
    cmd
}

#[cfg(any(windows, test))]
fn cmd_line(text: &str, args: &[String]) -> String {
    let mut line = text.to_owned();
    for arg in args {
        line.push(' ');
        line.push_str(&cmd_quote(arg));
    }
    line
}

/// One word for cmd. A `"` would end the quoting and leave `&` and the like
/// live, and paths and remote urls may come from a repository, so quotes and
/// control characters go; Windows file names can't have them anyway.
/// Backslashes before the closing quote are doubled so that the program
/// doesn't read `\"` as an escaped quote.
#[cfg(any(windows, test))]
fn cmd_quote(s: &str) -> String {
    let clean: String = s.chars().filter(|c| *c != '"' && !c.is_control()).collect();
    let trailing = clean.len() - clean.trim_end_matches('\\').len();
    format!("\"{clean}{}\"", "\\".repeat(trailing))
}

/// The sh that Git for Windows brings.
#[cfg(windows)]
fn sh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut roots: Vec<PathBuf> =
        ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].iter().filter_map(std::env::var_os).map(PathBuf::from).collect();
    roots.extend(std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs")));
    find_sh(&path, &roots)
}

/// `sh.exe` on `path`, else beside a `git.exe` on it (the installer normally
/// only adds `Git\cmd`), else in a Git folder under `roots`. Relative `path`
/// entries are skipped: they would mean whichever folder the app is in.
#[cfg(any(windows, test))]
fn find_sh(path: &OsStr, roots: &[PathBuf]) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::split_paths(path).filter(|d| d.is_absolute()).collect();
    let on_path = dirs.iter().map(|d| d.join("sh.exe")).find(|f| f.is_file());
    let beside_git = || {
        dirs.iter()
            .filter(|d| d.join("git.exe").is_file())
            // Git\cmd, Git\bin or Git\mingw64\bin, up to Git.
            .flat_map(|d| d.ancestors().take(3).map(|a| a.join("bin").join("sh.exe")))
            .find(|f| f.is_file())
    };
    let installed = || roots.iter().map(|r| r.join("Git").join("bin").join("sh.exe")).find(|f| f.is_file());
    on_path.or_else(beside_git).or_else(installed)
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
    #[cfg(unix)]
    fn outside_the_sandbox_commands_run_as_given() {
        if sandboxed() {
            return;
        }
        assert!(prefix(&[("A", OsStr::new("1"))]).is_empty());
        let out = command("sh", &[("GITBRIX_T", OsStr::new("ok"))]).args(["-c", "printf %s \"$GITBRIX_T\""]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    }

    #[test]
    #[cfg(unix)]
    fn shell_commands_take_their_arguments_as_words() {
        if sandboxed() {
            return;
        }
        let out = shell_command("printf '[%s]'", &["a b".into(), "it's".into()], &[]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "[a b][it's]");
        // No arguments: the text alone, so that it may end in anything.
        let out = shell_command("printf ok; #", &[], &[]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout), "ok");
    }

    #[test]
    #[cfg(windows)]
    fn cmd_gets_the_line_as_written() {
        let out = native_shell(&format!("echo {}", native_quote("a b&c")), &[]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), r#""a b&c""#);
        // A quote in a word can't end it and start another command.
        let out = native_shell(&format!("echo {}", native_quote(r#"x"&echo pwned&"y"#)), &[]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), r#""x&echo pwned&y""#);
    }

    #[test]
    fn the_verbatim_prefix_goes() {
        assert_eq!(plain_path(r"\\?\C:\code\app"), r"C:\code\app");
        assert_eq!(plain_path(r"\\?\UNC\server\share\app"), r"\\server\share\app");
        assert_eq!(plain_path(r"C:\code\app"), r"C:\code\app");
        assert_eq!(plain_path("/home/me/app"), "/home/me/app");
    }

    #[test]
    fn cmd_words_cannot_break_out_of_their_quotes() {
        assert_eq!(cmd_quote(r"C:\my repo\a.rs"), r#""C:\my repo\a.rs""#);
        assert_eq!(cmd_quote(r#"x"&calc&"y"#), r#""x&calc&y""#);
        assert_eq!(cmd_quote("a\nb\r\0c"), r#""abc""#);
        assert_eq!(cmd_quote(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(cmd_line("ssh -v", &["host".into(), "git-upload-pack 'r.git'".into()]), r#"ssh -v "host" "git-upload-pack 'r.git'""#);
    }

    /// A folder with the given files.
    fn tree(files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for f in files {
            let file = dir.path().join(f);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, "").unwrap();
        }
        dir
    }

    fn path_of(dirs: &[PathBuf]) -> std::ffi::OsString {
        std::env::join_paths(dirs).unwrap()
    }

    #[test]
    fn sh_is_found_on_the_path_first() {
        let t = tree(&["a/sh.exe", "Git/bin/sh.exe"]);
        let path = path_of(&[t.path().join("a")]);
        assert_eq!(find_sh(&path, &[t.path().into()]), Some(t.path().join("a/sh.exe")));
    }

    #[test]
    fn sh_is_found_beside_git() {
        for git in ["G/cmd", "G/bin", "G/mingw64/bin"] {
            let t = tree(&[&format!("{git}/git.exe"), "G/bin/sh.exe"]);
            let path = path_of(&[t.path().join(git)]);
            assert_eq!(find_sh(&path, &[]), Some(t.path().join("G/bin/sh.exe")), "{git}");
        }
    }

    #[test]
    fn sh_is_found_in_the_install_folders() {
        let t = tree(&["pf/Git/bin/sh.exe"]);
        assert_eq!(find_sh(OsStr::new(""), &[t.path().join("nope"), t.path().join("pf")]), Some(t.path().join("pf/Git/bin/sh.exe")));
        assert_eq!(find_sh(OsStr::new(""), &[t.path().join("nope")]), None);
    }

    #[test]
    fn relative_path_entries_are_not_searched() {
        // An empty entry or "." would pick up a sh.exe from the current folder.
        let t = tempfile::tempdir_in(".").unwrap();
        std::fs::write(t.path().join("sh.exe"), "").unwrap();
        let relative = t.path().strip_prefix(std::env::current_dir().unwrap()).unwrap();
        assert!(relative.join("sh.exe").is_file());
        let path = path_of(&[PathBuf::new(), relative.to_path_buf()]);
        assert_eq!(find_sh(&path, &[]), None);
    }
}
