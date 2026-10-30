// The toolbar's warning about other branches that clash with the work
// here, and the mark on changed files they touch too.

import { useState } from "react";

import { Overlap, PullRequest } from "../api";
import { relativeTime } from "../format";
import { clashesByPath, useOverlaps } from "../overlaps";
import { prLabel, usePrs } from "../prs";
import { useStore } from "../store";
import { IconAlert } from "./Icons";
import { Popover } from "./TitlebarItems";

const EMPTY: Overlap[] = [];
const NO_PRS: PullRequest[] = [];

function useList(): Overlap[] {
  const repo = useStore((s) => s.repo?.path);
  return useOverlaps((s) => (repo ? (s.byRepo[repo] ?? EMPTY) : EMPTY));
}

/** The open request whose source is this remote branch, if any. */
function requestOf(branch: string, prs: PullRequest[]): PullRequest | undefined {
  return prs.find((p) => p.sameRepo && `${p.remote}/${p.sourceBranch}` === branch);
}

function Files({ label, paths, kind }: { label: string; paths: string[]; kind: "conflict" | "edited" }) {
  if (!paths.length) return null;
  return (
    <div className={`overlap-files ${kind}`}>
      <span className="overlap-files-label">{label}</span>
      {paths.map((p) => (
        <span key={p} className="overlap-file" title={p}>
          {p}
        </span>
      ))}
    </div>
  );
}

export function OverlapButton() {
  const list = useList();
  const repo = useStore((s) => s.repo?.path);
  const prs = usePrs((s) => (repo ? (s.byRepo[repo]?.items ?? NO_PRS) : NO_PRS));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!list.length) return null;
  const conflicts = list.filter((o) => o.conflicts.length).length;
  const label = conflicts
    ? `Conflicts with ${conflicts} branch${conflicts === 1 ? "" : "es"}`
    : `${list.length} branch${list.length === 1 ? "" : "es"} changed your files`;
  return (
    <>
      <button
        className={`overlap-btn${conflicts ? " conflict" : ""}`}
        title="Other branches that clash with your work"
        aria-label="Clashing branches"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <IconAlert size={13} />
        {label}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="Clashing branches" align="left">
          <div className="title-popover-head">Branches that clash with your work</div>
          <div className="title-popover-body">
            {list.map((o) => {
              const pr = requestOf(o.branch, prs);
              return (
                <button
                  key={o.branch}
                  className="overlap-row"
                  title="Show the branch in the graph"
                  onClick={() => {
                    useStore.getState().select(o.target, true);
                    setAnchor(null);
                  }}
                >
                  <span className="overlap-row-head">
                    <strong>{o.branch}</strong>
                    {pr && <span className="pr-number">{prLabel(pr)}</span>}
                    <span className="dim">
                      {o.author} · {relativeTime(o.time)}
                    </span>
                  </span>
                  <Files label="Would conflict:" paths={o.conflicts} kind="conflict" />
                  <Files label="You're editing:" paths={o.edited} kind="edited" />
                </button>
              );
            })}
            <div className="overlap-note dim">
              Conflicts: merging the branch and yours now would stop on these files. Fetch to see the latest.
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** A mark for a changed file that other branches changed too. */
export function useClashMark() {
  const list = useList();
  const byPath = clashesByPath(list);
  return (path: string) => {
    const hits = byPath.get(path);
    if (!hits) return null;
    const conflict = hits.some((h) => h.conflict);
    const text = hits.map((h) => `${h.conflict ? "Would conflict with" : "Also changed on"} ${h.branch}`).join("\n");
    return (
      <span className={`clash-mark${conflict ? " conflict" : ""}`} title={text} aria-label={text}>
        <IconAlert size={11} />
      </span>
    );
  };
}
