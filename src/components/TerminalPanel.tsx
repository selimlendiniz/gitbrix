// Bottom panel with the open repository's terminal (Ctrl+`).

import { useEffect, useRef } from "react";

import { updateSettings, useSettings } from "../settings";
import { useStore } from "../store";
import { attach, closeTerminal, fitNow, sessionFor, themeColors, toggleTerminal, useTerminal } from "../terminal";
import { IconClose } from "./Icons";
import { Splitter } from "./Splitter";

// Closing a tab ends its shell.
let knownTabs = useStore.getState().tabs.map((t) => t.path);
useStore.subscribe((s) => {
  const now = s.tabs.map((t) => t.path);
  for (const path of knownTabs) if (!now.includes(path)) closeTerminal(path);
  knownTabs = now;
});

export function TerminalPanel() {
  const open = useTerminal((s) => s.open);
  const repo = useStore((s) => s.repo?.path);
  const height = useSettings((s) => s.terminalHeight);
  const theme = useSettings((s) => s.theme);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !repo || !body.current) return;
    const s = attach(repo, body.current);
    s.term.focus();
    const ro = new ResizeObserver(() => fitNow(s));
    ro.observe(body.current);
    return () => ro.disconnect();
  }, [open, repo]);

  useEffect(() => {
    if (open && repo) sessionFor(repo).term.options.theme = themeColors();
  }, [theme, open, repo]);

  if (!open || !repo) return null;
  return (
    <div className="terminal-panel" style={{ height }} data-testid="terminal">
      <Splitter
        width={height}
        side="top"
        min={100}
        max={Math.round(window.innerHeight * 0.75)}
        onChange={(h) => updateSettings({ terminalHeight: h })}
      />
      <div className="terminal-head">
        <span>Terminal</span>
        <span className="dim terminal-path">{repo}</span>
        <button className="icon-btn" title="Hide terminal (Ctrl+`)" onClick={toggleTerminal}>
          <IconClose size={11} />
        </button>
      </div>
      <div className="terminal-body" ref={body} />
    </div>
  );
}
