// Three-way merge editor for a conflicted file: ours, base and theirs side
// by side for the conflict at hand, the result below as an editable file.
// Choosing a side rewrites that conflict block in the result text, so
// choices and hand edits mix freely; saving marks the file resolved.

import { useEffect, useMemo, useRef, useState } from "react";

import { api, ConflictFile, errorText } from "../api";
import { baseOf, ConflictSegment, conflictRange, conflictsOf, parseConflicts, replaceConflict } from "../diff/conflicts";
import { useStore } from "../store";
import { IconChevron, IconClose } from "./Icons";

const CONTEXT = 3;

type Pick = "ours" | "base" | "theirs" | "ours-theirs" | "theirs-ours";

const PICKS: { pick: Pick; label: string; title: string }[] = [
  { pick: "ours", label: "Ours", title: "Keep our side" },
  { pick: "theirs", label: "Theirs", title: "Keep their side" },
  { pick: "ours-theirs", label: "Both", title: "Ours, then theirs" },
  { pick: "theirs-ours", label: "Both, theirs first", title: "Theirs, then ours" },
  { pick: "base", label: "Base", title: "Keep neither change: the common ancestor's lines" },
];

function linesFor(c: ConflictSegment, base: string[] | null, pick: Pick): string[] | null {
  switch (pick) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "ours-theirs":
      return [...c.ours, ...c.theirs];
    case "theirs-ours":
      return [...c.theirs, ...c.ours];
    case "base":
      return base;
  }
}

function Pane({
  title,
  kind,
  before,
  lines,
  after,
  missing,
}: {
  title: string;
  kind: "ours" | "base" | "theirs";
  before: string[];
  lines: string[] | null;
  after: string[];
  missing?: string;
}) {
  return (
    <div className={`merge-pane ${kind}`} data-pane={kind}>
      <div className="merge-pane-title">{title}</div>
      <div className="merge-pane-body">
        {before.map((l, i) => (
          <div key={`b${i}`} className="dl ctx">
            <span className="code">{l || " "}</span>
          </div>
        ))}
        {lines === null ? (
          <div className="dl merge-missing">
            <span className="code">{missing}</span>
          </div>
        ) : lines.length === 0 ? (
          <div className="dl merge-hunk empty">
            <span className="code">(nothing)</span>
          </div>
        ) : (
          lines.map((l, i) => (
            <div key={`h${i}`} className="dl merge-hunk">
              <span className="code">{l || " "}</span>
            </div>
          ))
        )}
        {after.map((l, i) => (
          <div key={`a${i}`} className="dl ctx">
            <span className="code">{l || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ConflictView() {
  const source = useStore((s) => s.diffSource);
  const repo = useStore((s) => s.repo);
  const run = useStore((s) => s.run);
  const close = useStore((s) => s.closeDiff);
  const path = source?.kind === "conflict" ? source.path : null;

  const [file, setFile] = useState<ConflictFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const editor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!repo || !path) return;
    let live = true;
    setFile(null);
    setError(null);
    setText(null);
    setCurrent(0);
    api
      .conflictFile(repo.path, path)
      .then((f) => {
        if (!live) return;
        setFile(f);
        setText(f.working);
        setTotal(f.working ? conflictsOf(f.working).length : 0);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, path]);

  const diff3 = useMemo(() => (file?.merged ? conflictsOf(file.merged) : []), [file]);
  const parsed = useMemo(() => (text != null ? parseConflicts(text) : null), [text]);
  const conflicts = parsed?.segments.filter((s): s is ConflictSegment => s.kind === "conflict") ?? [];
  const index = Math.min(current, Math.max(0, conflicts.length - 1));
  const c = conflicts[index];
  const base = c ? baseOf(c, diff3) : null;

  // Lines around the conflict at hand, from the result as it stands.
  const around = useMemo(() => {
    if (!c || text == null) return { before: [], after: [] };
    const lines = text.split("\n");
    return { before: lines.slice(Math.max(0, c.start - CONTEXT), c.start), after: lines.slice(c.end + 1, c.end + 1 + CONTEXT) };
  }, [c, text]);

  /** Select the conflict's block in the result, scrolled into view. */
  const show = (i: number, value = text) => {
    setCurrent(i);
    const ta = editor.current;
    const range = value != null ? conflictRange(value, i) : null;
    if (!ta || !range) return;
    ta.focus();
    ta.setSelectionRange(range[0], range[1]);
    const line = value!.slice(0, range[0]).split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 3);
  };

  const choose = (pick: Pick) => {
    if (text == null || !c) return;
    const lines = linesFor(c, base, pick);
    if (!lines) return;
    const next = replaceConflict(text, index, lines);
    setText(next);
    // The next conflict moves into this one's place.
    requestAnimationFrame(() => show(Math.min(index, conflictsOf(next).length - 1), next));
  };

  if (!path) return null;

  const takeSide = (side: "ours" | "theirs") =>
    run(`Taking ${side}`, (r) => api.resolveConflict(r, path, null, side), `Resolved ${path} with ${side}`);

  const save = async () => {
    if (text == null) return;
    if (conflicts.length) {
      const ok = await useStore.getState().confirm({
        title: "Conflict markers left",
        message: `${conflicts.length} conflict${conflicts.length === 1 ? " is" : "s are"} still marked in ${path}. Save it with the markers anyway?`,
        confirmLabel: "Save anyway",
        danger: true,
      });
      if (!ok) return;
    }
    await run("Saving resolution", (r) => api.resolveConflict(r, path, text, null), `Resolved ${path}`);
  };

  const ours = c?.oursLabel || "HEAD";
  const theirs = c?.theirsLabel || "incoming";
  const resolved = total - conflicts.length;

  return (
    <div className="diff-view conflict-view" data-testid="conflict">
      <div className="diff-header">
        <span className="status-badge s-conflicted">!</span>
        <span className="diff-path">{path}</span>
        <span className="dim diff-where">
          {total > 0
            ? conflicts.length
              ? `${resolved} of ${total} conflict${total === 1 ? "" : "s"} resolved`
              : "all conflicts resolved — save to mark it"
            : "conflicted"}
        </span>
        <span className="diff-header-actions">
          <button className="small-btn" onClick={() => takeSide("ours")} title="Keep the whole file from our side">
            Take ours
          </button>
          <button className="small-btn" onClick={() => takeSide("theirs")} title="Keep the whole file from their side">
            Take theirs
          </button>
          <button className="small-btn primary" disabled={text == null || file?.binary} onClick={() => void save()}>
            Save &amp; mark resolved
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      {error ? (
        <div className="diff-message">{error}</div>
      ) : !file ? (
        <div className="diff-message">Loading…</div>
      ) : file.binary ? (
        <div className="diff-message">Binary file — take ours or theirs.</div>
      ) : file.working == null ? (
        <div className="diff-message">The file was deleted on one side. Take ours or theirs.</div>
      ) : (
        <div className="merge-editor">
          {c ? (
            <>
              <div className="merge-nav">
                <button className="icon-btn" title="Previous conflict" disabled={index === 0} onClick={() => show(index - 1)}>
                  <IconChevron size={11} style={{ transform: "rotate(180deg)" }} />
                </button>
                <span>
                  Conflict {index + 1} of {conflicts.length}
                </span>
                <button
                  className="icon-btn"
                  title="Next conflict"
                  disabled={index >= conflicts.length - 1}
                  onClick={() => show(index + 1)}
                >
                  <IconChevron size={11} />
                </button>
                <span className="merge-nav-picks">
                  {PICKS.map((p) => (
                    <button
                      key={p.pick}
                      className="small-btn"
                      title={p.title}
                      disabled={p.pick === "base" && base === null}
                      onClick={() => choose(p.pick)}
                    >
                      {p.label}
                    </button>
                  ))}
                </span>
              </div>
              <div className="merge-panes">
                <Pane title={`Ours · ${ours}`} kind="ours" before={around.before} lines={c.ours} after={around.after} />
                <Pane
                  title="Base"
                  kind="base"
                  before={around.before}
                  lines={base}
                  after={around.after}
                  missing="(no common version)"
                />
                <Pane title={`Theirs · ${theirs}`} kind="theirs" before={around.before} lines={c.theirs} after={around.after} />
              </div>
            </>
          ) : (
            <div className="merge-nav done">No conflict markers left. Check the result, then save to mark the file resolved.</div>
          )}
          <div className="merge-result">
            <div className="merge-pane-title">Result — edit freely</div>
            <textarea
              ref={editor}
              aria-label="Result"
              className="merge-text"
              spellCheck={false}
              value={text ?? ""}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
