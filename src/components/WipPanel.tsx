import { useState } from "react";
import { create } from "zustand";

import { api } from "../api";
import { discardAll, discardFiles, fileItems, ignoreItems, stashSave } from "../actions";
import { useStore } from "../store";
import { describe, trackHead } from "../undo";
import { FileList, FileRow } from "./FileList";
import { IconMinus, IconPlus, IconTrash } from "./Icons";

// The commit message survives switching to another commit and back.
const useDraft = create<{ summary: string; body: string; amend: boolean }>(() => ({
  summary: "",
  body: "",
  amend: false,
}));

const SUMMARY_SOFT_LIMIT = 72;

export function WipPanel() {
  const repo = useStore((s) => s.repo)!;
  const status = useStore((s) => s.status);
  const diffSource = useStore((s) => s.diffSource);
  const openDiff = useStore((s) => s.openDiff);
  const run = useStore((s) => s.run);
  const showMenu = useStore((s) => s.showMenu);
  const busy = useStore((s) => s.busy);
  const { summary, body, amend } = useDraft();
  const [committing, setCommitting] = useState(false);

  if (!status) return <div className="panel-loading">Loading changes…</div>;

  const unstaged: FileRow[] = [...status.conflicted, ...status.unstaged];
  const staged: FileRow[] = status.staged;
  const active = diffSource?.kind === "wip" ? diffSource : null;

  const stage = (paths: string[]) => run("Staging", (r) => api.stage(r, paths), undefined, "status");
  const unstage = (paths: string[]) => run("Unstaging", (r) => api.unstage(r, paths), undefined, "status");

  async function toggleAmend(on: boolean) {
    useDraft.setState({ amend: on });
    if (on && !summary.trim() && !body.trim()) {
      try {
        const msg = await api.headMessage(repo.path);
        const [s, ...rest] = msg.split("\n");
        useDraft.setState({ summary: s, body: rest.join("\n").trim() });
      } catch {
        // No HEAD commit to amend; the checkbox stays but commit will fail with a clear error.
      }
    }
  }

  async function commit() {
    const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}\n` : `${summary.trim()}\n`;
    setCommitting(true);
    const ok = await trackHead(amend ? "amend" : describe.commit(summary.trim()), () =>
      run(amend ? "Amending" : "Committing", (r) => api.commit(r, message, amend), amend ? "Commit amended" : "Committed"),
    );
    setCommitting(false);
    if (ok) useDraft.setState({ summary: "", body: "", amend: false });
  }

  const canCommit = !!summary.trim() && (staged.length > 0 || amend) && !busy && status.conflicted.length === 0;

  return (
    <div className="wip-panel">

      <div className="wip-section">
        <div className="panel-subhead">
          <span>Unstaged files ({unstaged.length})</span>
          <span className="subhead-actions">
            {unstaged.length > 0 && (
              <>
                {status.unstaged.length > 0 && (
                  <button className="link-btn danger" onClick={() => discardAll(status.unstaged.map((e) => e.path))}>
                    Discard all
                  </button>
                )}
                <button className="link-btn" onClick={() => stashSave()}>
                  Stash
                </button>
                <button className="small-btn" onClick={() => run("Staging", (r) => api.stageAll(r), undefined, "status")}>
                  Stage all
                </button>
              </>
            )}
          </span>
        </div>
        <FileList
          files={unstaged}
          empty="No unstaged changes"
          activePath={active && !active.staged ? active.path : diffSource?.kind === "conflict" ? diffSource.path : null}
          onOpen={(f) =>
            openDiff(f.status === "conflicted" ? { kind: "conflict", path: f.path } : { kind: "wip", path: f.path, staged: false })
          }
          onActivate={(f) => f.status !== "conflicted" && stage([f.path])}
          onMenu={(f, x, y) =>
            showMenu(x, y, [
              { label: "Stage file", onSelect: () => stage([f.path]) },
              { label: "Discard changes…", danger: true, disabled: f.status === "conflicted", onSelect: () => discardFiles([f.path]) },
              { separator: true, label: "" },
              { label: "File history", disabled: f.status === "untracked", onSelect: () => openDiff({ kind: "history", path: f.path }) },
              { label: "Blame", disabled: f.status === "untracked" || f.status === "deleted", onSelect: () => openDiff({ kind: "blame", path: f.path, rev: null }) },
              ...(f.status === "untracked" ? [{ separator: true, label: "" }, ...ignoreItems(f.path)] : []),
              { separator: true, label: "" },
              ...fileItems(f.path, f.status === "deleted"),
            ])
          }
          actions={(f) => (
            <>
              {f.status !== "conflicted" && (
                <button className="icon-btn danger" title="Discard changes" onClick={() => discardFiles([f.path])}>
                  <IconTrash size={12} />
                </button>
              )}
              <button className="icon-btn stage" title={f.status === "conflicted" ? "Mark resolved" : "Stage file"} onClick={() => stage([f.path])}>
                <IconPlus size={12} />
              </button>
            </>
          )}
        />
      </div>

      <div className="wip-section">
        <div className="panel-subhead">
          <span>Staged files ({staged.length})</span>
          {staged.length > 0 && (
            <button className="small-btn" onClick={() => run("Unstaging", (r) => api.unstageAll(r), undefined, "status")}>
              Unstage all
            </button>
          )}
        </div>
        <FileList
          files={staged}
          empty="Nothing staged yet"
          activePath={active?.staged ? active.path : null}
          onOpen={(f) => openDiff({ kind: "wip", path: f.path, staged: true })}
          onActivate={(f) => unstage(f.oldPath ? [f.path, f.oldPath] : [f.path])}
          onMenu={(f, x, y) => showMenu(x, y, [{ label: "Unstage file", onSelect: () => unstage(f.oldPath ? [f.path, f.oldPath] : [f.path]) }])}
          actions={(f) => (
            <button className="icon-btn unstage" title="Unstage file" onClick={() => unstage(f.oldPath ? [f.path, f.oldPath] : [f.path])}>
              <IconMinus size={12} />
            </button>
          )}
        />
      </div>

      <div className="commit-form">
        <div className="commit-form-head">
          <span>Commit</span>
          <label className="checkbox">
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} disabled={repo.unborn} />
            Amend previous commit
          </label>
        </div>
        <div className="summary-wrap">
          <input
            className="commit-summary-input"
            placeholder="Summary (required)"
            value={summary}
            onChange={(e) => useDraft.setState({ summary: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) commit();
            }}
          />
          <span className={`summary-count${summary.length > SUMMARY_SOFT_LIMIT ? " over" : ""}`}>
            {SUMMARY_SOFT_LIMIT - summary.length}
          </span>
        </div>
        <textarea
          className="commit-body-input"
          placeholder="Description"
          value={body}
          rows={4}
          onChange={(e) => useDraft.setState({ body: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit) commit();
          }}
        />
        <button className="primary-btn" disabled={!canCommit || committing} onClick={commit} title="Ctrl+Enter">
          {amend
            ? "Amend previous commit"
            : staged.length > 0
              ? `Commit changes to ${staged.length} file${staged.length === 1 ? "" : "s"}`
              : "Stage files to commit"}
        </button>
      </div>
    </div>
  );
}
