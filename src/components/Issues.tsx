// Issues: the sidebar section of the open repository's open issues, and
// the window showing one, with a button to start a branch for it.

import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactElement, ReactNode, useEffect, useState } from "react";

import { Issue } from "../api";
import { copy } from "../actions";
import { relativeTime } from "../format";
import { issueLabel, issueOfBranch, loadIssues, sortIssues, startWork, useIssues, useIssueView } from "../issues";
import { MenuItem, useStore } from "../store";
import { IconFetch, IconIssue } from "./Icons";
import { Markdown } from "./Markdown";

const when = (iso: string) => {
  const t = Date.parse(iso) / 1000;
  return Number.isNaN(t) ? "" : relativeTime(t);
};

export function issueMenu(issue: Issue): MenuItem[] {
  return [
    { label: "Start work on a branch…", onSelect: () => void startWork(issue) },
    { label: "Open in browser", onSelect: () => void openUrl(issue.url) },
    { separator: true, label: "" },
    { label: "Copy link", onSelect: () => copy(issue.url) },
    { label: `Copy "Closes ${issueLabel(issue)}"`, onSelect: () => copy(`Closes ${issueLabel(issue)}`) },
  ];
}

function Labels({ issue }: { issue: Issue }) {
  if (!issue.labels.length) return null;
  return (
    <span className="issue-labels">
      {issue.labels.map((l) => (
        <span key={l.name} className="issue-label" style={l.color ? { borderColor: l.color } : undefined}>
          {l.color && <span className="issue-label-dot" style={{ background: l.color }} />}
          {l.name}
        </span>
      ))}
    </span>
  );
}

/** The sidebar's open issues. `Section` comes from the sidebar, so this
 * looks like the other sections. */
export function IssueList({
  Section,
}: {
  Section: (p: { title: string; icon: ReactNode; count: number; children: ReactNode; action?: ReactNode }) => ReactElement;
}) {
  const repoPath = useStore((s) => s.repo?.path);
  const data = useIssues((s) => (repoPath ? s.byRepo[repoPath] : undefined));
  const showMenu = useStore((s) => s.showMenu);
  const headBranch = useStore((s) => s.repo?.headBranch);
  const [mine, setMine] = useState(false);
  const shown = useIssueView((s) => s.issue);
  if (!repoPath || !data || (!data.covered && !data.problems.length && !data.error)) return null;
  const notes = [...(data.error ? [data.error] : []), ...data.problems];
  const items = sortIssues(data.items).filter((i) => !mine || i.assignedToMe);
  const current = issueOfBranch(headBranch);
  return (
    <Section
      title="Issues"
      icon={<IconIssue size={13} />}
      count={items.length}
      action={
        <>
          <button
            className={`icon-btn text-btn${mine ? " on" : ""}`}
            title={mine ? "Showing issues assigned to you" : "Show only issues assigned to you"}
            aria-pressed={mine}
            onClick={() => setMine(!mine)}
          >
            mine
          </button>
          <button className={`icon-btn${data.loading ? " spinning" : ""}`} title="Check for issues" onClick={() => void loadIssues(repoPath)}>
            <IconFetch size={12} />
          </button>
        </>
      }
    >
      {items.map((issue) => (
        <div
          key={`${issue.project}#${issue.number}`}
          className={`side-item issue-item${shown?.project === issue.project && shown.number === issue.number ? " selected" : ""}`}
          style={{ paddingLeft: 24 }}
          title={`${issue.title}\n${issue.author}${issue.labels.length ? ` · ${issue.labels.map((l) => l.name).join(", ")}` : ""}\nClick for details, double-click to start work, right-click for more`}
          onClick={() => useIssueView.setState({ issue })}
          onDoubleClick={() => void startWork(issue)}
          onContextMenu={(e) => {
            e.preventDefault();
            showMenu(e.clientX, e.clientY, issueMenu(issue));
          }}
        >
          <span className="pr-number">{issueLabel(issue)}</span>
          <span className="side-item-label">{issue.title}</span>
          {issue.labels.slice(0, 3).map((l) => (
            <span key={l.name} className="issue-label-dot" title={l.name} style={{ background: l.color || "var(--text-dim)" }} />
          ))}
          {current === issue.number && <span className="pr-badge ok" title="The checked-out branch is for this issue">here</span>}
          {issue.assignedToMe && <span className="pr-badge review">you</span>}
        </div>
      ))}
      {data.covered && !items.length && !notes.length && (
        <div className="side-note">{mine ? "None assigned to you" : "No open issues"}</div>
      )}
      {notes.map((n) => (
        <div key={n} className="side-note error" title={n}>
          {n}
        </div>
      ))}
    </Section>
  );
}

/** One issue: what it says, and what to do with it. */
export function IssueDialog() {
  const issue = useIssueView((s) => s.issue);
  const headBranch = useStore((s) => s.repo?.headBranch);
  const repoPath = useStore((s) => s.repo?.path);
  // Another repository: not its issue any more.
  useEffect(() => {
    useIssueView.setState({ issue: null });
  }, [repoPath]);
  if (!issue) return null;
  const close = () => useIssueView.setState({ issue: null });
  const here = issueOfBranch(headBranch) === issue.number;
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide issue-modal"
        role="dialog"
        aria-label={`Issue ${issueLabel(issue)}`}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="modal-title">
          <span className="pr-number">{issueLabel(issue)}</span> {issue.title}
        </div>
        <div className="issue-meta dim">
          {issue.author} opened {when(issue.created)} · updated {when(issue.updated)} · {issue.comments} comment
          {issue.comments === 1 ? "" : "s"} · {issue.project}
        </div>
        <Labels issue={issue} />
        {issue.assignees.length > 0 && (
          <div className="issue-meta">
            Assigned to <strong>{issue.assignees.join(", ")}</strong>
          </div>
        )}
        <div className="issue-body">
          {issue.body.trim() ? <Markdown text={issue.body} url={issue.url} /> : <span className="dim">No description.</span>}
        </div>
        {here && <div className="issue-meta">You're on {headBranch}, the branch for this issue.</div>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={() => void openUrl(issue.url)}>
            Open in browser
          </button>
          <button type="button" className="small-btn" onClick={() => copy(issue.url)}>
            Copy link
          </button>
          <span className="spacer" />
          <button type="button" className="small-btn" onClick={close}>
            Close
          </button>
          <button type="button" className="small-btn primary" onClick={() => void startWork(issue)} autoFocus>
            Start work on a branch…
          </button>
        </div>
      </div>
    </div>
  );
}
