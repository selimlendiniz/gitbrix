import { useEffect, useState } from "react";

import { api, DiffLine, FileDiff } from "../api";
import { discardFiles } from "../actions";
import { shortId, statusLetter } from "../format";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !useStore.getState().dialog && !useStore.getState().menu) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!source) return null;

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
              <button className="small-btn" onClick={() => run("Unstaging", (r) => api.unstage(r, [source.path]))}>
                Unstage file
              </button>
            ) : (
              <>
                {status !== "conflicted" && (
                  <button className="small-btn danger" onClick={() => discardFiles([source.path])}>
                    Discard
                  </button>
                )}
                <button className="small-btn" onClick={() => run("Staging", (r) => api.stage(r, [source.path]))}>
                  Stage file
                </button>
              </>
            ))}
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
          <DiffContent diff={diff} mode={mode} />
        )}
      </div>
    </div>
  );
}

function DiffContent({ diff, mode }: { diff: FileDiff; mode: Mode }) {
  if (diff.binary) return <div className="diff-message">Binary file — no text diff.</div>;
  if (diff.hunks.length === 0) {
    return <div className="diff-message">{diff.status === "renamed" ? "File renamed without changes." : "No content changes."}</div>;
  }
  return (
    <div className={`diff-table ${mode}`}>
      {diff.hunks.map((h, i) => (
        <div className="hunk" key={i}>
          <div className="hunk-header">{h.header}</div>
          {mode === "unified"
            ? h.lines.map((l, j) => <UnifiedLine key={j} l={l} />)
            : splitRows(h.lines).map((r, j) => (
                <div className="split-row" key={j}>
                  <SideLine l={r.left} side="old" />
                  <SideLine l={r.right} side="new" />
                </div>
              ))}
        </div>
      ))}
      {diff.truncated && <div className="diff-message">Diff truncated — file is too large to show in full.</div>}
    </div>
  );
}

function UnifiedLine({ l }: { l: DiffLine }) {
  return (
    <div className={`dl ${l.kind}`}>
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
