// The window's title bar (the system one is turned off in tauri.conf.json):
// the pinned Workspaces tab, repository tabs, empty space to drag the
// window by (double-click maximizes), and the window buttons.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

import { useStore } from "../store";
import { hideWorkspaces, showWorkspaces, useWorkspaces } from "../workspaces";
import { IconClose, IconPlus, IconWorkspace } from "./Icons";

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

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const repo = useStore((s) => s.repo);
  const busy = useStore((s) => s.busy);
  const openRepo = useStore((s) => s.openRepo);
  const closeTab = useStore((s) => s.closeTab);
  const closeRepo = useStore((s) => s.closeRepo);
  const onWorkspaces = useWorkspaces((s) => s.open);

  return (
    <header className="tabbar titlebar" data-tauri-drag-region>
      <nav className="tabs" role="tablist" data-tauri-drag-region>
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
          return (
            <div
              key={t.path}
              role="tab"
              aria-selected={active}
              className={`tab${active ? " active" : ""}`}
              title={t.path}
              onClick={() => {
                if (busy || active) return;
                hideWorkspaces();
                if (t.path !== repo?.path) void openRepo(t.path);
              }}
              onAuxClick={(e) => e.button === 1 && closeTab(t.path)}
            >
              <span className="tab-name">{t.name}</span>
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
      <div className="titlebar-drag" data-tauri-drag-region />
      <WindowControls />
    </header>
  );
}
