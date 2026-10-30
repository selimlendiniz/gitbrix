// Details panel while three or more commits are selected (Ctrl/Shift+click).

import { useMemo } from "react";

import { cherryPickMany, copyPatch, revertMany, savePatch, squashCommits } from "../actions";
import { relativeTime, shortId } from "../format";
import { useStore } from "../store";

export function MultiPanel() {
  const multi = useStore((s) => s.multi);
  const graph = useStore((s) => s.graph);
  const repo = useStore((s) => s.repo);
  const select = useStore((s) => s.select);
  const commits = useMemo(() => (graph?.commits ?? []).filter((c) => multi.includes(c.id)), [graph, multi]);
  const oldestFirst = [...commits].reverse().map((c) => c.id);
  const merges = commits.filter((c) => c.parents.length > 1).length;
  const head = repo?.headBranch ?? "HEAD";

  return (
    <div className="commit-panel" data-testid="multi">
      <div className="commit-head">
        <div className="stash-kicker">{commits.length} commits selected</div>
        <div className="dim multi-hint">Ctrl+click adds or removes one, Shift+click selects a range.</div>
        <div className="stash-actions">
          <button className="small-btn" disabled={merges > 0} title={merges ? "Merge commits can't be cherry-picked" : undefined} onClick={() => void cherryPickMany(multi)}>
            Cherry-pick onto {head}…
          </button>
          <button className="small-btn" disabled={merges > 0} onClick={() => void revertMany(multi)}>
            Revert…
          </button>
          <button className="small-btn" disabled={merges > 0} onClick={() => void squashCommits(multi)}>
            Squash into one…
          </button>
        </div>
        <div className="stash-actions">
          <button className="small-btn" onClick={() => void savePatch(oldestFirst, null, `${commits.length}-commits.patch`)}>
            Save as patch…
          </button>
          <button className="small-btn" onClick={() => void copyPatch(oldestFirst, null)}>
            Copy as patch
          </button>
          <button className="small-btn" onClick={() => select(useStore.getState().selectedId)}>
            Clear selection
          </button>
        </div>
      </div>
      <div className="multi-list">
        {commits.map((c) => (
          <div key={c.id} className="multi-row" onClick={() => select(c.id, true)} title="Show this commit alone">
            <span className="sha-inline">{shortId(c.id)}</span>
            <span className="multi-summary">{c.summary}</span>
            <span className="dim multi-meta">
              {c.authorName} · {relativeTime(c.time)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
