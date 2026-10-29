// HEAD's reflog: everywhere HEAD has been, so commits lost to a reset,
// rebase or deleted branch can be found and brought back.

import { useEffect, useState } from "react";

import { api, errorText, ReflogEntry } from "../api";
import { checkoutDetached, createBranch } from "../actions";
import { fullTime, relativeTime, shortId } from "../format";
import { MenuItem, useStore } from "../store";
import { trackHead } from "../undo";
import { IconClose } from "./Icons";

const LIMIT = 500;

function entryMenu(e: ReflogEntry): MenuItem[] {
  const s = useStore.getState();
  const sid = shortId(e.id);
  return [
    { label: "Create branch here…", onSelect: () => createBranch(e.id, sid) },
    { label: "Check out this commit…", onSelect: () => checkoutDetached(e.id) },
    {
      label: `Move ${s.repo?.headBranch ?? "HEAD"} here (keep changes)`,
      onSelect: async () => {
        const ok = await s.confirm({
          title: "Reset to reflog entry",
          message: `Move ${s.repo?.headBranch ?? "HEAD"} to ${sid}? Local changes are kept (git reset --keep); Undo can move it back.`,
          confirmLabel: "Move branch",
        });
        if (ok) await trackHead(`reset to ${sid}`, () => s.run(`Resetting to ${sid}`, (r) => api.reset(r, e.id, "keep")));
      },
    },
    { separator: true, label: "" },
    { label: "Copy SHA", onSelect: () => navigator.clipboard?.writeText(e.id).then(() => s.toast("info", "Copied SHA")) },
  ];
}

export function ReflogView() {
  const repo = useStore((s) => s.repo);
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const showMenu = useStore((s) => s.showMenu);
  const close = useStore((s) => s.closeDiff);
  const [entries, setEntries] = useState<ReflogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    let live = true;
    api
      .reflog(repo.path, LIMIT)
      .then((e) => live && setEntries(e))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, repo?.headOid]);

  const inGraph = new Set(graph?.commits.map((c) => c.id));
  return (
    <div className="diff-view" data-testid="reflog">
      <div className="diff-header">
        <span className="view-kind">Reflog</span>
        <span className="dim diff-where">where HEAD has been — right-click to bring a commit back</span>
        <span className="diff-header-actions">
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="diff-body">
        {error && <div className="diff-message">{error}</div>}
        {!entries && !error && <div className="diff-message">Loading…</div>}
        {entries?.map((e) => (
          <div
            key={e.index}
            className={`reflog-row${selectedId === e.id ? " active" : ""}${inGraph.has(e.id) ? "" : " orphan"}`}
            onClick={() => select(e.id)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              select(e.id);
              showMenu(ev.clientX, ev.clientY, entryMenu(e));
            }}
            title={inGraph.has(e.id) ? fullTime(e.time) : `${fullTime(e.time)}\nNot reachable from any branch`}
          >
            <span className="reflog-ref">HEAD@{"{"}{e.index}{"}"}</span>
            <span className="sha-inline">{shortId(e.id)}</span>
            <span className="reflog-msg">{e.message}</span>
            <span className="reflog-summary dim">{e.summary ?? "(commit no longer exists)"}</span>
            <span className="reflog-time dim">{relativeTime(e.time)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
