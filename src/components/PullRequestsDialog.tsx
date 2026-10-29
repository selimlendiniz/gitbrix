// The requests involving the user on every account (asked to review,
// opened, assigned), whichever repository they belong to.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { PullRequest } from "../api";
import { approvePullRequest } from "../actions";
import { relativeTime } from "../format";
import { loadInbox, prKey, prLabel, usePrs, wantsReview } from "../prs";
import { IconFetch, IconPullRequest } from "./Icons";
import { useSettingsDialog } from "./SettingsDialog";

export const usePrDialog = create<{ open: boolean }>(() => ({ open: false }));

type Filter = "review" | "mine" | "assigned" | "all";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "review", label: "To review" },
  { value: "mine", label: "Mine" },
  { value: "assigned", label: "Assigned" },
  { value: "all", label: "All" },
];

function matches(pr: PullRequest, filter: Filter): boolean {
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

/** Toolbar button; the badge counts requests waiting for the user's approval. */
export function PullRequestsButton() {
  const waiting = usePrs((s) => s.inbox?.items.filter(wantsReview).length ?? 0);
  return (
    <button
      className="icon-btn pr-button"
      title={waiting ? `Pull requests: ${waiting} waiting for your approval` : "Pull requests"}
      onClick={() => usePrDialog.setState({ open: true })}
    >
      <IconPullRequest size={15} />
      {waiting > 0 && <span className="pr-button-count">{waiting}</span>}
    </button>
  );
}

function Row({ pr }: { pr: PullRequest }) {
  const path = pr.project.slice(pr.project.indexOf("/") + 1);
  const created = Date.parse(pr.created) / 1000;
  return (
    <div className="pr-row" onClick={() => void openUrl(pr.url)} title={`Open ${pr.url}`}>
      <div className="pr-row-main">
        <span className="pr-number">{prLabel(pr)}</span>
        <span className="pr-title">{pr.title}</span>
        {pr.draft && <span className="pr-badge">draft</span>}
        {wantsReview(pr) && <span className="pr-badge review">{pr.reviewRequested ? "review" : "approve"}</span>}
        {pr.approved && <span className="pr-badge ok">approved</span>}
        {!pr.approved && pr.approvedByMe && <span className="pr-badge ok">you approved</span>}
      </div>
      <div className="pr-row-meta">
        <span className="pr-project">{path}</span>
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
  const inbox = usePrs((s) => s.inbox);
  const [filter, setFilter] = useState<Filter | null>(null);
  useEffect(() => {
    if (open) void loadInbox();
    else setFilter(null);
  }, [open]);
  if (!open) return null;
  const close = () => usePrDialog.setState({ open: false });

  const items = inbox?.items ?? [];
  const count = (f: Filter) => items.filter((p) => matches(p, f)).length;
  // Start on what needs the user, if anything does.
  const current = filter ?? (count("review") ? "review" : "all");
  const shown = items.filter((p) => matches(p, current));
  const noAccounts = inbox && !inbox.loading && !inbox.accounts.length && !inbox.problems.length && !inbox.error;

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
          <span className="modal-title">Pull requests</span>
          <span className="segmented">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" className={current === f.value ? "on" : ""} onClick={() => setFilter(f.value)}>
                {f.label} <span className="side-count">{count(f.value)}</span>
              </button>
            ))}
          </span>
          <button
            type="button"
            className={`icon-btn${inbox?.loading ? " spinning" : ""}`}
            title="Check again"
            onClick={() => void loadInbox()}
          >
            <IconFetch size={13} />
          </button>
        </div>
        {noAccounts ? (
          <div className="pr-empty">
            Add a GitHub or GitLab account to see the pull requests you are involved in.{" "}
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
              <Row key={prKey(pr)} pr={pr} />
            ))}
            {inbox && !inbox.loading && !shown.length && <div className="pr-empty">Nothing here</div>}
            {!inbox && <div className="pr-empty">Loading…</div>}
          </div>
        )}
        {[...(inbox?.error ? [inbox.error] : []), ...(inbox?.problems ?? [])].map((p) => (
          <p key={p} className="modal-error">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
}
