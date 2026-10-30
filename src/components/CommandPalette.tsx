// Ctrl+K / Ctrl+Shift+P: every action, branch checkout and recent
// repository behind one fuzzy search box.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import {
  addWorktree,
  checkoutRef,
  createBranch,
  fetchAll,
  pull,
  push,
  remoteOf,
  stashPop,
  stashSave,
} from "../actions";
import { WIP_ID } from "../api";
import { loadRecent } from "../recent";
import { useStore } from "../store";
import { undoLast } from "../undo";
import { updateSettings } from "../settings";
import { useRepoDialog } from "./RepoDialogs";
import { usePrDialog } from "./PullRequestsDialog";
import { createPullRequest } from "../prs";
import { useSettingsDialog } from "./SettingsDialog";
import { useShortcuts } from "./ShortcutsDialog";
import { openRepoDialog } from "./Welcome";
import { useWorkspaces } from "../workspaces";
import { toggleTerminal } from "../terminal";

export const usePalette = create<{ open: boolean }>(() => ({ open: false }));

export interface Command {
  id: string;
  label: string;
  group: string;
  hint?: string;
  run: () => void;
}

/** Subsequence match: every query character in order. Higher is better;
 *  null when it doesn't match. Rewards consecutive runs and word starts. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    run = found === ti ? run + 1 : 1;
    const wordStart = found === 0 || /[\s/:._-]/.test(t[found - 1]);
    score += run * 2 + (wordStart ? 3 : 0) - Math.min(found - ti, 5) * 0.2;
    ti = found + 1;
  }
  return score - t.length * 0.01;
}

function useCommands(): Command[] {
  const repo = useStore((s) => s.repo);
  const graph = useStore((s) => s.graph);
  const tabs = useStore((s) => s.tabs);
  const stashes = useStore((s) => s.stashes);

  return useMemo(() => {
    const st = useStore.getState();
    const list: Command[] = [];
    const add = (group: string, label: string, run: () => void, hint?: string) =>
      list.push({ id: `${group}:${label}`, group, label, run, hint });

    if (repo) {
      add("Action", "Fetch all remotes", fetchAll);
      add("Action", "Pull (fast-forward only)", () => pull("ff-only"));
      add("Action", "Pull (rebase)", () => pull("rebase"));
      add("Action", "Pull (merge)", () => pull("merge"));
      add("Action", "Push", () => push(false));
      add("Action", "Force push (with lease)", () => push(true));
      add("Action", "New branch at HEAD", () => createBranch(null));
      add("Action", "New worktree…", () => addWorktree());
      add("Action", "Stash changes", stashSave);
      if (stashes.length) add("Action", "Pop latest stash", () => stashPop(0));
      add("Action", "Undo", () => void undoLast(), "Ctrl+Z");
      add("Action", "Refresh", () => void st.refresh(), "F5");
      add("Action", "Search commits", () => window.dispatchEvent(new Event("gitbrix:find")), "Ctrl+F");
      add("Action", "Show working tree changes", () => st.select(WIP_ID, true));
      add("Action", "Reflog — recover lost commits", () => void st.openDiff({ kind: "reflog" }));
      if (repo.headBranch && !repo.detached) add("Action", `Create pull request for ${repo.headBranch}…`, () => createPullRequest());
      add("Action", "Show or hide the terminal", toggleTerminal, "Ctrl+`");
      add("Action", "Go to HEAD", () => repo.headOid && st.select(repo.headOid, true));
      for (const r of graph?.refs ?? []) {
        if (r.kind === "local" && !r.isHead) add("Checkout", r.name, () => checkoutRef(r));
        if (r.kind === "remote") add("Checkout", r.name, () => checkoutRef(r), `as ${remoteOf(r).branch}`);
        add("Go to", r.name, () => st.select(r.target, true), r.kind);
      }
    }
    add("Settings", "Settings…", () => useSettingsDialog.setState({ open: true }));
    add("Action", "Pull requests…", () => usePrDialog.setState({ open: true }));
    add("Repository", "Workspace…", () => useWorkspaces.setState({ open: true }));
    add("Help", "Keyboard shortcuts", () => useShortcuts.setState({ open: true }), "?");
    add("Settings", "Theme: dark", () => updateSettings({ theme: "dark" }));
    add("Settings", "Theme: light", () => updateSettings({ theme: "light" }));
    add("Settings", "Theme: follow system", () => updateSettings({ theme: "system" }));
    add("Repository", "Open repository…", () => void openRepoDialog(), "Ctrl+O");
    add("Repository", "Clone repository…", () => useRepoDialog.setState({ kind: "clone" }));
    add("Repository", "New repository…", () => useRepoDialog.setState({ kind: "init" }));
    for (const t of tabs) if (t.path !== repo?.path) add("Switch tab", t.name, () => void st.openRepo(t.path), t.path);
    for (const r of loadRecent()) {
      if (!tabs.some((t) => t.path === r.path)) add("Open recent", r.name, () => void st.openRepo(r.path), r.path);
    }
    return list;
  }, [repo, graph, tabs, stashes]);
}

export function CommandPalette() {
  const open = usePalette((s) => s.open);
  if (!open) return null;
  return <Palette />;
}

function Palette() {
  const commands = useCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, score: fuzzyScore(query, `${c.group} ${c.label}`) }))
      .filter((x): x is { c: Command; score: number } => x.score !== null);
    if (query) scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60).map((x) => x.c);
  }, [commands, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const close = () => usePalette.setState({ open: false });
  const runAt = (i: number) => {
    const c = results[i];
    if (!c) return;
    close();
    c.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command, branch or repository…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(active);
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">No matches</div>}
          {results.map((c, i) => (
            <div
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={`palette-item${i === active ? " active" : ""}`}
              onMouseMove={() => setActive(i)}
              onClick={() => runAt(i)}
            >
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
