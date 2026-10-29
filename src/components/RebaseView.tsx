// Interactive rebase editor. Commits are listed newest first, like the
// graph; the plan is sent to the backend oldest first, like a todo file.

import { useEffect, useState } from "react";

import { api, errorText } from "../api";
import { trackDrag } from "../dnd";
import { relativeTime, shortId } from "../format";
import { useStore } from "../store";
import { trackHead } from "../undo";
import { IconClose } from "./Icons";

export type Action = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface Row {
  id: string;
  summary: string;
  message: string;
  authorName: string;
  time: number;
  action: Action;
  newMessage: string;
}

const ACTIONS: { action: Action; key: string; label: string; hint: string }[] = [
  { action: "pick", key: "p", label: "Pick", hint: "Keep the commit" },
  { action: "reword", key: "r", label: "Reword", hint: "Keep it, change the message" },
  { action: "squash", key: "s", label: "Squash", hint: "Meld into the commit below, keep both messages" },
  { action: "fixup", key: "f", label: "Fixup", hint: "Meld into the commit below, drop this message" },
  { action: "drop", key: "d", label: "Drop", hint: "Remove the commit" },
];

/** Problems that would make git refuse or misbehave. Rows newest first. */
export function planProblems(rows: Row[]): string[] {
  const problems: string[] = [];
  const kept = rows.filter((r) => r.action !== "drop");
  const oldest = kept[kept.length - 1];
  if (oldest && (oldest.action === "squash" || oldest.action === "fixup")) {
    problems.push(`“${oldest.summary}” is the oldest kept commit; there is nothing below it to ${oldest.action} into.`);
  }
  for (const r of rows) {
    if (r.action === "reword" && !r.newMessage.trim()) problems.push(`“${r.summary}” needs a new message.`);
  }
  return problems;
}

export function RebaseView() {
  const source = useStore((s) => s.diffSource);
  const repo = useStore((s) => s.repo);
  const run = useStore((s) => s.run);
  const close = useStore((s) => s.closeDiff);
  const base = source?.kind === "rebase" ? source.base : null;

  const [rows, setRows] = useState<Row[] | null>(null);
  const [original, setOriginal] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [dragging, setDragging] = useState<number | null>(null);

  useEffect(() => {
    if (!repo || !base) return;
    let live = true;
    setRows(null);
    setError(null);
    api
      .rebaseCommits(repo.path, base)
      .then((list) => {
        if (!live) return;
        const loaded = list.map((c) => ({ ...c, action: "pick" as Action, newMessage: c.message.trim() })).reverse();
        setRows(loaded);
        setOriginal(loaded.map((r) => r.id));
        setFocus(0);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, base]);

  if (!base) return null;

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (from: number, to: number) =>
    setRows((rs) => {
      if (!rs || to < 0 || to >= rs.length || from === to) return rs;
      const next = [...rs];
      const [r] = next.splice(from, 1);
      next.splice(to, 0, r);
      return next;
    });

  const problems = rows ? planProblems(rows) : [];
  const changed = !!rows && (rows.some((r) => r.action !== "pick") || rows.map((r) => r.id).join() !== original.join());

  async function start() {
    if (!rows || !base) return;
    const steps = [...rows].reverse().map((r) => ({
      action: r.action,
      id: r.id,
      message: r.action === "reword" ? r.newMessage : null,
    }));
    const ok = await trackHead("interactive rebase", () =>
      run("Rebasing", (repoPath) => api.interactiveRebase(repoPath, base, steps), "Interactive rebase finished"),
    );
    if (ok) close();
  }

  return (
    <div className="diff-view" data-testid="rebase">
      <div className="diff-header">
        <span className="view-kind">Interactive rebase</span>
        <span className="dim diff-where">
          {rows ? `${rows.length} commit${rows.length === 1 ? "" : "s"} onto ${shortId(base)}` : ""}
        </span>
        <span className="diff-header-actions">
          <button className="small-btn" onClick={close}>
            Cancel
          </button>
          <button className="small-btn primary" disabled={!rows || problems.length > 0 || !changed} onClick={start}>
            Start rebase
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="diff-body rebase-body">
        {error ? (
          <div className="diff-message">{error}</div>
        ) : !rows ? (
          <div className="diff-message">Loading…</div>
        ) : (
          <>
            <p className="rebase-help dim">
              Newest at the top. Drag to reorder, or Alt+↑/↓. Keys: <kbd>p</kbd> pick, <kbd>r</kbd> reword, <kbd>s</kbd> squash,{" "}
              <kbd>f</kbd> fixup, <kbd>d</kbd> drop. Squash and fixup meld a commit into the one below it.
            </p>
            <div className="rebase-list">
              {rows.map((r, i) => (
                <div
                  key={r.id}
                  className={`rebase-row a-${r.action}${focus === i ? " focused" : ""}${dragging === i ? " dragging" : ""}`}
                  tabIndex={0}
                  data-index={i}
                  onFocus={() => setFocus(i)}
                  onMouseDown={(e) => {
                    // Drag by the row, not by its buttons or message box.
                    if ((e.target as HTMLElement).closest("button, textarea, input")) return;
                    let at = i;
                    trackDrag(e, {
                      start: () => setDragging(at),
                      move: (ev) => {
                        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".rebase-row");
                        const to = over ? Number(over.dataset.index) : at;
                        if (to !== at) {
                          move(at, to);
                          at = to;
                          setDragging(to);
                        }
                      },
                      end: () => setDragging(null),
                    });
                  }}
                  onKeyDown={(e) => {
                    if ((e.target as HTMLElement).tagName === "TEXTAREA") return;
                    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                      e.preventDefault();
                      const to = i + (e.key === "ArrowUp" ? -1 : 1);
                      move(i, to);
                      setFocus(Math.max(0, Math.min(rows.length - 1, to)));
                      return;
                    }
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      const el = e.currentTarget.parentElement?.children[i + (e.key === "ArrowUp" ? -1 : 1)] as HTMLElement | undefined;
                      el?.focus();
                      return;
                    }
                    const a = ACTIONS.find((x) => x.key === e.key.toLowerCase());
                    if (a && !e.ctrlKey && !e.metaKey && !e.altKey) {
                      e.preventDefault();
                      update(i, { action: a.action });
                    }
                  }}
                >
                  <span className="drag-handle" title="Drag to reorder">
                    ⋮⋮
                  </span>
                  <span className="rebase-actions">
                    {ACTIONS.map((a) => (
                      <button
                        key={a.action}
                        className={r.action === a.action ? "on" : ""}
                        title={`${a.hint} (${a.key})`}
                        onClick={() => update(i, { action: a.action })}
                      >
                        {a.label}
                      </button>
                    ))}
                  </span>
                  <span className="rebase-commit">
                    <span className="rebase-summary">
                      {(r.action === "squash" || r.action === "fixup") && <span className="meld">↳ </span>}
                      {r.summary}
                    </span>
                    <span className="rebase-meta dim">
                      <span className="sha-inline">{shortId(r.id)}</span>
                      {r.authorName} · {relativeTime(r.time)}
                    </span>
                    {r.action === "reword" && (
                      <textarea
                        className="rebase-message"
                        rows={Math.min(8, Math.max(2, r.newMessage.split("\n").length))}
                        value={r.newMessage}
                        onChange={(e) => update(i, { newMessage: e.target.value })}
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
            {problems.length > 0 && (
              <div className="rebase-problems">
                {problems.map((p) => (
                  <div key={p}>{p}</div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
