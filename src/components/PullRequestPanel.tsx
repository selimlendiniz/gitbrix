// Details panel for a pull/merge request reviewed in the app: its changes
// (fetched and diffed locally), the conversation, comment, approve, merge.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

import { api, Conversation, errorText, FileChange, MergeMethod, PrComment, PullRequest, RequestRange } from "../api";
import { approvePullRequest, checkoutPullRequest } from "../actions";
import { relativeTime } from "../format";
import { loadInbox, loadPrs, prLabel, usePrView, wantsReview } from "../prs";
import { useStore } from "../store";
import { CiMark } from "./CiMark";
import { FileList } from "./FileList";

const when = (iso: string) => {
  const t = Date.parse(iso) / 1000;
  return Number.isNaN(t) ? "" : relativeTime(t);
};

function CommentItem({ c, onPath }: { c: PrComment; onPath: (path: string) => void }) {
  return (
    <div className={`pr-comment${c.system ? " system" : ""}`}>
      <div className="pr-comment-head">
        <strong>{c.author}</strong>
        {c.verdict === "APPROVED" && <span className="pr-badge ok">approved</span>}
        {c.verdict === "CHANGES_REQUESTED" && <span className="pr-badge review">changes requested</span>}
        {c.path && (
          <button type="button" className="link-btn pr-comment-path" onClick={() => onPath(c.path!)}>
            {c.path}
            {c.line ? `:${c.line}` : ""}
          </button>
        )}
        <span className="dim">{when(c.created)}</span>
      </div>
      {c.body && <div className="pr-comment-body">{c.body}</div>}
    </div>
  );
}

function MergeBox({ pr, onDone }: { pr: PullRequest; onDone: () => void }) {
  const methods: { value: MergeMethod; label: string }[] =
    pr.provider === "github"
      ? [
          { value: "merge", label: "Merge commit" },
          { value: "squash", label: "Squash" },
          { value: "rebase", label: "Rebase" },
        ]
      : [
          { value: "merge", label: "Merge commit" },
          { value: "squash", label: "Squash" },
        ];
  const [method, setMethod] = useState<MergeMethod>("merge");
  const [deleteBranch, setDeleteBranch] = useState(pr.sameRepo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    const repo = useStore.getState().repo?.path;
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await api.mergePullRequest(repo, pr.remote, pr.number, method, deleteBranch && pr.sameRepo);
      useStore.getState().toast("info", `Merged ${prLabel(pr)} into ${pr.targetBranch}`);
      usePrView.setState({ pr: null });
      void loadPrs(repo);
      void loadInbox();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <div className="pr-merge-box">
      <div>
        Merge {prLabel(pr)} into <strong>{pr.targetBranch}</strong> on {pr.project.split("/")[0]}?
      </div>
      <span className="segmented">
        {methods.map((m) => (
          <button key={m.value} type="button" className={method === m.value ? "on" : ""} onClick={() => setMethod(m.value)}>
            {m.label}
          </button>
        ))}
      </span>
      {pr.sameRepo && (
        <label className="checkbox">
          <input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} />
          Delete {pr.sourceBranch} afterwards
        </label>
      )}
      {error && <pre className="modal-error">{error}</pre>}
      <div className="modal-actions">
        <button type="button" className="small-btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="small-btn primary" onClick={() => void merge()} disabled={busy}>
          {busy ? "Merging…" : "Merge"}
        </button>
      </div>
    </div>
  );
}

export function PullRequestPanel() {
  const pr = usePrView((s) => s.pr)!;
  const repo = useStore((s) => s.repo?.path);
  const diffSource = useStore((s) => s.diffSource);
  const openDiff = useStore((s) => s.openDiff);
  const [tab, setTab] = useState<"files" | "conversation">("files");
  const [range, setRange] = useState<RequestRange | null>(null);
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [convError, setConvError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [merging, setMerging] = useState(false);
  const key = `${pr.project}#${pr.number}`;

  const loadConversation = () => {
    if (!repo) return;
    api
      .pullRequestConversation(repo, pr.remote, pr.number)
      .then(setConv)
      .catch((e) => setConvError(errorText(e)));
  };

  useEffect(() => {
    if (!repo) return;
    let live = true;
    setRange(null);
    setFiles(null);
    setFilesError(null);
    setConv(null);
    setConvError(null);
    setMerging(false);
    api
      .pullRequestRange(repo, pr.remote, pr.number, pr.targetBranch)
      .then(async (r) => {
        if (!live) return;
        setRange(r);
        const f = await api.compareCommits(repo, r.base, r.head);
        if (live) setFiles(f);
      })
      .catch((e) => live && setFilesError(errorText(e)));
    api
      .pullRequestConversation(repo, pr.remote, pr.number)
      .then((c) => live && setConv(c))
      .catch((e) => live && setConvError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo, key]);

  const openFile = (path: string) => {
    const f = files?.find((x) => x.path === path);
    if (!range || !f) return;
    setTab("files");
    void openDiff({ kind: "compare", from: range.base, to: range.head, path: f.path, oldPath: f.oldPath });
  };

  async function send() {
    if (!repo || !draft.trim()) return;
    setSending(true);
    try {
      await api.commentPullRequest(repo, pr.remote, pr.number, draft);
      setDraft("");
      loadConversation();
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setSending(false);
    }
  }

  const adds = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const dels = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const people = conv?.comments.filter((c) => !c.system).length ?? 0;

  return (
    <div className="commit-panel pr-panel" data-testid="pull-request">
      <div className="commit-head">
        <div className="stash-kicker">
          {pr.provider === "gitlab" ? "Merge request" : "Pull request"} {prLabel(pr)}
          {pr.draft && <span className="pr-badge">draft</span>}
          {wantsReview(pr) && <span className="pr-badge review">{pr.reviewRequested ? "review" : "approve"}</span>}
          {pr.approved && <span className="pr-badge ok">approved</span>}
          {pr.ci && <CiMark state={pr.ci} url={pr.url} />}
        </div>
        <div className="commit-summary">{pr.title}</div>
        <div className="pr-panel-meta dim">
          {pr.author} · <span className="pr-branches">{pr.sourceBranch} → {pr.targetBranch}</span>
          {!pr.sameRepo && " (fork)"} · {when(pr.created)}
        </div>
        <div className="stash-actions">
          <button className="small-btn" onClick={() => void openUrl(pr.url)}>
            Open in browser
          </button>
          <button className="small-btn" onClick={() => void checkoutPullRequest(pr)}>
            Check out
          </button>
          {pr.canApprove && !pr.approvedByMe && (
            <button className="small-btn" onClick={() => void approvePullRequest(pr)}>
              Approve…
            </button>
          )}
          {conv?.open && !merging && (
            <button
              className="small-btn primary"
              title={conv.mergeable === false ? `Can't merge yet: ${conv.mergeStatus}` : undefined}
              disabled={conv.mergeable === false}
              onClick={() => setMerging(true)}
            >
              Merge…
            </button>
          )}
        </div>
        {conv && conv.mergeable === false && <div className="pr-merge-status">Can't merge: {conv.mergeStatus}</div>}
        {merging && <MergeBox pr={pr} onDone={() => setMerging(false)} />}
      </div>
      <div className="panel-subhead">
        <span className="segmented">
          <button type="button" className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
            Files {files ? <span className="side-count">{files.length}</span> : null}
          </button>
          <button type="button" className={tab === "conversation" ? "on" : ""} onClick={() => setTab("conversation")}>
            Conversation {conv ? <span className="side-count">{people}</span> : null}
          </button>
        </span>
        {tab === "files" && files && (
          <span className="file-stat">
            <span className="add">+{adds}</span> <span className="del">−{dels}</span>
          </span>
        )}
      </div>
      {tab === "files" ? (
        <>
          {filesError && <div className="files-empty">{filesError}</div>}
          {!files && !filesError && <div className="files-empty">Fetching the request…</div>}
          {files && range && (
            <FileList
              files={files}
              empty="No changes"
              activePath={diffSource?.kind === "compare" && diffSource.to === range.head ? diffSource.path : null}
              onOpen={(f) => void openDiff({ kind: "compare", from: range.base, to: range.head, path: f.path, oldPath: f.oldPath })}
            />
          )}
        </>
      ) : (
        <div className="pr-conversation">
          {convError && <div className="files-empty">{convError}</div>}
          {!conv && !convError && <div className="files-empty">Loading…</div>}
          {conv && (
            <>
              {conv.description.trim() ? (
                <div className="pr-description">{conv.description}</div>
              ) : (
                <div className="dim pr-description">No description.</div>
              )}
              {conv.comments.map((c, i) => (
                <CommentItem key={i} c={c} onPath={openFile} />
              ))}
              <form
                className="pr-reply"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  rows={3}
                  placeholder="Write a comment"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
                  }}
                  disabled={sending}
                />
                <button type="submit" className="small-btn" disabled={sending || !draft.trim()}>
                  Comment
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </div>
  );
}
