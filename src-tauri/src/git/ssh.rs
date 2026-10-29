//! ssh remotes through the system's `ssh` program, as git does it: run
//! `ssh host git-upload-pack '<path>'` and speak the git protocol over its
//! stdin/stdout. Unlike libgit2's built-in libssh2 transport this honours
//! `~/.ssh/config`, the agent, hardware keys and `known_hosts`, and asks
//! for passphrases through the desktop's askpass helper.

use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, Once};

use git2::transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport};

thread_local! {
    /// `core.sshCommand` of the repository the current operation runs in.
    static SSH_COMMAND: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Use `command` (from `core.sshCommand`) for ssh on this thread.
pub fn set_command(command: Option<String>) {
    SSH_COMMAND.with(|c| *c.borrow_mut() = command);
}

pub fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        for scheme in ["ssh", "ssh+git", "git+ssh"] {
            // SAFETY: registration happens once, before any transport is
            // created by this process (every network operation calls this
            // first).
            let _ = unsafe { git2::transport::register(scheme, |remote| Transport::smart(remote, false, SshExec)) };
        }
    });
}

/// Host, port and path of an ssh URL (`ssh://[user@]host[:port]/path`) or
/// scp-like address (`[user@]host:path`).
pub fn parse_url(url: &str) -> Option<(String, Option<String>, String)> {
    for scheme in ["ssh://", "ssh+git://", "git+ssh://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let (authority, path) = rest.split_at(rest.find('/')?);
            let (host, port) = match authority.rfind(']') {
                // [ipv6] with an optional :port after it
                Some(i) => (&authority[..=i], authority[i + 1..].strip_prefix(':')),
                None => match authority.rsplit_once(':') {
                    Some((h, p)) => (h, Some(p)),
                    None => (authority, None),
                },
            };
            let port = port.filter(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())).map(str::to_owned);
            // "/~user/repo" is relative to that user's home.
            let path = path.strip_prefix('/').filter(|p| p.starts_with('~')).unwrap_or(path);
            let host = host.replace(['[', ']'], "");
            return (!host.is_empty()).then(|| (host, port, path.to_owned()));
        }
    }
    // scp-like: the first ':' not inside [ipv6] separates host and path.
    let (host, path) = if let Some(rest) = url.strip_prefix('[') {
        let (h, p) = rest.split_once("]:")?;
        (h.to_owned(), p)
    } else {
        let (h, p) = url.split_once(':')?;
        if h.contains('/') {
            return None;
        }
        (h.to_owned(), p)
    };
    (!host.is_empty() && !path.is_empty()).then(|| (host, None, path.to_owned()))
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

struct SshExec;

impl SmartSubtransport for SshExec {
    fn action(&self, url: &str, action: Service) -> Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        let (host, port, path) =
            parse_url(url).ok_or_else(|| git2::Error::from_str(&format!("Not an ssh address: {url}")))?;
        if host.starts_with('-') || path.starts_with('-') {
            return Err(git2::Error::from_str("Refusing an ssh address that looks like an option"));
        }
        let service = match action {
            Service::UploadPackLs | Service::UploadPack => "git-upload-pack",
            Service::ReceivePackLs | Service::ReceivePack => "git-receive-pack",
        };
        let mut ssh_args: Vec<String> = Vec::new();
        if let Some(p) = port {
            ssh_args.extend(["-p".into(), p]);
        }
        ssh_args.push(host);
        ssh_args.push(format!("{service} {}", quote(&path)));

        let configured = std::env::var("GIT_SSH_COMMAND").ok().or_else(|| SSH_COMMAND.with(|c| c.borrow().clone()));
        let mut cmd = match configured {
            // Like git: the command is shell text, the arguments follow.
            Some(c) => {
                let mut cmd = Command::new("sh");
                cmd.arg("-c").arg(format!("{c} \"$@\"")).arg(c);
                cmd
            }
            None => Command::new(std::env::var_os("GIT_SSH").unwrap_or_else(|| "ssh".into())),
        };
        cmd.args(&ssh_args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // No terminal is attached: prompts go to the desktop's askpass
        // helper (KDE: ksshaskpass) when one is configured.
        if std::env::var_os("SSH_ASKPASS").is_some() {
            cmd.env("SSH_ASKPASS_REQUIRE", "force");
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| git2::Error::from_str(&format!("Couldn't run ssh: {e}. Is OpenSSH installed?")))?;
        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let mut stderr_pipe = child.stderr.take().expect("piped");
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr_pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().expect("not poisoned").extend_from_slice(&buf[..n]);
            }
        });
        Ok(Box::new(SshStream { child, stdin: Some(stdin), stdout, stderr }))
    }

    fn close(&self) -> Result<(), git2::Error> {
        Ok(())
    }
}

struct SshStream {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl SshStream {
    fn failure(&mut self) -> io::Error {
        // Give the stderr reader a moment to collect ssh's last words.
        std::thread::sleep(std::time::Duration::from_millis(50));
        let text = String::from_utf8_lossy(&self.stderr.lock().expect("not poisoned")).trim().to_owned();
        io::Error::other(if text.is_empty() { "ssh closed the connection".to_owned() } else { text })
    }
}

impl Read for SshStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.stdout.read(buf)?;
        if n == 0 {
            if let Ok(status) = self.child.wait() {
                if !status.success() {
                    return Err(self.failure());
                }
            }
        }
        Ok(n)
    }
}

impl Write for SshStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let stdin = self.stdin.as_mut().ok_or_else(|| io::Error::other("ssh input closed"))?;
        match stdin.write(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe => Err(self.failure()),
            Err(e) => Err(e),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(s) => s.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for SshStream {
    fn drop(&mut self) {
        // Closing stdin ends the remote command, which ends ssh.
        self.stdin.take();
        for _ in 0..40 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str) -> Option<(String, Option<String>, String)> {
        parse_url(url)
    }

    #[test]
    fn parses_ssh_addresses() {
        assert_eq!(p("git@github.com:org/repo.git"), Some(("git@github.com".into(), None, "org/repo.git".into())));
        assert_eq!(p("ssh://git@host:2222/srv/r.git"), Some(("git@host".into(), Some("2222".into()), "/srv/r.git".into())));
        assert_eq!(p("ssh://host/~me/r.git"), Some(("host".into(), None, "~me/r.git".into())));
        assert_eq!(p("ssh://[::1]:22/r"), Some(("::1".into(), Some("22".into()), "/r".into())));
        assert_eq!(p("[::1]:r.git"), Some(("::1".into(), None, "r.git".into())));
        assert_eq!(p("/local/path"), None);
        assert_eq!(p("./a:b/c"), None);
    }

    #[test]
    fn quotes_paths_for_the_remote_shell() {
        assert_eq!(quote("it's/r.git"), r"'it'\''s/r.git'");
    }
}
