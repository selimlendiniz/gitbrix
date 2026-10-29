import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import "./App.css";
import { WIP_ID } from "./api";
import { CommitGraph } from "./components/CommitGraph";
import { CommitPanel } from "./components/CommitPanel";
import { DiffView } from "./components/DiffView";
import { ContextMenu, Dialog, Toasts } from "./components/Overlays";
import { Sidebar } from "./components/Sidebar";
import { Toolbar } from "./components/Toolbar";
import { WipPanel } from "./components/WipPanel";
import { openRepoDialog, Welcome } from "./components/Welcome";
import { useStore } from "./store";

function useGlobalKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.key === "F5" || (e.key === "r" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        void s.refresh();
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
    const unlisten = listen<string>("repo-changed", (e) => {
      const s = useStore.getState();
      if (s.repo?.path === e.payload && !s.busy) void s.refresh();
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("focus", onFocus);
      void unlisten.then((f) => f()).catch(() => {});
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
      {repo ? (
        <>
          <Toolbar />
          <div className="main">
            <Sidebar />
            <section className="center">{diffSource ? <DiffView /> : <CommitGraph />}</section>
            <aside className="details">
              {selectedId === WIP_ID ? <WipPanel /> : selectedId ? <CommitPanel /> : <div className="panel-loading">Select a commit</div>}
            </aside>
          </div>
        </>
      ) : (
        <Welcome />
      )}
      <ContextMenu />
      <Dialog />
      <Toasts />
    </div>
  );
}
