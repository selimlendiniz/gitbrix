// Embedded terminals: one shell per repository, started on first use and
// kept (with its scrollback) while the panel is hidden or another tab is
// shown. The backend runs the shell on a pseudo-terminal; xterm.js draws it.

import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { create } from "zustand";

import { api, errorText } from "./api";

export const useTerminal = create<{ open: boolean }>(() => ({ open: false }));

export function toggleTerminal() {
  useTerminal.setState((s) => ({ open: !s.open }));
}

interface Session {
  repo: string;
  term: Terminal;
  fit: FitAddon;
  /** Where xterm draws; moved into the panel while it shows this repo. */
  host: HTMLDivElement;
  id: number | null;
  starting: boolean;
}

const sessions = new Map<string, Session>();
const byId = new Map<number, Session>();

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function themeColors() {
  return {
    background: cssVar("--bg-graph") || "#16181e",
    foreground: cssVar("--text") || "#d7dce5",
    cursor: cssVar("--accent") || "#5aa9ff",
    selectionBackground: cssVar("--bg-select") || "#2b3a55",
  };
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let listening: Promise<unknown> | null = null;

function listenOnce() {
  listening ??= Promise.all([
    listen<{ id: number; data: string }>("terminal-output", (e) => byId.get(e.payload.id)?.term.write(decode(e.payload.data))),
    listen<number>("terminal-exit", (e) => {
      const s = byId.get(e.payload);
      if (!s) return;
      byId.delete(e.payload);
      s.id = null;
      s.term.write("\r\n\x1b[2m[shell exited — press Enter for a new one]\x1b[0m\r\n");
    }),
  ]).catch(() => {});
  return listening;
}

async function start(s: Session) {
  if (s.id !== null || s.starting) return;
  s.starting = true;
  try {
    await listenOnce();
    const id = await api.terminalOpen(s.repo, s.term.cols, s.term.rows);
    s.id = id;
    byId.set(id, s);
  } catch (e) {
    s.term.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`);
  } finally {
    s.starting = false;
  }
}

/** The repository's terminal, made on first use. */
export function sessionFor(repo: string): Session {
  let s = sessions.get(repo);
  if (s) return s;
  const term = new Terminal({
    fontFamily: cssVar("--mono") || "monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: themeColors(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const host = document.createElement("div");
  host.className = "terminal-host";
  const session: Session = { repo, term, fit, host, id: null, starting: false };
  term.onData((data) => {
    if (session.id === null) {
      // After the shell quit, Enter starts a new one.
      if (data === "\r") void start(session);
      return;
    }
    api.terminalWrite(session.id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (session.id !== null) api.terminalResize(session.id, cols, rows).catch(() => {});
  });
  sessions.set(repo, session);
  return session;
}

/** Put the repository's terminal into `container` and start its shell. */
export function attach(repo: string, container: HTMLElement): Session {
  const s = sessionFor(repo);
  if (s.host.parentElement !== container) {
    container.replaceChildren(s.host);
    if (!s.term.element) s.term.open(s.host);
  }
  s.term.options.theme = themeColors();
  fitNow(s);
  void start(s);
  return s;
}

export function fitNow(s: Session) {
  try {
    s.fit.fit();
  } catch {
    // Not laid out yet.
  }
}

/** A tab closed: its shell goes too. */
export function closeTerminal(repo: string) {
  const s = sessions.get(repo);
  if (!s) return;
  sessions.delete(repo);
  if (s.id !== null) {
    byId.delete(s.id);
    api.terminalClose(s.id).catch(() => {});
  }
  s.term.dispose();
}
