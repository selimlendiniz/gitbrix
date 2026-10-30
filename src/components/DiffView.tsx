import { Fragment, useEffect, useState } from "react";

import { api, DiffLine, errorText, FileDiff, LineAt, PrComment, PullRequest, RequestRange } from "../api";
import { discardFiles } from "../actions";
import { shortId, statusLetter } from "../format";
import { diffTokens, Token } from "../diff/highlight";
import { buildPatch, lineRange } from "../diff/patch";
import { splitRows } from "../diff/split";
import { updateSettings, useSettings } from "../settings";
import { prKey, usePrView } from "../prs";
import { addPending, removePending, suggestionTemplate, useReview, type Pending } from "../review";
import { Threads } from "./Threads";
import { openInEditor } from "../editor";
import { Markdown } from "./Markdown";
import { DiffSource, useStore } from "../store";
import { IconClose } from "./Icons";

type Mode = "unified" | "split";
const MODE_KEY = "gitbrix.diffMode";

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

export function DiffView() {
  const source = useStore((s) => s.diffSource);
  const diff = useStore((s) => s.diff);
  const error = useStore((s) => s.diffError);
  const close = useStore((s) => s.closeDiff);
  const run = useStore((s) => s.run);
  const [mode, setMode] = useState<Mode>(loadMode);

  const openDiff = useStore((s) => s.openDiff);
  const ignoreWs = useSettings((s) => s.ignoreWhitespace);
  const headOid = useStore((s) => s.repo?.headOid ?? null);
  const review = usePrReview();
  // A request's file, opened from its review panel: lines take comments.
  const reviewing =
    !!review && source?.kind === "compare" && source.from === review.range.base && source.to === review.range.head;

  if (!source || (source.kind !== "commit" && source.kind !== "wip" && source.kind !== "compare")) return null;

  function changeMode(m: Mode) {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // ignore
    }
  }

  const status = diff?.status;
  return (
    <div className="diff-view" data-testid="diff">
      <div className="diff-header">
        {status && <span className={`status-badge s-${status}`}>{statusLetter(status)}</span>}
        <span className="diff-path">
          {diff?.oldPath && <span className="dim">{diff.oldPath} → </span>}
          {source.path}
        </span>
        <span className="dim diff-where">
          {source.kind === "commit"
            ? `in ${shortId(source.id)}`
            : source.kind === "compare"
              ? `${shortId(source.from)} → ${shortId(source.to)}`
              : source.staged
                ? "staged"
                : "unstaged"}
        </span>
        <span className="diff-header-actions">
          {source.kind === "wip" &&
            (source.staged ? (
              <button className="small-btn" onClick={() => run("Unstaging", (r) => api.unstage(r, [source.path]), undefined, "status")}>
                Unstage file
              </button>
            ) : (
              <>
                {status !== "conflicted" && (
                  <button className="small-btn danger" onClick={() => discardFiles([source.path])}>
                    Discard
                  </button>
                )}
                <button className="small-btn" onClick={() => run("Staging", (r) => api.stage(r, [source.path]), undefined, "status")}>
                  Stage file
                </button>
              </>
            ))}
          {source.kind !== "wip" && (
            <label className="checkbox" title="Hide changes that only touch spaces and indentation">
              <input
                type="checkbox"
                checked={ignoreWs}
                onChange={(e) => {
                  updateSettings({ ignoreWhitespace: e.target.checked });
                  void openDiff(source);
                }}
              />
              Ignore whitespace
            </label>
          )}
          <button
            className="link-btn"
            title="The work tree's file, at the first change"
            onClick={() => void openInEditor(source.path, diff?.hunks[0]?.newStart || undefined)}
          >
            Edit
          </button>
          <button className="link-btn" onClick={() => openDiff({ kind: "history", path: source.path })}>
            History
          </button>
          <button
            className="link-btn"
            onClick={() =>
              openDiff({
                kind: "blame",
                path: source.path,
                rev: source.kind === "commit" ? source.id : source.kind === "compare" ? source.to : null,
              })
            }
          >
            Blame
          </button>
          <span className="segmented">
            <button className={mode === "unified" ? "on" : ""} onClick={() => changeMode("unified")}>
              Unified
            </button>
            <button className={mode === "split" ? "on" : ""} onClick={() => changeMode("split")}>
              Split
            </button>
          </span>
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="diff-body">
        {error ? (
          <div className="diff-message">{error}</div>
        ) : !diff ? (
          <div className="diff-message">Loading diff…</div>
        ) : (
          <DiffContent
            diff={diff}
            mode={mode}
            wip={source.kind === "wip" ? source : null}
            sides={sidesOf(source, headOid)}
            review={reviewing ? review : undefined}
          />
        )}
      </div>
    </div>
  );
}

type WipSource = { kind: "wip"; path: string; staged: boolean };

interface Selection {
  hunk: number;
  lines: Set<number>;
  anchor: number;
}

/** Where the two sides of a diff come from, for showing images: a commit
 *  id, `<id>^`, `:` for the index or null for the work tree. */
export interface Sides {
  oldRev: string | null;
  newRev: string | null;
}

export function sidesOf(source: DiffSource, headOid: string | null): Sides | undefined {
  switch (source.kind) {
    case "commit":
      return { oldRev: `${source.id}^`, newRev: source.id };
    case "compare":
      return { oldRev: source.from, newRev: source.to };
    case "wip":
      return source.staged ? { oldRev: headOid, newRev: ":" } : { oldRev: ":", newRev: null };
    default:
      return undefined;
  }
}

interface Review {
  pr: PullRequest;
  range: RequestRange;
  comments: PrComment[];
  pending: Pending[];
  post: (diff: FileDiff, line: DiffLine, body: string) => Promise<boolean>;
}

function lineAt(diff: FileDiff, line: DiffLine): LineAt {
  return {
    path: diff.path,
    oldPath: diff.oldPath,
    newLine: line.kind === "del" ? null : line.newNo,
    oldLine: line.kind === "add" ? null : line.oldNo,
  };
}

const NO_PENDING: Pending[] = [];

/** The request under review, with a way to comment on its lines. */
function usePrReview(): Review | null {
  const pr = usePrView((s) => s.pr);
  const range = usePrView((s) => s.range);
  const conv = usePrView((s) => s.conv);
  const pending = useReview((s) => (pr ? (s.pending[prKey(pr)] ?? NO_PENDING) : NO_PENDING));
  if (!pr || !range) return null;
  return {
    pr,
    range,
    comments: conv?.comments ?? [],
    pending,
    async post(diff, line, body) {
      const repo = useStore.getState().repo?.path;
      if (!repo) return false;
      try {
        await api.commentPullRequestLine(repo, pr.remote, pr.number, lineAt(diff, line), body);
        usePrView.setState({ conv: await api.pullRequestConversation(repo, pr.remote, pr.number) });
        return true;
      } catch (e) {
        useStore.getState().toast("error", errorText(e));
        return false;
      }
    },
  };
}

/** Comments made on this line (new side, or old side for removed lines). */
function commentsOn(review: Review, path: string, l: DiffLine): PrComment[] {
  const line = l.kind === "del" ? l.oldNo : l.newNo;
  return review.comments.filter((c) => !c.system && c.path === path && c.line != null && c.line === line);
}

/** Comments of the pending review on this line, with their index. */
function pendingOn(review: Review, path: string, l: DiffLine): [Pending, number][] {
  return review.pending
    .map((p, i) => [p, i] as [Pending, number])
    .filter(([p]) => p.path === path && (l.kind === "del" ? p.oldLine === l.oldNo && p.newLine == null : p.newLine === l.newNo));
}

function LineComments({ review, comments, pending }: { review: Review; comments: PrComment[]; pending: [Pending, number][] }) {
  return (
    <div className="line-comments">
      <Threads comments={comments} url={review.pr.url} />
      {pending.map(([p, i]) => (
        <div key={i} className="pr-comment pending">
          <div className="pr-comment-head">
            <span className="pr-badge review">pending</span>
            <span className="dim">in your review, not sent yet</span>
            <button type="button" className="link-btn" onClick={() => removePending(review.pr, i)}>
              Remove
            </button>
          </div>
          <Markdown className="pr-comment-body" text={p.body} url={review.pr.url} />
        </div>
      ))}
    </div>
  );
}

function Composer({
  review,
  diff,
  line,
  onCancel,
}: {
  review: Review;
  diff: FileDiff;
  line: DiffLine;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim()) return;
    setBusy(true);
    if (await review.post(diff, line, body)) onCancel();
    setBusy(false);
  };
  const later = () => {
    if (!body.trim()) return;
    addPending(review.pr, { ...lineAt(diff, line), body });
    onCancel();
  };
  return (
    <div className="line-composer">
      <textarea
        autoFocus
        rows={3}
        placeholder="Comment on this line (Ctrl+Enter adds it to your review)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) later();
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        disabled={busy}
      />
      <div className="line-composer-actions">
        {line.kind !== "del" && (
          <button
            type="button"
            className="small-btn suggest-btn"
            title="Propose new text for this line"
            disabled={busy}
            onClick={() => setBody((b) => `${b}${b && !b.endsWith("\n") ? "\n" : ""}${suggestionTemplate(review.pr.provider, line.text)}\n`)}
          >
            Suggest change
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="small-btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="small-btn" onClick={() => void send()} disabled={busy || !body.trim()} title="Send this comment on its own now">
          {busy ? "Sending…" : "Comment now"}
        </button>
        <button type="button" className="small-btn primary" onClick={later} disabled={busy || !body.trim()}>
          Add to review
        </button>
      </div>
    </div>
  );
}

export function DiffContent({
  diff,
  mode,
  wip,
  sides,
  review,
}: {
  diff: FileDiff;
  mode: Mode;
  wip: WipSource | null;
  sides?: Sides;
  /** A pull request's diff: comments show under their lines, and any line
   *  takes a new one (unified view). */
  review?: Review;
}) {
  const run = useStore((s) => s.run);
  const confirm = useStore((s) => s.confirm);
  const [sel, setSel] = useState<Selection | null>(null);
  const [composing, setComposing] = useState<string | null>(null);

  // A new diff (after staging, or another file) invalidates line indices.
  useEffect(() => setSel(null), [diff]);

  // Syntax colours and intra-line marks arrive asynchronously; until then
  // lines render as plain text.
  const [tokens, setTokens] = useState<Token[][][] | null>(null);
  useEffect(() => {
    let live = true;
    setTokens(null);
    if (!diff.binary && diff.hunks.length) {
      diffTokens(diff.path, diff.hunks).then((t) => live && setTokens(t), () => {});
    }
    return () => {
      live = false;
    };
  }, [diff]);

  if (diff.binary) {
    if (sides && IMAGE_TYPES[ext(diff.path)]) return <ImageDiff diff={diff} sides={sides} />;
    return <div className="diff-message">Binary file — no text diff.</div>;
  }
  if (diff.hunks.length === 0) {
    return <div className="diff-message">{diff.status === "renamed" ? "File renamed without changes." : "No content changes."}</div>;
  }

  function pick(hunk: number, line: number, extend: boolean) {
    setSel((cur) => {
      if (extend && cur && cur.hunk === hunk) {
        return { ...cur, lines: new Set([...cur.lines, ...lineRange(diff.hunks[hunk], cur.anchor, line)]) };
      }
      const lines = new Set(cur?.hunk === hunk ? cur.lines : []);
      if (lines.has(line)) lines.delete(line);
      else lines.add(line);
      return lines.size ? { hunk, lines, anchor: line } : null;
    });
  }

  async function apply(hunk: number, action: "stage" | "unstage" | "discard") {
    const h = diff.hunks[hunk];
    const lines = sel?.hunk === hunk ? sel.lines : null;
    const reverse = action !== "stage";
    // A whole new or deleted file is one hunk; a patch would leave an empty
    // file behind instead of adding or removing it, so act on the file.
    if (!lines && diff.hunks.length === 1 && ["added", "deleted", "untracked"].includes(diff.status)) {
      if (action === "discard") return discardFiles([diff.path]);
      return run(action === "stage" ? "Staging" : "Unstaging", (r) => (action === "stage" ? api.stage(r, [diff.path]) : api.unstage(r, [diff.path])), undefined, "status");
    }
    let patch: string | null;
    try {
      patch = buildPatch(diff, h, lines, reverse);
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
      return;
    }
    if (!patch) return;
    const what = lines ? `${lines.size} line${lines.size === 1 ? "" : "s"}` : "this hunk";
    if (action === "discard") {
      const ok = await confirm({
        title: "Discard changes",
        message: `Discard ${what} in ${diff.path}? This cannot be undone.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    const intentToAdd = action === "stage" && diff.status === "untracked" ? diff.path : null;
    const label = { stage: "Staging", unstage: "Unstaging", discard: "Discarding" }[action];
    await run(label, (r) => api.applyPatch(r, patch, action === "discard" ? "worktree" : "index", reverse, intentToAdd), undefined, "status");
  }

  return (
    <div className={`diff-table ${mode}`}>
      {diff.hunks.map((h, i) => {
        const n = sel?.hunk === i ? sel.lines.size : 0;
        const what = n ? `${n} line${n === 1 ? "" : "s"}` : "hunk";
        return (
          <div className="hunk" key={i}>
            <div className="hunk-header">
              <span className="hunk-range">{h.header}</span>
              {wip && !diff.lossy && (
                <span className="hunk-actions">
                  {wip.staged ? (
                    <button className="small-btn" onClick={() => apply(i, "unstage")}>
                      Unstage {what}
                    </button>
                  ) : (
                    <>
                      <button className="small-btn danger" onClick={() => apply(i, "discard")}>
                        Discard {what}
                      </button>
                      <button className="small-btn" onClick={() => apply(i, "stage")}>
                        Stage {what}
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            {mode === "unified"
              ? h.lines.map((l, j) => {
                  const here = review ? commentsOn(review, diff.path, l) : [];
                  const waiting = review ? pendingOn(review, diff.path, l) : [];
                  return (
                    <Fragment key={j}>
                      <UnifiedLine
                        l={l}
                        tokens={tokens?.[i]?.[j]}
                        selected={sel?.hunk === i && sel.lines.has(j)}
                        onPick={wip && !diff.lossy && l.kind !== "ctx" ? (extend) => pick(i, j, extend) : undefined}
                        onComment={review ? () => setComposing(`${i}:${j}`) : undefined}
                      />
                      {review && (here.length > 0 || waiting.length > 0) && <LineComments review={review} comments={here} pending={waiting} />}
                      {review && composing === `${i}:${j}` && (
                        <Composer review={review} diff={diff} line={l} onCancel={() => setComposing(null)} />
                      )}
                    </Fragment>
                  );
                })
              : (() => {
                  const byLine = new Map(h.lines.map((l, j) => [l, tokens?.[i]?.[j]]));
                  return splitRows(h.lines).map((r, j) => (
                    <div className="split-row" key={j}>
                      <SideLine l={r.left} side="old" tokens={r.left ? byLine.get(r.left) : undefined} />
                      <SideLine l={r.right} side="new" tokens={r.right ? byLine.get(r.right) : undefined} />
                    </div>
                  ));
                })()}
          </div>
        );
      })}
      {diff.truncated && <div className="diff-message">Diff truncated — file is too large to show in full.</div>}
      {wip && diff.lossy && (
        <div className="diff-message">This file isn't UTF-8 text, so hunks and lines can't be staged separately. Stage the whole file instead.</div>
      )}
    </div>
  );
}

function Code({ text, tokens }: { text: string; tokens: Token[] | undefined }) {
  if (!tokens) return <span className="code">{text || " "}</span>;
  return (
    <span className="code">
      {tokens.length === 0
        ? " "
        : tokens.map((t, k) => (
            <span key={k} className={`${t.cls ? t.cls.split(" ").map((c) => `hl-${c}`).join(" ") : ""}${t.mark ? " chg" : ""}`}>
              {t.text}
            </span>
          ))}
    </span>
  );
}

function UnifiedLine({
  l,
  tokens,
  selected,
  onPick,
  onComment,
}: {
  l: DiffLine;
  tokens: Token[] | undefined;
  selected: boolean;
  onPick?: (extend: boolean) => void;
  onComment?: () => void;
}) {
  return (
    <div
      className={`dl ${l.kind}${selected ? " picked" : ""}${onPick ? " pickable" : ""}`}
      onMouseDown={
        onPick
          ? (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onPick(e.shiftKey);
            }
          : undefined
      }
      title={onPick ? "Click to select, Shift+click for a range" : undefined}
    >
      <span className="ln">{l.oldNo ?? ""}</span>
      <span className="ln">{l.newNo ?? ""}</span>
      <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
      <Code text={l.text} tokens={tokens} />
      {onComment && (
        <button
          type="button"
          className="comment-add"
          title="Comment on this line"
          aria-label="Comment on this line"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onComment}
        >
          +
        </button>
      )}
    </div>
  );
}

function SideLine({ l, side, tokens }: { l: DiffLine | null; side: "old" | "new"; tokens: Token[] | undefined }) {
  if (!l) return <div className="dl empty"><span className="ln" /><span className="code" /></div>;
  const kind = l.kind === "ctx" ? "ctx" : l.kind;
  return (
    <div className={`dl ${kind}`}>
      <span className="ln">{(side === "old" ? l.oldNo : l.newNo) ?? ""}</span>
      <Code text={l.text} tokens={tokens} />
    </div>
  );
}

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export function ext(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Old and new version of an image file side by side. */
function ImageDiff({ diff, sides }: { diff: FileDiff; sides: Sides }) {
  const repo = useStore((s) => s.repo?.path);
  const [images, setImages] = useState<{ old: string | null; new: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mime = IMAGE_TYPES[ext(diff.path)];

  useEffect(() => {
    if (!repo) return;
    let live = true;
    setImages(null);
    const oldPath = diff.oldPath ?? diff.path;
    const load = (rev: string | null | undefined, path: string) =>
      rev === undefined || (rev === null && diff.status === "deleted") ? Promise.resolve(null) : api.fileBase64(repo, rev, path).catch(() => null);
    Promise.all([diff.status === "added" || diff.status === "untracked" ? null : load(sides.oldRev, oldPath), diff.status === "deleted" ? null : load(sides.newRev, diff.path)])
      .then(([o, n]) => live && setImages({ old: o, new: n }))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo, diff, sides.oldRev, sides.newRev]);

  if (error) return <div className="diff-message">{error}</div>;
  if (!images) return <div className="diff-message">Loading images…</div>;
  const pane = (label: string, data: string | null) => (
    <figure className="image-pane">
      <figcaption>{label}</figcaption>
      {data ? <img src={`data:${mime};base64,${data}`} alt={label} /> : <div className="image-none">none</div>}
    </figure>
  );
  return (
    <div className="image-diff">
      {pane("Before", images.old)}
      {pane("After", images.new)}
    </div>
  );
}
