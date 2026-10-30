// A request's comments as the services show them: threads with their
// replies, a reply box, resolve / reopen, suggested changes to apply.

import { useState } from "react";

import { PrComment } from "../api";
import { relativeTime } from "../format";
import { usePrView } from "../prs";
import { applySuggestion, Entry, groupComments, replyToThread, setResolved, suggestionOf } from "../review";
import { useStore } from "../store";
import { Markdown } from "./Markdown";

const when = (iso: string) => {
  const t = Date.parse(iso) / 1000;
  return Number.isNaN(t) ? "" : relativeTime(t);
};

export function CommentItem({ c, url, onPath }: { c: PrComment; url: string; onPath?: (path: string) => void }) {
  const suggestion = suggestionOf(c);
  const onBranch = useStore((s) => s.repo?.headBranch) === usePrView((s) => s.pr?.sourceBranch);
  return (
    <div className={`pr-comment${c.system ? " system" : ""}`}>
      <div className="pr-comment-head">
        <strong>{c.author}</strong>
        {c.verdict === "APPROVED" && <span className="pr-badge ok">approved</span>}
        {c.verdict === "CHANGES_REQUESTED" && <span className="pr-badge review">changes requested</span>}
        {c.path && onPath && (
          <button type="button" className="link-btn pr-comment-path" onClick={() => onPath(c.path!)}>
            {c.path}
            {c.line ? `:${c.line}` : ""}
          </button>
        )}
        <span className="dim">{when(c.created)}</span>
      </div>
      {c.body &&
        (c.system ? (
          <div className="pr-comment-body">{c.body}</div>
        ) : (
          <Markdown className="pr-comment-body" text={c.body} html={c.html} url={url} />
        ))}
      {suggestion && c.path && (
        <div className="suggestion-actions">
          <button
            type="button"
            className="small-btn"
            title={onBranch ? `Lines ${suggestion.from}–${suggestion.to} of ${c.path} become the suggestion` : "Check out the request's branch first"}
            onClick={() => void applySuggestion(c)}
          >
            Apply suggestion
          </button>
        </div>
      )}
    </div>
  );
}

function ReplyBox({ onSend }: { onSend: (body: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" className="thread-reply-btn" onClick={() => setOpen(true)}>
        Reply…
      </button>
    );
  }
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    if (await onSend(body)) {
      setBody("");
      setOpen(false);
    }
    setBusy(false);
  };
  return (
    <div className="thread-reply">
      <textarea
        autoFocus
        rows={2}
        placeholder="Reply (Ctrl+Enter sends)"
        value={body}
        disabled={busy}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <div className="line-composer-actions">
        <button type="button" className="small-btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="small-btn primary" onClick={() => void send()} disabled={busy || !body.trim()}>
          {busy ? "Sending…" : "Reply"}
        </button>
      </div>
    </div>
  );
}

function ThreadView({ t, url, onPath }: { t: Extract<Entry, { kind: "thread" }>; url: string; onPath?: (path: string) => void }) {
  // Resolved threads start folded, as on the web.
  const [open, setOpen] = useState(!t.resolved);
  const [busy, setBusy] = useState(false);
  const [first, ...replies] = t.comments;
  const toggle = async () => {
    setBusy(true);
    await setResolved(t.id, !t.resolved);
    setBusy(false);
  };
  return (
    <div className={`thread${t.resolved ? " resolved" : ""}`} data-thread={t.id}>
      {!open ? (
        <button type="button" className="thread-folded" onClick={() => setOpen(true)}>
          <span className="pr-badge ok">resolved</span>
          <span className="thread-folded-text">
            {first.author}: {first.body.split("\n")[0]}
          </span>
          <span className="dim">
            {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
          </span>
        </button>
      ) : (
        <>
          <CommentItem c={first} url={url} onPath={onPath} />
          {replies.length > 0 && (
            <div className="thread-replies">
              {replies.map((c) => (
                <CommentItem key={c.id} c={c} url={url} />
              ))}
            </div>
          )}
          <div className="thread-actions">
            <ReplyBox onSend={(body) => replyToThread(t.id, first, body)} />
            {t.resolvable && (
              <button type="button" className="small-btn" disabled={busy} onClick={() => void toggle()}>
                {t.resolved ? "Reopen thread" : "Resolve thread"}
              </button>
            )}
            {t.resolved && (
              <button type="button" className="link-btn" onClick={() => setOpen(false)}>
                Fold
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Comments and threads, oldest first. */
export function Threads({ comments, url, onPath }: { comments: PrComment[]; url: string; onPath?: (path: string) => void }) {
  return (
    <>
      {groupComments(comments).map((e) =>
        e.kind === "comment" ? (
          <CommentItem key={e.comment.id || e.comment.created} c={e.comment} url={url} onPath={onPath} />
        ) : (
          <ThreadView key={e.id} t={e} url={url} onPath={onPath} />
        ),
      )}
    </>
  );
}
