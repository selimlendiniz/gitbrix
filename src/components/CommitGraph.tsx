import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CommitRow, WIP_ID } from "../api";
import { checkoutRef, commitMenu, refMenu } from "../actions";
import { laneColor } from "../colors";
import { relativeTime, fullTime } from "../format";
import { drawGraph, graphWidth, ROW_H } from "../graph/draw";
import { primaryRef, RefPill, refsByCommit } from "../graph/refs";
import { useStore } from "../store";
import { IconCloud, IconLaptop, IconTag } from "./Icons";

const REFS_W = 190;
const MAX_GRAPH_W = 320;
const OVERSCAN = 6;

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

  const commits = graph?.commits ?? [];
  const pills = useMemo(() => refsByCommit(graph?.refs ?? []), [graph]);
  const gw = Math.min(MAX_GRAPH_W, graphWidth(graph?.maxLanes ?? 1));

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
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
        graphW={gw}
        pills={pills.get(c.id)}
        selected={c.id === selectedId}
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
      <div className="graph-header" style={{ gridTemplateColumns: `${REFS_W}px ${gw}px 1fr 160px 120px` }}>
        <span>Branch / Tag</span>
        <span>Graph</span>
        <span>Commit message</span>
        <span>Author</span>
        <span>Date</span>
      </div>
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
          <div className="graph-truncated">Showing the newest {commits.length.toLocaleString()} commits.</div>
        )}
      </div>
    </div>
  );
}

interface RowProps {
  commit: CommitRow;
  index: number;
  graphW: number;
  pills: RefPill[] | undefined;
  selected: boolean;
  wip: { staged: number; unstaged: number } | null;
  onSelect: (id: string) => void;
  onMenu: (x: number, y: number) => void;
}

const GraphRow = memo(function GraphRow({ commit: c, index, graphW, pills, selected, wip, onSelect, onMenu }: RowProps) {
  const color = laneColor(c.color);
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}${wip ? " wip" : ""}`}
      style={{ top: index * ROW_H, height: ROW_H, gridTemplateColumns: `${REFS_W}px ${graphW}px 1fr 160px 120px` }}
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
