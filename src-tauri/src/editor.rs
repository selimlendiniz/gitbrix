//! Opening a file (at a line) or a folder in the user's editor. The
//! command comes from Settings with `{file}`, `{line}` and `{dir}` in it;
//! each is put in as one shell word. It runs on the host (Flatpak too)
//! and is left running.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::error::{Error, Result};
use crate::host::native_quote as quote;

/// `template` with its placeholders filled; with no file, the parts about
/// the file go (an editor's folder command).
pub fn command_line(template: &str, dir: &Path, file: Option<&Path>, line: Option<u32>) -> String {
    let file = file.map(|f| quote(&f.to_string_lossy())).unwrap_or_default();
    template
        .replace("{dir}", &quote(&dir.to_string_lossy()))
        .replace("{file}", &file)
        .replace("{line}", &line.unwrap_or(1).to_string())
}

/// Start the editor; an error if it isn't there.
pub fn open(template: &str, dir: &Path, file: Option<&Path>, line: Option<u32>) -> Result<()> {
    if template.trim().is_empty() {
        return Err(Error::msg("Set an editor in Settings first"));
    }
    let cmd = command_line(template, dir, file, line);
    let mut child = crate::host::native_shell(&cmd, &[])
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| Error::msg(format!("Couldn't start the editor: {e}")))?;
    // Most editors hand over to a running instance and exit at once; a
    // missing one fails at once. Anything still running is the editor.
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(1500) {
        match child.try_wait()? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    use std::io::Read;
                    let _ = e.read_to_string(&mut err);
                }
                let first = cmd.split_whitespace().next().unwrap_or("");
                return Err(Error::msg(match status.code() {
                    // sh says 127, cmd 9009 (or 1 with its message, below).
                    Some(127 | 9009) => format!("{first} isn't installed (or not on the PATH)"),
                    _ => format!("The editor stopped: {}", err.trim().lines().last().unwrap_or("no reason given")),
                }));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    // Still running: let it be (reaped in the background).
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn placeholders_are_single_words_for_cmd() {
        let line = command_line("code --goto {file}:{line}", Path::new(r"C:\r"), Some(Path::new(r"C:\r\a b.rs")), Some(12));
        assert_eq!(line, r#"code --goto "C:\r\a b.rs":12"#);
    }

    #[test]
    #[cfg(windows)]
    fn editors_start_through_cmd() {
        let dir = std::env::temp_dir();
        open("echo {file}", &dir, Some(&dir.join("x")), None).unwrap();
        assert!(open("no-such-editor-gitbrix {file}", &dir, Some(&dir.join("x")), None).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn placeholders_are_single_words() {
        let line = command_line("code --goto {file}:{line}", Path::new("/r"), Some(Path::new("/r/a b'c.rs")), Some(12));
        assert_eq!(line, r#"code --goto '/r/a b'\''c.rs':12"#);
        assert_eq!(command_line("idea {dir}", Path::new("/my repo"), None, None), "idea '/my repo'");
    }

    #[test]
    #[cfg(unix)]
    fn missing_editors_are_reported() {
        let dir = std::env::temp_dir();
        assert!(open("no-such-editor-gitbrix {file}", &dir, Some(&dir.join("x")), None).unwrap_err().to_string().contains("isn't installed"));
        assert!(open("true {file}", &dir, Some(&dir.join("x")), Some(3)).is_ok());
        assert!(open("  ", &dir, None, None).is_err());
    }
}
