import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import "./App.css";
import { WIP_ID } from "./api";
import { CommandPalette, usePalette } from "./components/CommandPalette";
import { CommitGraph } from "./components/CommitGraph";
import { CommitPanel } from "./components/CommitPanel";
import { ConflictView } from "./components/ConflictView";
import { DiffView } from "./components/DiffView";
import { BlameView, HistoryView } from "./components/FileViews";
import { OperationBanner } from "./components/OperationBanner";
import { ContextMenu, Dialog, Toasts } from "./components/Overlays";
import { RebaseView } from "./components/RebaseView";
import { RepoDialogs } from "./components/RepoDialogs";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { Toolbar } from "./components/Toolbar";
import { WipPanel } from "./components/WipPanel";
import { openRepoDialog, Welcome } from "./components/Welcome";
import { useStore } from "./store";
import { undoLast } from "./undo";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
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

export default function App() {
  const repo = useStore((s) => s.repo);
  const selectedId = useStore((s) => s.selectedId);
  const diffSource = useStore((s) => s.diffSource);
  useGlobalKeys();

  return (
    <div className="app">
      <TabBar />
      {repo ? (
        <>
          <Toolbar />
          <div className="main">
            <Sidebar />
            <section className="center">
              <OperationBanner />
              {diffSource?.kind === "conflict" ? (
                <ConflictView />
              ) : diffSource?.kind === "history" ? (
                <HistoryView />
              ) : diffSource?.kind === "blame" ? (
                <BlameView />
              ) : diffSource?.kind === "rebase" ? (
                <RebaseView />
              ) : diffSource ? (
                <DiffView />
              ) : (
                <CommitGraph />
              )}
            </section>
            <aside className="details">
              {selectedId === WIP_ID ? <WipPanel /> : selectedId ? <CommitPanel /> : <div className="panel-loading">Select a commit</div>}
            </aside>
          </div>
        </>
      ) : (
        <Welcome />
      )}
      <ContextMenu />
      <CommandPalette />
      <RepoDialogs />
      <Dialog />
      <Toasts />
    </div>
  );
}
