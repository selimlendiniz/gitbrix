import { useEffect, useState } from "react";

import { api, errorText, FileChange } from "../api";
import { shortId } from "../format";
import { savePatch } from "../actions";
import { useStore } from "../store";
import { FileList } from "./FileList";

/** Details panel while two commits are selected (Ctrl/Shift+click). */
export function ComparePanel() {
  const repo = useStore((s) => s.repo);
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const compareId = useStore((s) => s.compareId);
  const diffSource = useStore((s) => s.diffSource);
  const openDiff = useStore((s) => s.openDiff);
  const setCompare = useStore((s) => s.setCompare);
  const [swapped, setSwapped] = useState(false);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Default direction: older → newer (lower in the graph is older).
  const commits = graph?.commits ?? [];
  const ia = commits.findIndex((c) => c.id === selectedId);
  const ib = commits.findIndex((c) => c.id === compareId);
  const [older, newer] = ia > ib ? [selectedId!, compareId!] : [compareId!, selectedId!];
  const [from, to] = swapped ? [newer, older] : [older, newer];

  useEffect(() => {
    if (!repo || !from || !to) return;
    let live = true;
    setFiles(null);
    setError(null);
    api
      .compareCommits(repo.path, from, to)
      .then((f) => live && setFiles(f))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, from, to]);

  const summary = (id: string) => commits.find((c) => c.id === id)?.summary ?? "";
  const adds = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;

  return (
    <div className="commit-panel" data-testid="compare">
      <div className="commit-head">
        <div className="stash-kicker">Comparing</div>
        <div className="compare-ends">
          <div>
            <span className="sha-inline">{shortId(from)}</span>
            {summary(from)}
          </div>
          <div className="compare-arrow">↓</div>
          <div>
            <span className="sha-inline">{shortId(to)}</span>
            {summary(to)}
          </div>
        </div>
        <div className="stash-actions">
          <button className="small-btn" onClick={() => setSwapped(!swapped)}>
            Swap direction
          </button>
          <button
            className="small-btn"
            title="The commits after the older one, up to the newer, as one patch file"
            onClick={() => void savePatch([newer], older, `${shortId(older)}..${shortId(newer)}.patch`)}
          >
            Save as patch…
          </button>
          <button className="small-btn" onClick={() => setCompare(null)}>
            Stop comparing
          </button>
        </div>
      </div>
      <div className="panel-subhead">
        <span>{files ? `${files.length} file${files.length === 1 ? "" : "s"} changed` : "Loading…"}</span>
        {files && (
          <span className="file-stat">
            <span className="add">+{adds}</span> <span className="del">−{dels}</span>
          </span>
        )}
      </div>
      {error && <div className="files-empty">{error}</div>}
      {files && (
        <FileList
          files={files}
          empty="No differences"
          activePath={diffSource?.kind === "compare" ? diffSource.path : null}
          onOpen={(f) => openDiff({ kind: "compare", from, to, path: f.path, oldPath: f.oldPath })}
        />
      )}
    </div>
  );
}
