// Details panel for a pull/merge request reviewed in the app: its changes
// (fetched and diffed locally), the conversation, comment, approve, merge.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";

import { api, Conversation, errorText, FileChange, MergeMethod, PullRequest, RequestRange, ReviewVerdict } from "../api";
import { approvePullRequest, checkoutPullRequest } from "../actions";
import { relativeTime } from "../format";
import { loadInbox, loadPrs, prKey, prLabel, tidyAfterMerge, usePrView, wantsReview } from "../prs";
import { useStore } from "../store";
import { CiMark } from "./CiMark";
import { FileList } from "./FileList";
import { Markdown } from "./Markdown";
import { Threads } from "./Threads";
import { removePending, submitReview, useReview, type Pending } from "../review";

const when = (iso: string) => {
  const t = Date.parse(iso) / 1000;
  return Number.isNaN(t) ? "" : relativeTime(t);
};

const NO_PENDING: Pending[] = [];

function ReviewBox({ pr }: { pr: PullRequest }) {
  const pending = useReview((s) => s.pending[prKey(pr)] ?? NO_PENDING);
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<ReviewVerdict>("comment");
  const [busy, setBusy] = useState(false);
  const verdicts: { value: ReviewVerdict; label: string }[] = [
    { value: "comment", label: "Comment" },
    ...(pr.canApprove ? [{ value: "approve" as const, label: "Approve" }] : []),
    // GitLab has no "request changes" in its API.
    ...(pr.provider === "github" && !pr.mine ? [{ value: "request_changes" as const, label: "Request changes" }] : []),
  ];
  const send = async () => {
    setBusy(true);
    if (await submitReview(pr, body, verdict)) {
      setBody("");
      setVerdict("comment");
    }
    setBusy(false);
  };
  return (
    <div className="review-box" data-testid="review">
      <div className="review-box-head">
        <strong>Your review</strong>
        <span className="dim">
          {pending.length
            ? `${pending.length} comment${pending.length === 1 ? "" : "s"} waiting to be sent`
            : "Add line comments to it from the diffs, then send them together"}
        </span>
      </div>
      {pending.map((c, i) => (
        <div key={i} className="review-pending">
          <span className="pr-comment-path">
            {c.path}:{c.newLine ?? c.oldLine}
          </span>
          <span className="review-pending-body">{c.body.split("\n")[0]}</span>
          <button type="button" className="link-btn" onClick={() => removePending(pr, i)}>
            Remove
          </button>
        </div>
      ))}
      <textarea rows={2} placeholder="Summary (optional)" value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} />
      <div className="review-box-actions">
        <span className="segmented">
          {verdicts.map((v) => (
            <button key={v.value} type="button" className={verdict === v.value ? "on" : ""} onClick={() => setVerdict(v.value)}>
              {v.label}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="small-btn primary"
          disabled={busy || (verdict !== "approve" && !pending.length && !body.trim())}
          onClick={() => void send()}
        >
          {busy ? "Sending…" : "Send review"}
        </button>
      </div>
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
  const checksRunning = pr.ci === "running" || pr.ci === "pending";
  const [whenChecksPass, setWhenChecksPass] = useState(checksRunning);
  const headBranch = useStore((s) => s.repo?.headBranch);
  const localCopy = useStore((s) => pr.sameRepo && !!s.graph?.refs.some((r) => r.kind === "local" && r.name === pr.sourceBranch));
  const [tidy, setTidy] = useState(headBranch === pr.sourceBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    const repo = useStore.getState().repo?.path;
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const auto = checksRunning && whenChecksPass;
      const done = await api.mergePullRequest(repo, pr.remote, pr.number, method, deleteBranch && pr.sameRepo, auto);
      useStore
        .getState()
        .toast(
          "info",
          done === "scheduled"
            ? `${prLabel(pr)} will be merged into ${pr.targetBranch} when its checks pass`
            : `Merged ${prLabel(pr)} into ${pr.targetBranch}`,
        );
      usePrView.setState({ pr: null });
      if (done === "merged" && tidy && localCopy) await tidyAfterMerge(pr);
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
          Delete {pr.sourceBranch} on {pr.remote} afterwards
        </label>
      )}
      {checksRunning && (
        <label className="checkbox" title={pr.provider === "github" ? "GitHub's auto-merge; the repository must allow it" : "GitLab's merge when pipeline succeeds"}>
          <input type="checkbox" checked={whenChecksPass} onChange={(e) => setWhenChecksPass(e.target.checked)} />
          Merge when checks pass (they're {pr.ci} now)
        </label>
      )}
      {localCopy && !(checksRunning && whenChecksPass) && (
        <label className="checkbox">
          <input type="checkbox" checked={tidy} onChange={(e) => setTidy(e.target.checked)} />
          {headBranch === pr.sourceBranch ? `Then switch to ${pr.targetBranch}, pull, and` : "Then"} delete the local {pr.sourceBranch}
        </label>
      )}
      {error && <pre className="modal-error">{error}</pre>}
      <div className="modal-actions">
        <button type="button" className="small-btn" onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="small-btn primary" onClick={() => void merge()} disabled={busy}>
          {busy ? "Merging…" : checksRunning && whenChecksPass ? "Merge when checks pass" : "Merge"}
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
  const range = usePrView((s) => s.range);
  const setRange = (range: RequestRange | null) => usePrView.setState({ range });
  const [files, setFiles] = useState<FileChange[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const conv = usePrView((s) => s.conv);
  const setConv = (conv: Conversation | null) => usePrView.setState({ conv });
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
  const pendingCount = useReview((s) => s.pending[prKey(pr)]?.length ?? 0);

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
            {pendingCount > 0 && (
              <span className="pr-badge review" title="Comments in your review, not sent yet">
                {pendingCount} pending
              </span>
            )}
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
                <Markdown className="pr-description" text={conv.description} html={conv.descriptionHtml} url={pr.url} />
              ) : (
                <div className="dim pr-description">No description.</div>
              )}
              <Threads comments={conv.comments} url={pr.url} onPath={openFile} />
              <ReviewBox pr={pr} />
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
