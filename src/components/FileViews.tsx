// File history and blame, opened from a file's context menu or the diff
// header. Both fill the center area like the diff view.

import { useEffect, useMemo, useState } from "react";

import { api, Blame, errorText, FileDiff, HistoryEntry } from "../api";
import { laneColor } from "../colors";
import { fullTime, relativeTime, shortId } from "../format";
import { useStore } from "../store";
import { DiffContent } from "./DiffView";
import { IconClose } from "./Icons";

const HISTORY_LIMIT = 500;

function Header({ title, path, children }: { title: string; path: string; children?: React.ReactNode }) {
  const close = useStore((s) => s.closeDiff);
  return (
    <div className="diff-header">
      <span className="view-kind">{title}</span>
      <span className="diff-path">{path}</span>
      <span className="diff-header-actions">
        {children}
        <button className="icon-btn" title="Close (Esc)" onClick={close}>
          <IconClose size={14} />
        </button>
      </span>
    </div>
  );
}

export function HistoryView() {
  const source = useStore((s) => s.diffSource);
  const repo = useStore((s) => s.repo);
  const select = useStore((s) => s.select);
  const openDiff = useStore((s) => s.openDiff);
  const path = source?.kind === "history" ? source.path : null;

  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<HistoryEntry | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo || !path) return;
    let live = true;
    setEntries(null);
    setError(null);
    setCurrent(null);
    api
      .fileHistory(repo.path, path, HISTORY_LIMIT)
      .then((h) => {
        if (!live) return;
        setEntries(h);
        setCurrent(h[0] ?? null);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, path]);

  useEffect(() => {
    if (!repo || !current) return;
    let live = true;
    setDiff(null);
    setDiffError(null);
    // The commit's file list knows whether this was a rename and from where.
    api
      .commitDetails(repo.path, current.id)
      .then((d) => {
        const f = d.files.find((f) => f.path === current.path);
        return api.commitFileDiff(repo.path, current.id, current.path, f?.oldPath ?? null);
      })
      .then((d) => live && setDiff(d))
      .catch((e) => live && setDiffError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, current]);

  if (!path) return null;
  return (
    <div className="diff-view" data-testid="history">
      <Header title="History" path={path}>
        {current && (
          <button className="small-btn" onClick={() => openDiff({ kind: "blame", path: current.path, rev: current.id })}>
            Blame at {shortId(current.id)}
          </button>
        )}
      </Header>
      <div className="history-body">
        <div className="history-list">
          {error && <div className="diff-message">{error}</div>}
          {!entries && !error && <div className="diff-message">Loading…</div>}
          {entries?.length === 0 && <div className="diff-message">No commits touch this file.</div>}
          {entries?.map((e) => (
            <div
              key={e.id}
              className={`history-item${current?.id === e.id ? " active" : ""}`}
              onClick={() => setCurrent(e)}
              onDoubleClick={() => select(e.id, true)}
              title="Double-click to select in the graph"
            >
              <div className="history-summary">{e.summary}</div>
              <div className="history-meta dim">
                <span className="sha-inline">{shortId(e.id)}</span>
                {e.authorName} · <span title={fullTime(e.time)}>{relativeTime(e.time)}</span>
                {e.path !== path && <span className="history-renamed"> · as {e.path}</span>}
              </div>
            </div>
          ))}
          {entries && entries.length >= HISTORY_LIMIT && <div className="diff-message">Showing the newest {HISTORY_LIMIT}.</div>}
        </div>
        <div className="diff-body">
          {diffError ? (
            <div className="diff-message">{diffError}</div>
          ) : !current ? null : !diff ? (
            <div className="diff-message">Loading diff…</div>
          ) : (
            <DiffContent diff={diff} mode="unified" wip={null} sides={{ oldRev: `${current.id}^`, newRev: current.id }} />
          )}
        </div>
      </div>
    </div>
  );
}

export function BlameView() {
  const source = useStore((s) => s.diffSource);
  const repo = useStore((s) => s.repo);
  const select = useStore((s) => s.select);
  const openDiff = useStore((s) => s.openDiff);
  const target = source?.kind === "blame" ? source : null;

  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo || !target) return;
    let live = true;
    setBlame(null);
    setError(null);
    api
      .blame(repo.path, target.path, target.rev)
      .then((b) => live && setBlame(b))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo?.path, target?.path, target?.rev]);

  // Older commits get cooler colours: rank commits by time.
  const rank = useMemo(() => {
    if (!blame) return new Map<string, number>();
    const ids = Object.values(blame.commits).sort((a, b) => b.time - a.time).map((c) => c.id);
    return new Map(ids.map((id, i) => [id, ids.length > 1 ? i / (ids.length - 1) : 0]));
  }, [blame]);

  if (!target) return null;
  return (
    <div className="diff-view" data-testid="blame">
      <Header title="Blame" path={target.path}>
        <span className="dim diff-where">{target.rev ? `at ${shortId(target.rev)}` : "working tree"}</span>
        <button className="small-btn" onClick={() => openDiff({ kind: "history", path: target.path })}>
          History
        </button>
      </Header>
      <div className="diff-body">
        {error ? (
          <div className="diff-message">{error}</div>
        ) : !blame ? (
          <div className="diff-message">Loading blame…</div>
        ) : (
          <div className="diff-table blame-table">
            {blame.lines.map((l, i) => {
              const c = blame.commits[l.id];
              const startsRun = i === 0 || blame.lines[i - 1].id !== l.id;
              const uncommitted = /^0+$/.test(l.id);
              const age = rank.get(l.id) ?? 0;
              return (
                <div key={i} className={`blame-line${startsRun ? " run-start" : ""}`}>
                  <span
                    className="blame-gutter"
                    style={{ borderLeftColor: uncommitted ? "var(--warn)" : laneColor(Math.round(age * 3)) }}
                    title={c && !uncommitted ? `${c.summary}\n${c.authorName} · ${fullTime(c.time)}\n${l.id}` : "Not committed yet"}
                    onClick={() => !uncommitted && select(l.id, true)}
                  >
                    {startsRun &&
                      (uncommitted ? (
                        <span className="blame-info">Uncommitted changes</span>
                      ) : (
                        c && (
                          <span className="blame-info">
                            <span className="sha-inline">{shortId(l.id)}</span>
                            <span className="blame-author">{c.authorName}</span>
                            <span className="blame-date">{relativeTime(c.time)}</span>
                          </span>
                        )
                      ))}
                  </span>
                  <span className="ln">{l.line}</span>
                  <span className="code">{l.text || " "}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
