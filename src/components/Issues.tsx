// Issues: the sidebar section of the open repository's open issues, and
// the window showing one, with a button to start a branch for it.

import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactElement, ReactNode, useEffect, useState } from "react";

import { create } from "zustand";

import { api, errorText, Issue, IssueLabel, PrComment } from "../api";
import { copy } from "../actions";
import { relativeTime } from "../format";
import { issueLabel, issueOfBranch, loadIssues, sortIssues, startWork, useIssues, useIssueView } from "../issues";
import { MenuItem, useStore } from "../store";
import { IconFetch, IconIssue, IconPlus } from "./Icons";
import { Markdown } from "./Markdown";
import { CommentItem } from "./Threads";
import { LabelPicker } from "./EditRequest";

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
          <button className="icon-btn" title="New issue" onClick={() => useNewIssue.setState({ open: true })}>
            <IconPlus size={12} />
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
/** The issue's comments, a box to add one. */
function IssueConversation({ issue }: { issue: Issue }) {
  const repo = useStore((s) => s.repo?.path);
  const [comments, setComments] = useState<PrComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => {
    if (!repo) return;
    api.issueComments(repo, issue.remote, issue.number).then(setComments, (e) => setError(errorText(e)));
  };
  useEffect(() => {
    setComments(null);
    setError(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, issue.remote, issue.number]);
  const send = async () => {
    if (!repo || !draft.trim()) return;
    setBusy(true);
    try {
      await api.commentIssue(repo, issue.remote, issue.number, draft);
      setDraft("");
      load();
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="issue-conversation">
      {error && <div className="modal-error">{error}</div>}
      {!comments && !error && <div className="dim">Loading comments…</div>}
      {comments?.map((c) => <CommentItem key={c.id} c={c} url={issue.url} />)}
      <textarea
        rows={3}
        placeholder="Write a comment (Ctrl+Enter sends)"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
        }}
      />
      <div className="issue-comment-actions">
        <button type="button" className="small-btn" disabled={busy || !draft.trim()} onClick={() => void send()}>
          {busy ? "Sending…" : "Comment"}
        </button>
      </div>
    </div>
  );
}

async function closeIssue(issue: Issue) {
  const st = useStore.getState();
  const repo = st.repo?.path;
  if (!repo) return;
  if (!(await st.confirm({ title: `Close ${issueLabel(issue)}?`, message: issue.title, confirmLabel: "Close issue" }))) return;
  try {
    await api.setIssueOpen(repo, issue.remote, issue.number, false);
    st.toast("info", `Closed ${issueLabel(issue)}`);
    useIssueView.setState({ issue: null });
    void loadIssues(repo);
  } catch (e) {
    st.toast("error", errorText(e));
  }
}

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
          {issue.author} opened {when(issue.created)} · updated {when(issue.updated)} · {issue.project}
        </div>
        <Labels issue={issue} />
        {issue.assignees.length > 0 && (
          <div className="issue-meta">
            Assigned to <strong>{issue.assignees.join(", ")}</strong>
          </div>
        )}
        <div className="issue-scroll">
          <div className="issue-body">
            {issue.body.trim() ? <Markdown text={issue.body} html={issue.bodyHtml} url={issue.url} /> : <span className="dim">No description.</span>}
          </div>
          <IssueConversation issue={issue} />
        </div>
        {here && <div className="issue-meta">You're on {headBranch}, the branch for this issue.</div>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={() => void openUrl(issue.url)}>
            Open in browser
          </button>
          <button type="button" className="small-btn" onClick={() => copy(issue.url)}>
            Copy link
          </button>
          <button type="button" className="small-btn" onClick={() => void closeIssue(issue)}>
            Close issue
          </button>
          <span className="spacer" />
          <button type="button" className="small-btn" onClick={close}>
            Done
          </button>
          <button type="button" className="small-btn primary" onClick={() => void startWork(issue)}>
            Start work on a branch…
          </button>
        </div>
      </div>
    </div>
  );
}

export const useNewIssue = create<{ open: boolean }>(() => ({ open: false }));

/** A new issue on one of the repository's remotes. */
export function NewIssueDialog() {
  const open = useNewIssue((s) => s.open);
  const repo = useStore((s) => s.repo?.path);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remote, setRemote] = useState("origin");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState<string[]>([]);
  const [allLabels, setAllLabels] = useState<IssueLabel[]>([]);
  const [assignMe, setAssignMe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !repo) return;
    setTitle("");
    setBody("");
    setLabels([]);
    setError(null);
    api.remotes(repo).then((rs) => {
      const names = rs.map((r) => r.name);
      setRemotes(names);
      setRemote(names.includes("origin") ? "origin" : (names[0] ?? "origin"));
    }, () => {});
  }, [open, repo]);
  useEffect(() => {
    if (!open || !repo || !remote) return;
    let live = true;
    setAllLabels([]);
    api.projectLabels(repo, remote).then((ls) => live && setAllLabels(ls), () => {});
    return () => {
      live = false;
    };
  }, [open, repo, remote]);
  if (!open) return null;
  const close = () => useNewIssue.setState({ open: false });
  const create = async () => {
    if (!repo || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api.createIssue(repo, remote, { title, body, labels, assignMe });
      useStore.getState().toast("info", `Opened #${made.number}${made.warning ? ` (${made.warning})` : ""}`);
      close();
      void loadIssues(repo);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal wide create-pr"
        role="dialog"
        aria-label="New issue"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="modal-title">New issue</div>
        {remotes.length > 1 && (
          <select aria-label="Remote" value={remote} onChange={(e) => setRemote(e.target.value)} disabled={busy}>
            {remotes.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        )}
        <label className="modal-label">Title</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        <label className="modal-label">Description</label>
        <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What happens, what should" disabled={busy} />
        <label className="modal-label">Labels</label>
        <LabelPicker all={allLabels} chosen={labels} onChange={setLabels} disabled={busy} />
        <label className="checkbox">
          <input type="checkbox" checked={assignMe} onChange={(e) => setAssignMe(e.target.checked)} disabled={busy} />
          Assign it to me
        </label>
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={busy || !title.trim()}>
            {busy ? "Opening…" : "Open issue"}
          </button>
        </div>
      </form>
    </div>
  );
}
