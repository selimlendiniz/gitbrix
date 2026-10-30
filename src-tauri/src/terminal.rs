//! Embedded terminal: the user's shell on a pseudo-terminal, started in the
//! repository's folder. Output goes to the webview as `terminal-output`
//! events (base64, since a read can split a UTF-8 character); the session
//! ends with `terminal-exit` when the shell quits.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};

struct Session {
    /// The window it's shown in; its output goes only there.
    window: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: Arc<Mutex<HashMap<u32, Session>>>,
    next: AtomicU32,
}

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: String,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// The login shell from $SHELL, else bash, else sh.
fn shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty() && Path::new(s).exists())
        .or_else(|| ["/bin/bash", "/usr/bin/bash", "/bin/sh"].iter().find(|s| Path::new(s).exists()).map(|s| s.to_string()))
        .unwrap_or_else(|| "sh".into())
}

fn pty_error(e: impl std::fmt::Display) -> Error {
    Error::msg(format!("Terminal: {e}"))
}

pub fn open(app: AppHandle, state: &Terminals, window: &str, cwd: &str, cols: u16, rows: u16) -> Result<u32> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(pty_error)?;
    let term = [("TERM", std::ffi::OsStr::new("xterm-256color")), ("COLORTERM", std::ffi::OsStr::new("truecolor"))];
    // In Flatpak, the user's own shell on the host.
    let prefix = crate::host::prefix(&term);
    let mut cmd = match prefix.split_first() {
        Some((spawn, rest)) => {
            let mut c = CommandBuilder::new(spawn);
            c.args(rest);
            c.args(["sh", "-c", "exec \"${SHELL:-/bin/bash}\""]);
            c
        }
        None => CommandBuilder::new(shell()),
    };
    cmd.cwd(cwd);
    for (k, v) in term {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd).map_err(pty_error)?;
    // The shell holds its own copy of the slave side.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(pty_error)?;
    let writer = pair.master.take_writer().map_err(pty_error)?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.sessions.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Session { window: window.to_owned(), master: pair.master, writer, child });

    let sessions = state.sessions.clone();
    let window = window.to_owned();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app.emit_to(window.as_str(), "terminal-output", Output { id, data });
                }
            }
        }
        if let Some(mut s) = sessions.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            let _ = s.child.wait();
        }
        let _ = app.emit_to(window.as_str(), "terminal-exit", id);
    });
    Ok(id)
}

fn with<T>(state: &Terminals, id: u32, f: impl FnOnce(&mut Session) -> Result<T>) -> Result<T> {
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    let s = sessions.get_mut(&id).ok_or_else(|| Error::msg("The terminal has closed"))?;
    f(s)
}

pub fn write(state: &Terminals, id: u32, data: &str) -> Result<()> {
    with(state, id, |s| {
        s.writer.write_all(data.as_bytes())?;
        Ok(s.writer.flush()?)
    })
}

pub fn resize(state: &Terminals, id: u32, cols: u16, rows: u16) -> Result<()> {
    with(state, id, |s| s.master.resize(size(cols, rows)).map_err(pty_error))
}

/// Ends the shells of a window that closed.
pub fn close_window(state: &Terminals, window: &str) {
    for s in state.sessions.lock().unwrap_or_else(|e| e.into_inner()).values_mut() {
        if s.window == window {
            let _ = s.child.kill();
        }
    }
}

/// Ends the shell; the reader thread then reports `terminal-exit`.
pub fn close(state: &Terminals, id: u32) -> Result<()> {
    with(state, id, |s| s.child.kill().map_err(pty_error))
}
