import { useEffect, useState } from "react";

import { api, DiffLine, FileDiff } from "../api";
import { discardFiles } from "../actions";
import { shortId, statusLetter } from "../format";
import { buildPatch, lineRange } from "../diff/patch";
import { splitRows } from "../diff/split";
import { useStore } from "../store";
import { IconClose } from "./Icons";

type Mode = "unified" | "split";
const MODE_KEY = "gitbrix.diffMode";

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

export function DiffView() {
  const source = useStore((s) => s.diffSource);
  const diff = useStore((s) => s.diff);
  const error = useStore((s) => s.diffError);
  const close = useStore((s) => s.closeDiff);
  const run = useStore((s) => s.run);
  const [mode, setMode] = useState<Mode>(loadMode);

  const openDiff = useStore((s) => s.openDiff);

  if (!source || (source.kind !== "commit" && source.kind !== "wip")) return null;

  function changeMode(m: Mode) {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // ignore
    }
  }

  const status = diff?.status;
  return (
    <div className="diff-view" data-testid="diff">
      <div className="diff-header">
        {status && <span className={`status-badge s-${status}`}>{statusLetter(status)}</span>}
        <span className="diff-path">
          {diff?.oldPath && <span className="dim">{diff.oldPath} → </span>}
          {source.path}
        </span>
        <span className="dim diff-where">
          {source.kind === "commit" ? `in ${shortId(source.id)}` : source.staged ? "staged" : "unstaged"}
        </span>
        <span className="diff-header-actions">
          {source.kind === "wip" &&
            (source.staged ? (
              <button className="small-btn" onClick={() => run("Unstaging", (r) => api.unstage(r, [source.path]), undefined, "status")}>
                Unstage file
              </button>
            ) : (
              <>
                {status !== "conflicted" && (
                  <button className="small-btn danger" onClick={() => discardFiles([source.path])}>
                    Discard
                  </button>
                )}
                <button className="small-btn" onClick={() => run("Staging", (r) => api.stage(r, [source.path]), undefined, "status")}>
                  Stage file
                </button>
              </>
            ))}
          <button className="link-btn" onClick={() => openDiff({ kind: "history", path: source.path })}>
            History
          </button>
          <button
            className="link-btn"
            onClick={() =>
              openDiff({ kind: "blame", path: source.path, rev: source.kind === "commit" ? source.id : null })
            }
          >
            Blame
          </button>
          <span className="segmented">
            <button className={mode === "unified" ? "on" : ""} onClick={() => changeMode("unified")}>
              Unified
            </button>
            <button className={mode === "split" ? "on" : ""} onClick={() => changeMode("split")}>
              Split
            </button>
          </span>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="diff-body">
        {error ? (
          <div className="diff-message">{error}</div>
        ) : !diff ? (
          <div className="diff-message">Loading diff…</div>
        ) : (
          <DiffContent diff={diff} mode={mode} wip={source.kind === "wip" ? source : null} />
        )}
      </div>
    </div>
  );
}

type WipSource = { kind: "wip"; path: string; staged: boolean };

interface Selection {
  hunk: number;
  lines: Set<number>;
  anchor: number;
}

export function DiffContent({ diff, mode, wip }: { diff: FileDiff; mode: Mode; wip: WipSource | null }) {
  const run = useStore((s) => s.run);
  const confirm = useStore((s) => s.confirm);
  const [sel, setSel] = useState<Selection | null>(null);

  // A new diff (after staging, or another file) invalidates line indices.
  useEffect(() => setSel(null), [diff]);

  if (diff.binary) return <div className="diff-message">Binary file — no text diff.</div>;
  if (diff.hunks.length === 0) {
    return <div className="diff-message">{diff.status === "renamed" ? "File renamed without changes." : "No content changes."}</div>;
  }

  function pick(hunk: number, line: number, extend: boolean) {
    setSel((cur) => {
      if (extend && cur && cur.hunk === hunk) {
        return { ...cur, lines: new Set([...cur.lines, ...lineRange(diff.hunks[hunk], cur.anchor, line)]) };
      }
      const lines = new Set(cur?.hunk === hunk ? cur.lines : []);
      if (lines.has(line)) lines.delete(line);
      else lines.add(line);
      return lines.size ? { hunk, lines, anchor: line } : null;
    });
  }

  async function apply(hunk: number, action: "stage" | "unstage" | "discard") {
    const h = diff.hunks[hunk];
    const lines = sel?.hunk === hunk ? sel.lines : null;
    const reverse = action !== "stage";
    const patch = buildPatch(diff, h, lines, reverse);
    if (!patch) return;
    const what = lines ? `${lines.size} line${lines.size === 1 ? "" : "s"}` : "this hunk";
    if (action === "discard") {
      const ok = await confirm({
        title: "Discard changes",
        message: `Discard ${what} in ${diff.path}? This cannot be undone.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    const intentToAdd = action === "stage" && diff.status === "untracked" ? diff.path : null;
    const label = { stage: "Staging", unstage: "Unstaging", discard: "Discarding" }[action];
    await run(label, (r) => api.applyPatch(r, patch, action === "discard" ? "worktree" : "index", reverse, intentToAdd), undefined, "status");
  }

  return (
    <div className={`diff-table ${mode}`}>
      {diff.hunks.map((h, i) => {
        const n = sel?.hunk === i ? sel.lines.size : 0;
        const what = n ? `${n} line${n === 1 ? "" : "s"}` : "hunk";
        return (
          <div className="hunk" key={i}>
            <div className="hunk-header">
              <span className="hunk-range">{h.header}</span>
              {wip && (
                <span className="hunk-actions">
                  {wip.staged ? (
                    <button className="small-btn" onClick={() => apply(i, "unstage")}>
                      Unstage {what}
                    </button>
                  ) : (
                    <>
                      <button className="small-btn danger" onClick={() => apply(i, "discard")}>
                        Discard {what}
                      </button>
                      <button className="small-btn" onClick={() => apply(i, "stage")}>
                        Stage {what}
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            {mode === "unified"
              ? h.lines.map((l, j) => (
                  <UnifiedLine
                    key={j}
                    l={l}
                    selected={sel?.hunk === i && sel.lines.has(j)}
                    onPick={wip && l.kind !== "ctx" ? (extend) => pick(i, j, extend) : undefined}
                  />
                ))
              : splitRows(h.lines).map((r, j) => (
                  <div className="split-row" key={j}>
                    <SideLine l={r.left} side="old" />
                    <SideLine l={r.right} side="new" />
                  </div>
                ))}
          </div>
        );
      })}
      {diff.truncated && <div className="diff-message">Diff truncated — file is too large to show in full.</div>}
    </div>
  );
}

function UnifiedLine({ l, selected, onPick }: { l: DiffLine; selected: boolean; onPick?: (extend: boolean) => void }) {
  return (
    <div
      className={`dl ${l.kind}${selected ? " picked" : ""}${onPick ? " pickable" : ""}`}
      onMouseDown={
        onPick
          ? (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onPick(e.shiftKey);
            }
          : undefined
      }
      title={onPick ? "Click to select, Shift+click for a range" : undefined}
    >
      <span className="ln">{l.oldNo ?? ""}</span>
      <span className="ln">{l.newNo ?? ""}</span>
      <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
      <span className="code">{l.text || " "}</span>
    </div>
  );
}

function SideLine({ l, side }: { l: DiffLine | null; side: "old" | "new" }) {
  if (!l) return <div className="dl empty"><span className="ln" /><span className="code" /></div>;
  const kind = l.kind === "ctx" ? "ctx" : l.kind;
  return (
    <div className={`dl ${kind}`}>
      <span className="ln">{(side === "old" ? l.oldNo : l.newNo) ?? ""}</span>
      <span className="code">{l.text || " "}</span>
    </div>
  );
}
