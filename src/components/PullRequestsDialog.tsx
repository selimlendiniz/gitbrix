// The open repository's pull/merge requests, by involvement (to review,
// mine, assigned, all). The Workspaces tab lists those of every repository
// in a workspace with the same rows.

import { ReactNode, useEffect, useState } from "react";
import { create } from "zustand";

import { PullRequest } from "../api";
import { approvePullRequest } from "../actions";
import { relativeTime } from "../format";
import { loadPrs, openPullRequest, prKey, prLabel, usePrs, wantsReview } from "../prs";
import { useStore } from "../store";
import { CiMark } from "./CiMark";
import { IconFetch, IconPullRequest } from "./Icons";
import { useSettingsDialog } from "./SettingsDialog";

export const usePrDialog = create<{ open: boolean }>(() => ({ open: false }));

export type PrFilter = "review" | "mine" | "assigned" | "all";

const PR_FILTERS: { value: PrFilter; label: string }[] = [
  { value: "review", label: "To review" },
  { value: "mine", label: "Mine" },
  { value: "assigned", label: "Assigned" },
  { value: "all", label: "All" },
];

export function matchesFilter(pr: PullRequest, filter: PrFilter): boolean {
  switch (filter) {
    case "review":
      return !pr.mine && (pr.reviewRequested || wantsReview(pr));
    case "mine":
      return pr.mine;
    case "assigned":
      return pr.assigned;
    case "all":
      return true;
  }
}

/** Start on what needs the user, if anything does. */
export function defaultFilter(items: PullRequest[]): PrFilter {
  return items.some((p) => matchesFilter(p, "review")) ? "review" : "all";
}

/** Filter buttons, each with its count. */
export function PrFilters({ items, filter, onChange }: { items: PullRequest[]; filter: PrFilter; onChange: (f: PrFilter) => void }) {
  return (
    <span className="segmented">
      {PR_FILTERS.map((f) => (
        <button key={f.value} type="button" className={filter === f.value ? "on" : ""} onClick={() => onChange(f.value)}>
          {f.label} <span className="side-count">{items.filter((p) => matchesFilter(p, f.value)).length}</span>
        </button>
      ))}
    </span>
  );
}

/** Toolbar button with the open repository's request count; it stands out
 * more while some wait for the user's approval. */
export function PullRequestsButton() {
  const repo = useStore((s) => s.repo?.path);
  const items = usePrs((s) => (repo ? s.byRepo[repo]?.items : undefined)) ?? [];
  const total = items.length;
  const waiting = items.filter(wantsReview).length;
  const title = total
    ? `Pull requests: ${total} open${waiting ? `, ${waiting} waiting for your approval` : ""}`
    : "Pull requests";
  return (
    <button
      className={`pr-button${total ? " has" : ""}${waiting ? " waiting" : ""}`}
      title={title}
      onClick={() => usePrDialog.setState({ open: true })}
    >
      <IconPullRequest size={15} />
      {total > 0 && <span className="pr-button-count">{waiting || total}</span>}
    </button>
  );
}

/** One request: number, title, badges, where, author, branches, age. */
export function PrRow({ pr, where, onOpen }: { pr: PullRequest; where?: ReactNode; onOpen: () => void }) {
  const created = Date.parse(pr.created) / 1000;
  return (
    <div className="pr-row" onClick={onOpen} title="Review in gitbrix">
      <div className="pr-row-main">
        <span className="pr-number">{prLabel(pr)}</span>
        <span className="pr-title">{pr.title}</span>
        {pr.ci && <CiMark state={pr.ci} />}
        {pr.draft && <span className="pr-badge">draft</span>}
        {wantsReview(pr) && <span className="pr-badge review">{pr.reviewRequested ? "review" : "approve"}</span>}
        {pr.approved && <span className="pr-badge ok">approved</span>}
        {!pr.approved && pr.approvedByMe && <span className="pr-badge ok">you approved</span>}
      </div>
      <div className="pr-row-meta">
        {where && <span className="pr-project">{where}</span>}
        <span>{pr.author}</span>
        <span className="pr-branches">
          {pr.sourceBranch} → {pr.targetBranch}
        </span>
        {!Number.isNaN(created) && <span>{relativeTime(created)}</span>}
      </div>
      {pr.canApprove && !pr.approvedByMe && (
        <button
          type="button"
          className="small-btn pr-approve"
          onClick={(e) => {
            e.stopPropagation();
            void approvePullRequest(pr);
          }}
        >
          Approve…
        </button>
      )}
    </div>
  );
}

export function PullRequestsDialog() {
  const open = usePrDialog((s) => s.open);
  const repo = useStore((s) => s.repo);
  const data = usePrs((s) => (repo ? s.byRepo[repo.path] : undefined));
  const [filter, setFilter] = useState<PrFilter | null>(null);
  useEffect(() => {
    if (open && repo) void loadPrs(repo.path);
    else setFilter(null);
  }, [open, repo?.path]);
  if (!open || !repo) return null;
  const close = () => usePrDialog.setState({ open: false });

  const items = data?.items ?? [];
  const current = filter ?? defaultFilter(items);
  const shown = items.filter((p) => matchesFilter(p, current));
  const uncovered = data && !data.loading && !data.covered && !data.problems.length && !data.error;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide pr-dialog"
        role="dialog"
        aria-label="Pull requests"
        tabIndex={-1}
        ref={(e) => {
          if (e && !e.contains(document.activeElement)) e.focus();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="pr-dialog-head">
          <span className="modal-title">Pull requests · {repo.name}</span>
          <PrFilters items={items} filter={current} onChange={setFilter} />
          <button
            type="button"
            className={`icon-btn${data?.loading ? " spinning" : ""}`}
            title="Check again"
            onClick={() => void loadPrs(repo.path)}
          >
            <IconFetch size={13} />
          </button>
        </div>
        {uncovered ? (
          <div className="pr-empty">
            No GitHub or GitLab account covers this repository's remotes.{" "}
            <button
              type="button"
              className="small-btn"
              onClick={() => {
                close();
                useSettingsDialog.setState({ open: true });
              }}
            >
              Open Settings
            </button>
          </div>
        ) : (
          <div className="pr-list">
            {shown.map((pr) => (
              <PrRow
                key={prKey(pr)}
                pr={pr}
                onOpen={() => {
                  close();
                  openPullRequest(pr);
                }}
              />
            ))}
            {data && !data.loading && !shown.length && <div className="pr-empty">Nothing here</div>}
            {!data && <div className="pr-empty">Loading…</div>}
          </div>
        )}
        {[...(data?.error ? [data.error] : []), ...(data?.problems ?? [])].map((p) => (
          <p key={p} className="modal-error">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}
