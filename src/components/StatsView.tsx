// Repository statistics for the current branch: totals, weekly activity,
// when people commit (weekday × hour), contributors and the files that
// change most. One hue throughout: more is darker.

import { useEffect, useState } from "react";

import { api, errorText, RepoStats } from "../api";
import { fullTime, relativeTime } from "../format";
import { useStore } from "../store";
import { IconClose } from "./Icons";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {note && <div className="stat-note dim">{note}</div>}
    </div>
  );
}

function Weeks({ weeks, start }: { weeks: number[]; start: number }) {
  const max = Math.max(1, ...weeks);
  const w = 12;
  const gap = 2;
  const h = 90;
  const day = (i: number) => new Date((start + i * 7 * 86400) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <svg className="stats-weeks" viewBox={`0 0 ${weeks.length * (w + gap)} ${h + 16}`} role="img" aria-label="Commits per week, last 52 weeks">
      <line x1={0} x2={weeks.length * (w + gap)} y1={h + 0.5} y2={h + 0.5} className="stats-axis" />
      {weeks.map((n, i) => {
        const bh = n ? Math.max(3, (n / max) * (h - 4)) : 0;
        return (
          <g key={i} className="stats-bar">
            {/* The hit area is the whole column, not just the bar. */}
            <rect x={i * (w + gap)} y={0} width={w + gap} height={h} fill="transparent" />
            {n > 0 && <rect x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={2} className="stats-fill" />}
            <title>{`Week of ${day(i)}: ${n} commit${n === 1 ? "" : "s"}`}</title>
          </g>
        );
      })}
      {[0, 13, 26, 39].map((i) => (
        <text key={i} x={i * (w + gap)} y={h + 13} className="stats-tick">
          {day(i)}
        </text>
      ))}
    </svg>
  );
}

function Hours({ hours }: { hours: number[][] }) {
  const max = Math.max(1, ...hours.flat());
  const c = 16;
  const gap = 2;
  const left = 30;
  return (
    <svg className="stats-hours" viewBox={`0 0 ${left + 24 * (c + gap)} ${7 * (c + gap) + 16}`} role="img" aria-label="Commits by weekday and hour">
      {hours.map((row, d) => (
        <g key={d}>
          <text x={0} y={d * (c + gap) + c - 4} className="stats-tick">
            {DAYS[d]}
          </text>
          {row.map((n, hr) => (
            <rect
              key={hr}
              x={left + hr * (c + gap)}
              y={d * (c + gap)}
              width={c}
              height={c}
              rx={3}
              className={n ? "stats-fill" : "stats-empty"}
              style={n ? { opacity: 0.18 + 0.82 * (n / max) } : undefined}
            >
              <title>{`${DAYS[d]} ${String(hr).padStart(2, "0")}:00–${String(hr).padStart(2, "0")}:59: ${n} commit${n === 1 ? "" : "s"}`}</title>
            </rect>
          ))}
        </g>
      ))}
      {[0, 6, 12, 18].map((hr) => (
        <text key={hr} x={left + hr * (c + gap)} y={7 * (c + gap) + 12} className="stats-tick">
          {String(hr).padStart(2, "0")}
        </text>
      ))}
    </svg>
  );
}

export function StatsView() {
  const repo = useStore((s) => s.repo);
  const head = useStore((s) => s.repo?.headOid);
  const close = useStore((s) => s.closeDiff);
  const openDiff = useStore((s) => s.openDiff);
  const [stats, setStats] = useState<RepoStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    let live = true;
    setError(null);
    api.repoStats(repo.path).then(
      (s) => live && setStats(s),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [repo?.path, head]);

  const top = stats?.authors[0]?.commits ?? 1;
  return (
    <div className="diff-view stats-view" data-testid="stats">
      <div className="diff-header">
        <span className="view-kind">Statistics</span>
        <span className="diff-path">{repo?.headBranch ?? "HEAD"}</span>
        <span className="diff-header-actions">
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      {error ? (
        <div className="diff-message">{error}</div>
      ) : !stats ? (
        <div className="diff-message">Counting…</div>
      ) : (
        <div className="stats-body">
          <div className="stat-tiles">
            <Tile label="commits" value={stats.commits.toLocaleString()} note={`${stats.merges.toLocaleString()} merges`} />
            <Tile label="contributors" value={stats.authors.length.toLocaleString()} />
            <Tile label="first commit" value={stats.first ? relativeTime(stats.first) : "—"} note={stats.first ? fullTime(stats.first) : undefined} />
            <Tile label="last commit" value={stats.last ? relativeTime(stats.last) : "—"} note={stats.last ? fullTime(stats.last) : undefined} />
          </div>

          <section className="stats-section">
            <h3>Commits per week</h3>
            <Weeks weeks={stats.weeks} start={stats.weeksStart} />
          </section>

          <section className="stats-section">
            <h3>When commits are made</h3>
            <Hours hours={stats.hours} />
          </section>

          <div className="stats-columns">
            <section className="stats-section">
              <h3>Contributors</h3>
              <table className="stats-table">
                <tbody>
                  {stats.authors.slice(0, 25).map((a) => (
                    <tr key={a.email || a.name} title={`${a.email}\nfirst ${fullTime(a.first)}\nlast ${fullTime(a.last)}`}>
                      <td className="stats-name">{a.name}</td>
                      <td className="stats-share">
                        <span className="stats-share-bar" style={{ width: `${(a.commits / top) * 100}%` }} />
                      </td>
                      <td className="stats-num">{a.commits.toLocaleString()}</td>
                      <td className="stats-num dim">{Math.round((a.commits / stats.commits) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {stats.authors.length > 25 && <div className="dim stats-more">and {stats.authors.length - 25} more</div>}
            </section>

            <section className="stats-section">
              <h3>Most changed files</h3>
              <div className="dim stats-more">in the last {stats.hotWindow.toLocaleString()} commits</div>
              <table className="stats-table">
                <tbody>
                  {stats.hotFiles.map((f) => (
                    <tr key={f.path} className="stats-file" onClick={() => void openDiff({ kind: "history", path: f.path })} title="Show its history">
                      <td className="stats-path">{f.path}</td>
                      <td className="stats-num">{f.changes.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
