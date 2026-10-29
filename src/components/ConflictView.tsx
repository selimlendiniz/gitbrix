import { useEffect, useMemo, useState } from "react";

import { api, ConflictFile, errorText } from "../api";
import { Choice, ConflictSegment, parseConflicts, resolve, resolvedLines } from "../diff/conflicts";
import { useStore } from "../store";
import { IconClose } from "./Icons";

const CHOICES: { choice: Choice; label: string }[] = [
  { choice: "ours", label: "Ours" },
  { choice: "theirs", label: "Theirs" },
  { choice: "ours-theirs", label: "Both" },
  { choice: "theirs-ours", label: "Both, theirs first" },
];

export function ConflictView() {
  const source = useStore((s) => s.diffSource);
  const repo = useStore((s) => s.repo);
  const run = useStore((s) => s.run);
  const close = useStore((s) => s.closeDiff);
  const path = source?.kind === "conflict" ? source.path : null;

  const [file, setFile] = useState<ConflictFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<(Choice | undefined)[]>([]);

  useEffect(() => {
    if (!repo || !path) return;
    let live = true;
    setFile(null);
    setError(null);
    setChoices([]);
    api
      .conflictFile(repo.path, path)
      .then((f) => live && setFile(f))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, path]);

  const parsed = useMemo(() => (file?.working != null ? parseConflicts(file.working) : null), [file]);
  const conflicts = parsed?.segments.filter((s): s is ConflictSegment => s.kind === "conflict") ?? [];
  const result = parsed ? resolve(parsed, choices) : null;
  const done = choices.filter(Boolean).length;
  const labels = conflicts[0] ? { ours: conflicts[0].oursLabel || "ours", theirs: conflicts[0].theirsLabel || "theirs" } : { ours: "ours", theirs: "theirs" };

  if (!path) return null;

  const takeSide = (side: "ours" | "theirs") =>
    run(`Taking ${side}`, (r) => api.resolveConflict(r, path, null, side), `Resolved ${path} with ${side}`);

  const save = () => {
    if (result === null) return;
    return run("Saving resolution", (r) => api.resolveConflict(r, path, result, null), `Resolved ${path}`);
  };

  return (
    <div className="diff-view conflict-view" data-testid="conflict">
      <div className="diff-header">
        <span className="status-badge s-conflicted">!</span>
        <span className="diff-path">{path}</span>
        <span className="dim diff-where">
          {conflicts.length > 0 ? `${done} of ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} resolved` : "conflicted"}
        </span>
        <span className="diff-header-actions">
          <button className="small-btn" onClick={() => takeSide("ours")} title={`Keep the whole file from ${labels.ours}`}>
            Take ours
          </button>
          <button className="small-btn" onClick={() => takeSide("theirs")} title={`Keep the whole file from ${labels.theirs}`}>
            Take theirs
          </button>
          <button className="small-btn primary" disabled={result === null || conflicts.length === 0} onClick={save}>
            Save &amp; mark resolved
          </button>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="diff-body">
        {error ? (
          <div className="diff-message">{error}</div>
        ) : !file || !parsed ? (
          <div className="diff-message">{file && file.working == null ? "The file was deleted on one side. Take ours or theirs." : "Loading…"}</div>
        ) : file.binary ? (
          <div className="diff-message">Binary file — take ours or theirs.</div>
        ) : conflicts.length === 0 ? (
          <div className="diff-message">
            No conflict markers left in the file. If it looks right, stage it from the file list to mark it resolved.
          </div>
        ) : (
          <div className="diff-table conflict-table">
            {(() => {
              let n = -1;
              return parsed.segments.map((s, i) => {
                if (s.kind === "text") {
                  return (
                    <div key={i} className="conflict-text">
                      {s.lines.map((l, j) => (
                        <div key={j} className="dl ctx">
                          <span className="code">{l || " "}</span>
                        </div>
                      ))}
                    </div>
                  );
                }
                const idx = ++n;
                const choice = choices[idx];
                return (
                  <ConflictBlock
                    key={i}
                    c={s}
                    index={idx}
                    choice={choice}
                    onChoose={(c) =>
                      setChoices((cur) => {
                        const next = [...cur];
                        next[idx] = c;
                        return next;
                      })
                    }
                  />
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function ConflictBlock({
  c,
  index,
  choice,
  onChoose,
}: {
  c: ConflictSegment;
  index: number;
  choice: Choice | undefined;
  onChoose: (c: Choice | undefined) => void;
}) {
  return (
    <div className={`conflict-block${choice ? " chosen" : ""}`} data-conflict={index}>
      <div className="conflict-bar">
        <span>Conflict {index + 1}</span>
        <span className="conflict-choices">
          {CHOICES.map((o) => (
            <button key={o.choice} className={`small-btn${choice === o.choice ? " primary" : ""}`} onClick={() => onChoose(o.choice)}>
              {o.label}
            </button>
          ))}
          {choice && (
            <button className="link-btn" onClick={() => onChoose(undefined)}>
              Undo
            </button>
          )}
        </span>
      </div>
      {choice ? (
        <div className="conflict-result">
          {resolvedLines(c, choice).map((l, j) => (
            <div key={j} className="dl add">
              <span className="code">{l || " "}</span>
            </div>
          ))}
          {resolvedLines(c, choice).length === 0 && <div className="dl ctx dim"><span className="code">(empty)</span></div>}
        </div>
      ) : (
        <div className="conflict-sides">
          <Side title={`Ours · ${c.oursLabel || "HEAD"}`} lines={c.ours} kind="ours" />
          <Side title={`Theirs · ${c.theirsLabel || "incoming"}`} lines={c.theirs} kind="theirs" />
        </div>
      )}
    </div>
  );
}

function Side({ title, lines, kind }: { title: string; lines: string[]; kind: "ours" | "theirs" }) {
  return (
    <div className={`conflict-side ${kind}`}>
      <div className="conflict-side-title">{title}</div>
      {lines.map((l, j) => (
        <div key={j} className="dl">
          <span className="code">{l || " "}</span>
        </div>
      ))}
      {lines.length === 0 && <div className="dl dim"><span className="code">(nothing)</span></div>}
    </div>
  );
}
