// The window's title bar (the system one is turned off in tauri.conf.json):
// the app menu, the pinned Workspaces tab, repository tabs (with their
// changes and commits to push or pull), empty space to drag the window by
// (double-click maximizes) with the search box in it, the title bar
// buttons, and the window buttons.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { copy, moveTabToWindow } from "../actions";
import { api } from "../api";
import { useStore } from "../store";
import { loadTabSummaries, markOf, TabMark, useTabSummaries } from "../tabStatus";
import { hideWorkspaces, showWorkspaces, useWorkspaces } from "../workspaces";
import { IconChevron, IconClose, IconPlus, IconWorkspace } from "./Icons";
import { AccountButton, ActivityButton, AppMenu, InboxBell, TitleSearch } from "./TitlebarItems";

function useMaximized() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const update = () => void win.isMaximized().then(setMaximized, () => {});
    update();
    let unlisten: (() => void) | undefined;
    win
      .onResized(update)
      .then((f) => (unlisten = f))
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  return maximized;
}

function WindowControls() {
  const maximized = useMaximized();
  const win = () => getCurrentWindow();
  return (
    <div className="window-controls">
      <button className="window-btn" title="Minimize" aria-label="Minimize" onClick={() => void win().minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 5.5h8" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <button
        className="window-btn"
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void win().toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M3 1.5h5.5V7M1.5 3h5.5v5.5H1.5z" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </button>
      <button className="window-btn close" title="Close" aria-label="Close" onClick={() => void win().close()}>
        <IconClose size={11} />
      </button>
    </div>
  );
}

/** The open repository's marks, live from the store. */
function useLiveMark(): TabMark | null {
  const repo = useStore((s) => s.repo);
  const status = useStore((s) => s.status);
  if (!repo) return null;
  return {
    changes: status ? status.staged.length + status.unstaged.length : 0,
    conflicts: status?.conflicted.length ?? 0,
    ahead: repo.ahead,
    behind: repo.behind,
  };
}

function markTitle(m: TabMark): string {
  const parts = [
    m.conflicts && `${m.conflicts} conflicted file${m.conflicts === 1 ? "" : "s"}`,
    m.changes && `${m.changes} uncommitted change${m.changes === 1 ? "" : "s"}`,
    m.ahead && `${m.ahead} commit${m.ahead === 1 ? "" : "s"} to push`,
    m.behind && `${m.behind} commit${m.behind === 1 ? "" : "s"} to pull`,
  ].filter(Boolean);
  return parts.join(", ");
}

function TabMarks({ mark }: { mark: TabMark | null }) {
  if (!mark || (!mark.changes && !mark.conflicts && !mark.ahead && !mark.behind)) return null;
  return (
    <span className="tab-marks" title={markTitle(mark)}>
      {(mark.changes > 0 || mark.conflicts > 0) && <span className={`tab-dirty${mark.conflicts ? " conflict" : ""}`} />}
      {mark.ahead > 0 && <span className="tab-ahead">↑{mark.ahead}</span>}
      {mark.behind > 0 && <span className="tab-behind">↓{mark.behind}</span>}
    </span>
  );
}

/** Whether the tabs are wider than their room, to offer the full list. */
function useOverflow(ref: React.RefObject<HTMLElement | null>, deps: unknown[]): boolean {
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOver(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return over;
}

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const repo = useStore((s) => s.repo);
  const busy = useStore((s) => s.busy);
  const openRepo = useStore((s) => s.openRepo);
  const closeTab = useStore((s) => s.closeTab);
  const closeRepo = useStore((s) => s.closeRepo);
  const onWorkspaces = useWorkspaces((s) => s.open);
  const summaries = useTabSummaries((s) => s.byPath);
  const live = useLiveMark();
  const nav = useRef<HTMLElement>(null);
  const overflow = useOverflow(nav, [tabs.length]);

  // Other tabs' marks: at start, and when the app comes back to the front.
  useEffect(() => {
    loadTabSummaries();
    window.addEventListener("focus", loadTabSummaries);
    return () => window.removeEventListener("focus", loadTabSummaries);
  }, []);

  // The active tab stays in view when the tabs scroll.
  const activePath = onWorkspaces ? null : repo?.path;
  useEffect(() => {
    nav.current?.querySelector(".tab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activePath]);

  const switchTo = (path: string) => {
    if (busy || (!onWorkspaces && path === repo?.path)) return;
    hideWorkspaces();
    if (path !== repo?.path) void openRepo(path);
  };

  return (
    <header className="tabbar titlebar" data-tauri-drag-region>
      <AppMenu onQuit={() => void api.quitApp()} onCloseWindow={() => void getCurrentWindow().close()} />
      <nav
        className="tabs"
        role="tablist"
        ref={nav}
        data-tauri-drag-region
        onWheel={(e) => {
          // A mouse wheel scrolls the tabs sideways.
          if (nav.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) nav.current.scrollLeft += e.deltaY;
        }}
      >
        {/* Pinned: always first, can't be closed. */}
        <div
          role="tab"
          aria-selected={onWorkspaces}
          className={`tab pinned${onWorkspaces ? " active" : ""}`}
          title="Workspaces"
          onClick={showWorkspaces}
        >
          <IconWorkspace size={13} />
          <span className="tab-name">Workspaces</span>
        </div>
        {tabs.map((t) => {
          const active = !onWorkspaces && t.path === repo?.path;
          const mark = t.path === repo?.path ? live : markOf(summaries[t.path]);
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active}
              className={`tab${active ? " active" : ""}`}
              title={t.path}
              onClick={() => switchTo(t.path)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                useStore.getState().showMenu(e.clientX, e.clientY, [
                  { label: "Move to new window", onSelect: () => moveTabToWindow(t.path) },
                  { separator: true, label: "" },
                  { label: "Close tab", onSelect: () => closeTab(t.path) },
                  {
                    label: "Close other tabs",
                    disabled: tabs.length < 2,
                    onSelect: () => tabs.filter((o) => o.path !== t.path).forEach((o) => closeTab(o.path)),
                  },
                  { separator: true, label: "" },
                  { label: "Copy path", onSelect: () => copy(t.path) },
                ]);
              }}
            >
              <span className="tab-name">{t.name}</span>
              <TabMarks mark={mark} />
              <button
                className="tab-close"
                title="Close tab"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.path);
                }}
              >
                <IconClose size={10} />
              </button>
            </div>
          );
        })}
        <button
          className="tab-new"
          title="Open another repository"
          onClick={() => {
            if (busy) return;
            hideWorkspaces();
            closeRepo();
          }}
        >
          <IconPlus size={12} />
        </button>
      </nav>
      {overflow && (
        <button
          className="tab-overflow"
          title="All tabs"
          aria-label="All tabs"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            useStore.getState().showMenu(r.left, r.bottom + 4, [
              { label: `${onWorkspaces ? "✓ " : ""}Workspaces`, onSelect: showWorkspaces },
              { separator: true, label: "" },
              ...tabs.map((t) => {
                const mark = t.path === repo?.path ? live : markOf(summaries[t.path]);
                const active = !onWorkspaces && t.path === repo?.path;
                return {
                  label: `${active ? "✓ " : ""}${t.name}`,
                  hint: mark ? [mark.changes ? "●" : "", mark.ahead ? `↑${mark.ahead}` : "", mark.behind ? `↓${mark.behind}` : ""].filter(Boolean).join(" ") || undefined : undefined,
                  onSelect: () => switchTo(t.path),
                };
              }),
            ]);
          }}
        >
          <IconChevron size={11} style={{ transform: "rotate(90deg)" }} />
        </button>
      )}
      <div className="titlebar-drag" data-tauri-drag-region>
        <TitleSearch />
      </div>
      <div className="title-buttons">
        <ActivityButton />
        <InboxBell />
        <AccountButton />
      </div>
      <WindowControls />
    </header>
  );
}
