import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { api, CommitRow, errorText, WIP_ID } from "../api";
import { checkoutRef, commitMenu, multiMenu, refMenu, stashMenu } from "../actions";
import { beginDrag, dropTarget } from "../dnd";
import { laneColor } from "../colors";
import { fullTime, relativeTime, shortTime } from "../format";
import { useSettings } from "../settings";
import { drawGraph, graphWidth, ROW_H } from "../graph/draw";
import { primaryRef, RefPill, refsByCommit } from "../graph/refs";
import { useStore } from "../store";
import { IconClose, IconCloud, IconLaptop, IconSearch, IconStash, IconTag } from "./Icons";
import { useCi } from "../ci";
import { useBisect } from "../bisect";
import { CiMark } from "./CiMark";
import { Avatar } from "./Avatar";
import { avatarImage, useAvatars } from "../avatars";

const REFS_W = 190;
const MAX_GRAPH_W = 320;
const AUTHOR_W = 140;
const DATE_W = 110;
/** The message column never gets narrower than this; the graph is
 *  clipped instead (its leftmost lanes are the important ones). */
const MIN_MESSAGE_W = 220;
const OVERSCAN = 6;

type SearchMode = "message" | "files" | "code";

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
  const compareId = useStore((s) => s.compareId);
  const multi = useStore((s) => s.multi);
  const extendSelection = useStore((s) => s.extendSelection);
  const scrollRequest = useStore((s) => s.scrollRequest);
  const select = useStore((s) => s.select);
  const showMenu = useStore((s) => s.showMenu);
  // Redraw the canvas when the theme changes its colours.
  const theme = useSettings((s) => s.theme);
  // …and as author pictures arrive.
  const gravatar = useSettings((s) => s.gravatar);
  const pics = useAvatars((s) => s.pics);
  const decoded = useAvatars((s) => s.decoded);

  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const [viewW, setViewW] = useState(1000);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("message");
  const searchRef = useRef<HTMLInputElement>(null);
  // Results of a whole-history search (files / code), by commit id.
  const [remote, setRemote] = useState<{ q: string; ids: Set<string> } | null>(null);
  const [searching, setSearching] = useState(false);

  const commits = graph?.commits ?? [];
  const pills = useMemo(() => refsByCommit(graph?.refs ?? []), [graph]);
  const q = searchOpen ? query.trim().toLowerCase() : "";

  // Whole-history searches get the text as typed: `git log -S` is
  // case-sensitive (the Files mode is made case-insensitive in Rust).
  const rawQ = searchOpen ? query.trim() : "";
  useEffect(() => {
    if (mode === "message" || !rawQ || !repo) {
      setRemote(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      setSearching(true);
      api
        .searchHistory(repo.path, mode, rawQ, 2000)
        .then((ids) => live && setRemote({ q: `${mode}:${rawQ}`, ids: new Set(ids) }))
        .catch((e) => {
          if (!live) return;
          setRemote(null);
          useStore.getState().toast("error", errorText(e));
        })
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mode, rawQ, repo?.path, repo?.headOid]);
  // Results of an earlier query (still debouncing, or failed) don't count.
  const hits = remote?.q === `${mode}:${rawQ}` ? remote : null;

  const matches = useMemo(() => {
    if (!q) return null;
    const out: number[] = [];
    if (mode === "message") commits.forEach((c, i) => commitMatches(c, q) && out.push(i));
    else if (hits) commits.forEach((c, i) => hits.ids.has(c.id) && out.push(i));
    else return null;
    return out;
  }, [commits, q, mode, hits]);
  const notLoaded = mode !== "message" && hits && matches ? hits.ids.size - matches.length : 0;
  const matchSet = useMemo(() => (matches ? new Set(matches) : null), [matches]);

  // Hovering a branch label highlights its first-parent line.
  const hoveredTip = useHover((h) => h.tip);
  const branchSet = useMemo(() => {
    if (!hoveredTip) return null;
    const byId = new Map(commits.map((c) => [c.id, c]));
    const set = new Set<string>();
    for (let id: string | undefined = hoveredTip; id && !set.has(id); id = byId.get(id)?.parents[0]) set.add(id);
    return set;
  }, [hoveredTip, commits]);
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
  // Narrow windows drop the author, then the date column, and squeeze the
  // ref column, before the message column gets too small to read.
  const authorW = viewW >= 720 ? AUTHOR_W : 0;
  const dateW = viewW >= 600 ? DATE_W : 0;
  const refsW = Math.round(Math.max(110, Math.min(REFS_W, viewW * 0.24)));
  const room = viewW - refsW - authorW - dateW - MIN_MESSAGE_W;
  const gw = Math.max(64, Math.min(MAX_GRAPH_W, graphWidth(graph?.maxLanes ?? 1), room));
  const columns = [`${refsW}px`, `${gw}px`, "minmax(0, 1fr)", authorW && `${authorW}px`, dateW && `${dateW}px`]
    .filter(Boolean)
    .join(" ");
  // Stable object, so memoised rows don't all re-render on every scroll.
  const show = useMemo(() => ({ author: authorW > 0, date: dateW > 0 }), [authorW, dateW]);

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

  // Rows (and the drawing) a screen beyond what's shown on each side: the
  // view scrolls before the scroll event reaches us, and what it uncovers
  // should already be there.
  const pad = Math.max(OVERSCAN, Math.ceil(viewH / ROW_H));
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - pad);
  const last = Math.min(commits.length - 1, Math.ceil((scrollTop + viewH) / ROW_H) + pad);
  // The drawing is a band over rows first..last that scrolls with them.
  const bandH = Math.max(0, last - first + 1) * ROW_H;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(gw * dpr);
    canvas.height = Math.round(bandH * dpr);
    canvas.style.width = `${gw}px`;
    canvas.style.height = `${bandH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraph(ctx, {
      commits,
      first,
      last,
      scrollTop: first * ROW_H,
      width: gw,
      height: bandH,
      selectedId,
      headId: repo?.headOid ?? null,
      background: cssVar("--bg-graph", "#16181e"),
      nodeText: cssVar("--node-text", "#0d0f14"),
      ring: cssVar("--node-ring", "#ffffff"),
      avatar: gravatar ? avatarImage : undefined,
    });
  }, [commits, first, last, bandH, gw, selectedId, repo?.headOid, theme, gravatar, pics, decoded]);

  // Reaching the end of a truncated history loads the next page.
  const truncated = graph?.truncated ?? false;
  useEffect(() => {
    if (truncated && commits.length > 0 && last >= commits.length - 20 && !useStore.getState().busy) {
      void useStore.getState().loadMoreCommits();
    }
  }, [truncated, last, commits.length]);

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
        show={show}
        pills={pills.get(c.id)}
        selected={c.id === selectedId || multi.includes(c.id)}
        compared={c.id === compareId}
        dim={matchSet ? !matchSet.has(i) : !!branchSet && !branchSet.has(c.id)}
        wip={c.id === WIP_ID ? wipCounts : null}
        onSelect={(id, mods) => (mods ? extendSelection(id, mods === "range") : select(id))}
        onMenu={(x, y) => {
          if (multi.includes(c.id)) {
            showMenu(x, y, multiMenu(multi));
            return;
          }
          select(c.id);
          const stash = c.kind === "stash" ? useStore.getState().stashes.find((st) => st.id === c.id) : undefined;
          showMenu(x, y, stash ? stashMenu(stash) : commitMenu(c));
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
        {show.author && <span>Author</span>}
        {show.date && <span>Date</span>}
      </div>
      <FilterBanner />
      {searchOpen && (
        <div className="graph-search">
          <span className="segmented search-mode">
            {(["message", "files", "code"] as const).map((m) => (
              <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
                {m === "message" ? "Message" : m === "files" ? "Files" : "Code"}
              </button>
            ))}
          </span>
          <input
            ref={searchRef}
            placeholder={
              mode === "message" ? "Search message, author or SHA" : mode === "files" ? "File path contains… (all history)" : "Text added or removed… (all history)"
            }
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
            {searching
              ? "searching…"
              : matches
                ? (matches.length ? `${matchPos >= 0 ? matchPos + 1 : "–"} of ${matches.length}` : "no matches") +
                  (notLoaded > 0 ? ` · ${notLoaded} older not loaded` : "")
                : ""}
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
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
          // A label scrolled away under the mouse never gets mouseleave.
          if (useHover.getState().tip) useHover.setState({ tip: null });
        }}
        onKeyDown={onKeyDown}
      >
        <div className="graph-canvas-holder" style={{ top: first * ROW_H }}>
          <canvas ref={canvasRef} style={{ left: refsW }} />
        </div>
        <div className="graph-rows" style={{ height: commits.length * ROW_H }}>
          {rows}
        </div>
        {commits.length === 0 && (
          <div className="graph-empty">
            <strong>No commits yet.</strong>
            <span>Add or edit files in this folder — they show up here, ready to stage and commit.</span>
          </div>
        )}
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
  show: { author: boolean; date: boolean };
  pills: RefPill[] | undefined;
  selected: boolean;
  compared: boolean;
  dim: boolean;
  wip: { staged: number; unstaged: number } | null;
  /** `toggle`: Ctrl held, `range`: Shift held — add to the selection. */
  onSelect: (id: string, mods: "toggle" | "range" | null) => void;
  onMenu: (x: number, y: number) => void;
}

const GraphRow = memo(function GraphRow({ commit: c, index, columns, show, pills, selected, compared, dim, wip, onSelect, onMenu }: RowProps) {
  const color = laneColor(c.color);
  const dateFormat = useSettings((s) => s.dateFormat);
  const ci = useCi((s) => s.statuses[c.id]);
  const bisect = useBisect((s) => {
    const b = s.status;
    if (b) return b.found === c.id ? "first bad" : b.bad === c.id ? "bad" : b.good.includes(c.id) ? "good" : b.skipped.includes(c.id) ? "skipped" : b.current === c.id ? "testing" : null;
    return s.pending?.id === c.id ? s.pending.verdict : null;
  });
  return (
    <div
      className={`graph-row${selected ? " selected" : ""}${compared ? " compared" : ""}${wip ? " wip" : ""}${dim ? " dim" : ""}`}
      style={{ top: index * ROW_H, height: ROW_H, gridTemplateColumns: columns }}
      data-commit={c.id}
      ref={dropTarget({ kind: "commit", commit: c })}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        onSelect(c.id, e.shiftKey ? "range" : e.ctrlKey || e.metaKey ? "toggle" : null);
        if (c.kind === "stash") {
          const stash = useStore.getState().stashes.find((st) => st.id === c.id);
          if (stash) beginDrag(e, { kind: "stash", stash }, stash.message);
        } else if (!wip) {
          beginDrag(e, { kind: "commit", commit: c }, `${c.id.slice(0, 7)} ${c.summary}`);
        }
      }}
      onDoubleClick={() => {
        // Double-click a commit that has a local branch: check it out.
        const local = pills?.find((p) => p.local)?.local;
        if (local && !local.isHead) void checkoutRef(local);
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
        ) : c.kind === "stash" ? (
          <span className="stash-row" title={c.summary}>
            <IconStash size={12} /> {c.summary}
          </span>
        ) : (
          <>
            {ci && <CiMark state={ci.state} url={ci.url} />}
            {bisect && <span className={`bisect-mark ${bisect.replace(" ", "-")}`}>{bisect}</span>}
            <span title={`${c.summary}\n${c.id.slice(0, 10)} · ${c.authorName}`}>{c.summary}</span>
          </>
        )}
      </div>
      {show.author && (
        <div className="cell author" title={c.authorEmail}>
          {c.kind === "commit" && <Avatar email={c.authorEmail} name={c.authorName} size={16} />}
          <span className="author-name">{c.authorName}</span>
        </div>
      )}
      {show.date && (
        <div className="cell date" title={c.time ? fullTime(c.time) : undefined}>
          {c.time ? (dateFormat === "relative" ? relativeTime(c.time) : shortTime(c.time)) : ""}
        </div>
      )}
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

/** The branch tip under the mouse, for highlighting its history. */
const useHover = create<{ tip: string | null }>(() => ({ tip: null }));

function Pill({ pill, color }: { pill: RefPill; color: string }) {
  const showMenu = useStore((s) => s.showMenu);
  const ref = primaryRef(pill);
  return (
    <span
      className={`pill${pill.isHead ? " head" : ""}${pill.kind === "tag" ? " tag" : ""}`}
      style={{ ["--pill" as string]: color }}
      ref={dropTarget({ kind: "ref", ref })}
      data-ref={ref.fullName}
      onMouseEnter={() => useHover.setState({ tip: ref.target })}
      onMouseLeave={() => useHover.setState({ tip: null })}
      onMouseDown={(e) => beginDrag(e, { kind: "ref", ref }, ref.name)}
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

function FilterBanner() {
  const filter = useStore((s) => s.graphFilter);
  const setGraphFilter = useStore((s) => s.setGraphFilter);
  const n = filter.solo.length || filter.hidden.length;
  if (!n) return null;
  const names = (filter.solo.length ? filter.solo : filter.hidden).map((f) => f.replace(/^refs\/(heads|remotes|tags)\//, ""));
  return (
    <div className="filter-banner" title={names.join("\n")}>
      {filter.solo.length
        ? `Showing only ${names.join(", ")} and the checked-out branch`
        : `${n} branch${n === 1 ? "" : "es"} hidden (the checked-out branch always shows)`}
      <button className="link-btn" onClick={() => setGraphFilter({ hidden: [], solo: [] })}>
        Show all
      </button>
    </div>
  );
}
