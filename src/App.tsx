import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useLayoutEffect, useState } from "react";

import "./App.css";
import { WIP_ID } from "./api";
import { CommandPalette, usePalette } from "./components/CommandPalette";
import { CommitGraph } from "./components/CommitGraph";
import { CommitPanel } from "./components/CommitPanel";
import { ComparePanel } from "./components/ComparePanel";
import { ConflictView } from "./components/ConflictView";
import { DiffView } from "./components/DiffView";
import { BlameView, HistoryView } from "./components/FileViews";
import { OperationBanner } from "./components/OperationBanner";
import { ContextMenu, Dialog, Toasts } from "./components/Overlays";
import { RebaseView } from "./components/RebaseView";
import { ReflogView } from "./components/ReflogView";
import { RepoDialogs } from "./components/RepoDialogs";
import { DragGhost } from "./components/DragGhost";
import { PullRequestsDialog } from "./components/PullRequestsDialog";
import { CreatePullRequestDialog } from "./components/CreatePullRequest";
import { PullRequestPanel } from "./components/PullRequestPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { ShortcutsDialog, useShortcuts } from "./components/ShortcutsDialog";
import { Sidebar } from "./components/Sidebar";
import { Splitter } from "./components/Splitter";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { WipPanel } from "./components/WipPanel";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import { TerminalPanel } from "./components/TerminalPanel";
import { toggleTerminal } from "./terminal";
import { openRepoDialog, Welcome } from "./components/Welcome";
import { effectiveTheme, updateSettings, useSettings } from "./settings";
import { useStore } from "./store";
import { undoLast } from "./undo";
import { backgroundFetch } from "./actions";
import { loadInbox, loadPrs, usePrView } from "./prs";
import { loadIdentity, loadProfiles } from "./profiles";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "`" || e.code === "Backquote") && s.repo) {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      // Keys typed into the terminal belong to the shell (Ctrl+R, Ctrl+K…).
      if ((e.target as HTMLElement | null)?.closest?.(".terminal-panel")) return;
      if ((mod && e.key.toLowerCase() === "k") || (mod && e.shiftKey && e.key.toLowerCase() === "p")) {
        e.preventDefault();
        usePalette.setState((p) => ({ open: !p.open }));
      } else if (e.key === "F5" || (e.key === "r" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void s.refresh();
      } else if (e.key === "f" && (e.ctrlKey || e.metaKey) && s.repo) {
        e.preventDefault();
        s.closeDiff();
        window.dispatchEvent(new Event("gitbrix:find"));
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey && s.repo && !isTyping(e)) {
        e.preventDefault();
        void undoLast();
      } else if (e.key === "?" && !isTyping(e)) {
        useShortcuts.setState({ open: true });
      } else if (e.key === "Escape" && s.diffSource && !s.dialog && !s.menu) {
        s.closeDiff();
      } else if (e.key === "o" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void openRepoDialog();
      }
    };
    // Something may have changed outside the app (terminal, editor).
    const onFocus = () => void useStore.getState().refresh();
    window.addEventListener("keydown", onKey);
    window.addEventListener("focus", onFocus);
    // The backend watcher reports changes made outside the app. An
    // operation in progress refreshes when it finishes anyway.
    const unlisten = listen<{ path: string; git: boolean }>("repo-changed", (e) => {
      const s = useStore.getState();
      if (s.repo?.path === e.payload.path && !s.busy) void s.refresh(e.payload.git ? "all" : "status");
    });
    const unlistenProgress = listen<string>("git-progress", (e) => useStore.setState({ progress: e.payload }));
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      void unlisten.then((f) => f()).catch(() => {});
      void unlistenProgress.then((f) => f()).catch(() => {});
    };
  }, []);
}

function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** Drop a folder on the window to open it as a repository. */
function useFolderDrop() {
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return; // browser mode
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "drop" && e.payload.paths[0]) void useStore.getState().openRepo(e.payload.paths[0]);
      })
      .then((f) => (unlisten = f))
      .catch(() => {});
    return () => unlisten?.();
  }, []);
}

function useAutoFetch() {
  const minutes = useSettings((s) => s.autoFetch);
  const repoPath = useStore((s) => s.repo?.path);
  useEffect(() => {
    if (!minutes || !repoPath) return;
    const id = setInterval(() => void backgroundFetch(), minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes, repoPath]);
}

/** Pull/merge requests: the open repository's on switching to it, the
 * account-wide list at start, and both (every open tab) on a timer so new
 * ones raise a notification. */
function usePullRequests() {
  const minutes = useSettings((s) => s.prPoll);
  const repoPath = useStore((s) => s.repo?.path);
  useEffect(() => {
    if (repoPath) void loadPrs(repoPath);
  }, [repoPath]);
  useEffect(() => {
    void loadInbox();
  }, []);
  useEffect(() => {
    if (!minutes) return;
    const id = setInterval(() => {
      void loadInbox();
      for (const tab of useStore.getState().tabs) void loadPrs(tab.path);
    }, minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes]);
}

/** Profiles at start; the open repository's commit identity on switching. */
function useProfiles() {
  const repoPath = useStore((s) => s.repo?.path ?? null);
  useEffect(() => {
    void loadProfiles();
  }, []);
  useEffect(() => {
    void loadIdentity(repoPath);
  }, [repoPath]);
}

function useTheme() {
  const theme = useSettings((s) => s.theme);
  // Layout effect: the attribute must be set before children's effects
  // draw the graph canvas with the theme's colours.
  useLayoutEffect(() => {
    const apply = () => (document.documentElement.dataset.theme = effectiveTheme(theme));
    apply();
    if (theme !== "system") return;
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    mq?.addEventListener("change", apply);
    return () => mq?.removeEventListener("change", apply);
  }, [theme]);
}

export default function App() {
  const repo = useStore((s) => s.repo);
  const winW = useWindowWidth();
  // In narrow windows the side panels give way so the graph keeps room.
  const sidebarWidth = Math.min(useSettings((s) => s.sidebarWidth), Math.round(winW * 0.22));
  const detailsWidth = Math.min(useSettings((s) => s.detailsWidth), Math.round(winW * 0.34));
  useTheme();
  useAutoFetch();
  usePullRequests();
  useProfiles();
  useFolderDrop();
  const selectedId = useStore((s) => s.selectedId);
  const compareId = useStore((s) => s.compareId);
  const diffSource = useStore((s) => s.diffSource);
  const prView = usePrView((s) => s.pr);
  useGlobalKeys();

  return (
    <div className="app">
      <TabBar />
      {repo ? (
        <>
          <Toolbar />
          <div className="main" style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${detailsWidth}px` }}>
            <Sidebar />
            <div className="splitter-wrap" style={{ left: sidebarWidth }}>
              <Splitter width={sidebarWidth} side="left" min={170} max={480} onChange={(w) => updateSettings({ sidebarWidth: w })} />
            </div>
            <div className="splitter-wrap" style={{ right: detailsWidth }}>
              <Splitter width={detailsWidth} side="right" min={300} max={720} onChange={(w) => updateSettings({ detailsWidth: w })} />
            </div>
            <section className="center">
              <OperationBanner />
              <div className="center-view">
              {diffSource?.kind === "conflict" ? (
                <ConflictView />
              ) : diffSource?.kind === "history" ? (
                <HistoryView />
              ) : diffSource?.kind === "blame" ? (
                <BlameView />
              ) : diffSource?.kind === "rebase" ? (
                <RebaseView />
              ) : diffSource?.kind === "reflog" ? (
                <ReflogView />
              ) : diffSource ? (
                <DiffView />
              ) : (
                <CommitGraph />
              )}
              </div>
              <TerminalPanel />
            </section>
            <aside className="details">
              {prView ? (
                <PullRequestPanel />
              ) : compareId ? (
                <ComparePanel />
              ) : selectedId === WIP_ID ? (
                <WipPanel />
              ) : selectedId ? (
                <CommitPanel />
              ) : (
                <div className="panel-loading">Select a commit</div>
              )}
            </aside>
          </div>
        </>
      ) : (
        <Welcome />
      )}
      <ContextMenu />
      <CommandPalette />
      <SettingsDialog />
      <PullRequestsDialog />
      <CreatePullRequestDialog />
      <WorkspaceDialog />
      <DragGhost />
      <ShortcutsDialog />
      <RepoDialogs />
      <Dialog />
      <Toasts />
    </div>
  );
}
