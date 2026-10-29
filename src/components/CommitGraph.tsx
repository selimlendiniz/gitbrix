import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CommitRow, WIP_ID } from "../api";
import { checkoutRef, commitMenu, refMenu } from "../actions";
import { laneColor } from "../colors";
import { relativeTime, fullTime } from "../format";
import { drawGraph, graphWidth, ROW_H } from "../graph/draw";
import { primaryRef, RefPill, refsByCommit } from "../graph/refs";
import { useStore } from "../store";
import { IconClose, IconCloud, IconLaptop, IconSearch, IconTag } from "./Icons";

const REFS_W = 190;
const MAX_GRAPH_W = 320;
const AUTHOR_W = 150;
const DATE_W = 110;
/** The message column never gets narrower than this; the graph is
 *  clipped instead (its leftmost lanes are the important ones). */
const MIN_MESSAGE_W = 220;
const OVERSCAN = 6;

/** Does a commit match the search text? Message, author or SHA prefix. */
export function commitMatches(c: CommitRow, q: string): boolean {
  if (c.id === WIP_ID || !q) return false;
  return (
    c.summary.toLowerCase().includes(q) ||
    c.authorName.toLowerCase().includes(q) ||
    c.authorEmail.toLowerCase().includes(q) ||
    (q.length >= 4 && c.id.startsWith(q))
  );
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function CommitGraph() {
  const graph = useStore((s) => s.graph);
  const status = useStore((s) => s.status);
  const repo = useStore((s) => s.repo);
  const selectedId = useStore((s) => s.selectedId);
  const scrollRequest = useStore((s) => s.scrollRequest);
  const select = useStore((s) => s.select);
  const showMenu = useStore((s) => s.showMenu);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [viewW, setViewW] = useState(1000);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const commits = graph?.commits ?? [];
  const pills = useMemo(() => refsByCommit(graph?.refs ?? []), [graph]);
  const q = searchOpen ? query.trim().toLowerCase() : "";
  const matches = useMemo(() => {
    if (!q) return null;
    const out: number[] = [];
    commits.forEach((c, i) => commitMatches(c, q) && out.push(i));
    return out;
  }, [commits, q]);
  const matchSet = useMemo(() => (matches ? new Set(matches) : null), [matches]);
  const selectedIndex = commits.findIndex((c) => c.id === selectedId);
  const matchPos = matches ? matches.indexOf(selectedIndex) : -1;

  // Ctrl+F (handled globally) asks the graph to open its search box.
  useEffect(() => {
    const open = () => {
      setSearchOpen(true);
      setTimeout(() => searchRef.current?.select(), 0);
    };
    window.addEventListener("gitbrix:find", open);
    return () => window.removeEventListener("gitbrix:find", open);
  }, []);

  function jump(dir: 1 | -1) {
    if (!matches?.length) return;
    const next =
      dir === 1
        ? (matches.find((i) => i > selectedIndex) ?? matches[0])
        : ([...matches].reverse().find((i) => i < selectedIndex) ?? matches[matches.length - 1]);
    select(commits[next].id, true);
  }
  const room = viewW - REFS_W - AUTHOR_W - DATE_W - MIN_MESSAGE_W;
  const gw = Math.max(64, Math.min(MAX_GRAPH_W, graphWidth(graph?.maxLanes ?? 1), room));
  const columns = `${REFS_W}px ${gw}px minmax(0, 1fr) ${AUTHOR_W}px ${DATE_W}px`;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewH(el.clientHeight);
    setViewW(el.clientWidth);
      setViewW(el.clientWidth);
    });
    ro.observe(el);
    setViewH(el.clientHeight);
    setViewW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(commits.length - 1, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(gw * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${gw}px`;
    canvas.style.height = `${viewH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraph(ctx, {
      commits,
      first,
      last,
      scrollTop,
      width: gw,
      height: viewH,
      selectedId,
      headId: repo?.headOid ?? null,
      background: cssVar("--bg-graph", "#16181e"),
      nodeText: cssVar("--node-text", "#0d0f14"),
    });
  }, [commits, first, last, scrollTop, viewH, gw, selectedId, repo?.headOid]);

  // Bring the selection into view when something asks for it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !selectedId) return;
    const i = commits.findIndex((c) => c.id === selectedId);
    if (i < 0) return;
    const top = i * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollRequest]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const i = commits.findIndex((c) => c.id === selectedId);
      let next = i;
      if (e.key === "ArrowDown") next = Math.min(commits.length - 1, i + 1);
      if (e.key === "ArrowUp") next = Math.max(0, i - 1);
      if (e.key === "Home") next = 0;
      if (e.key === "End") next = commits.length - 1;
      if (commits[next]) select(commits[next].id, true);
    },
    [commits, selectedId, select],
  );

  const wipCounts = status
    ? { staged: status.staged.length, unstaged: status.unstaged.length + status.conflicted.length }
    : { staged: 0, unstaged: 0 };

  const rows = [];
  for (let i = first; i <= last; i++) {
    const c = commits[i];
    rows.push(
      <GraphRow
        key={c.id}
        commit={c}
        index={i}
        columns={columns}
        pills={pills.get(c.id)}
        selected={c.id === selectedId}
        dim={!!matchSet && !matchSet.has(i)}
        wip={c.id === WIP_ID ? wipCounts : null}
        onSelect={select}
        onMenu={(x, y) => {
          select(c.id);
          showMenu(x, y, commitMenu(c));
        }}
      />,
    );
  }

  return (
    <div className="graph">
      <div className="graph-header" style={{ gridTemplateColumns: columns }}>
        <span>Branch / Tag</span>
        <span>Graph</span>
        <span className="graph-header-msg">
          Commit message
          {!searchOpen && (
            <button className="icon-btn" title="Search commits (Ctrl+F)" onClick={() => window.dispatchEvent(new Event("gitbrix:find"))}>
              <IconSearch size={12} />
            </button>
          )}
        </span>
        <span>Author</span>
        <span>Date</span>
      </div>
      {searchOpen && (
        <div className="graph-search">
          <IconSearch size={13} />
          <input
            ref={searchRef}
            placeholder="Search message, author or SHA"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump(e.shiftKey ? -1 : 1);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setSearchOpen(false);
                setQuery("");
                scrollRef.current?.focus();
              }
            }}
          />
          <span className="search-count">
            {matches ? (matches.length ? `${matchPos >= 0 ? matchPos + 1 : "–"} of ${matches.length}` : "no matches") : ""}
          </span>
          <button className="icon-btn" title="Previous (Shift+Enter)" disabled={!matches?.length} onClick={() => jump(-1)}>
            ↑
          </button>
          <button className="icon-btn" title="Next (Enter)" disabled={!matches?.length} onClick={() => jump(1)}>
            ↓
          </button>
          <button
            className="icon-btn"
            title="Close (Esc)"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
          >
            <IconClose size={12} />
          </button>
        </div>
      )}
      <div
        className="graph-scroll"
        ref={scrollRef}
        tabIndex={0}
        data-testid="graph"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
      >
        <div className="graph-canvas-holder">
          <canvas ref={canvasRef} style={{ left: REFS_W }} />
        </div>
        <div className="graph-rows" style={{ height: commits.length * ROW_H }}>
          {rows}
        </div>
        {graph?.truncated && (
          <div className="graph-truncated">
            Showing the newest {commits.length.toLocaleString()} commits.{" "}
            <button className="link-btn" onClick={() => useStore.getState().loadMoreCommits()}>
              Load more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  commit: CommitRow;
  index: number;
  columns: string;
  pills: RefPill[] | undefined;
  selected: boolean;
  dim: boolean;
  wip: { staged: number; unstaged: number } | null;
  onSelect: (id: string) => void;
  onMenu: (x: number, y: number) => void;
}

const GraphRow = memo(function GraphRow({ commit: c, index, columns, pills, selected, dim, wip, onSelect, onMenu }: RowProps) {
  const color = laneColor(c.color);
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}${wip ? " wip" : ""}${dim ? " dim" : ""}`}
      style={{ top: index * ROW_H, height: ROW_H, gridTemplateColumns: columns }}
      data-commit={c.id}
      onMouseDown={(e) => {
        if (e.button === 0) onSelect(c.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <div className="cell refs">{pills && <Pills pills={pills} color={color} />}</div>
      <div className="cell" />
      <div className="cell message">
        {wip ? (
          <span className="wip-label">
            // WIP
            {wip.unstaged > 0 && <span className="wip-count">✎ {wip.unstaged}</span>}
            {wip.staged > 0 && <span className="wip-count staged">+ {wip.staged}</span>}
          </span>
        ) : (
          <span title={c.summary}>{c.summary}</span>
        )}
      </div>
      <div className="cell author" title={c.authorEmail}>
        {c.authorName}
      </div>
      <div className="cell date" title={c.time ? fullTime(c.time) : undefined}>
        {c.time ? relativeTime(c.time) : ""}
      </div>
    </div>
  );
});

// Show the first pill, collapse the rest into "+N".
function Pills({ pills, color }: { pills: RefPill[]; color: string }) {
  const showMenu = useStore((s) => s.showMenu);
  const [firstPill, ...rest] = pills;
  return (
    <>
      <Pill pill={firstPill} color={color} />
      {rest.length > 0 && (
        <button
          className="pill more"
          title={rest.map((p) => p.label).join("\n")}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(
              r.left,
              r.bottom + 2,
              rest.map((p) => ({ label: `Check out ${p.label}`, onSelect: () => checkoutRef(primaryRef(p)) })),
            );
          }}
        >
          +{rest.length}
        </button>
      )}
    </>
  );
}

function Pill({ pill, color }: { pill: RefPill; color: string }) {
  const showMenu = useStore((s) => s.showMenu);
  const ref = primaryRef(pill);
  return (
    <span
      className={`pill${pill.isHead ? " head" : ""}${pill.kind === "tag" ? " tag" : ""}`}
      style={{ ["--pill" as string]: color }}
      title={[pill.local?.name, ...pill.remotes.map((r) => r.name), pill.tag?.name].filter(Boolean).join(" · ")}
      onDoubleClick={() => checkoutRef(ref)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, refMenu(ref));
      }}
    >
      {pill.isHead && <span className="pill-check">✓</span>}
      <span className="pill-label">{pill.label}</span>
      {pill.kind === "tag" ? (
        <IconTag size={12} />
      ) : (
        <>
          {pill.local && <IconLaptop size={12} />}
          {pill.remotes.length > 0 && <IconCloud size={12} />}
        </>
      )}
    </span>
  );
}
