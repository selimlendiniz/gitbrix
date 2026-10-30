import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { api } from "./api";
import { useStore } from "./store";
import { loadTabs } from "./tabs";
import { hideWorkspaces, openInBackground, showWorkspaces } from "./workspaces";

declare global {
  interface Window {
    /** For tests and debugging from the devtools console. */
    __gitbrixStore: typeof useStore;
  }
}

async function start() {
  window.__gitbrixStore = useStore;
  // Outside Tauri (plain browser, UI tests) there is no Rust backend:
  // answer IPC calls from a recorded fixture instead.
  if (!("__TAURI_INTERNALS__" in window)) {
    const { installMocks } = await import("./mock/mock");
    await installMocks();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
  // A path on the command line opens that repository; otherwise the app
  // starts on the Workspaces tab with the last session's repository behind it.
  const initial = await api.initialRepo().catch(() => null);
  const { active } = loadTabs();
  if (initial) {
    hideWorkspaces();
    void useStore.getState().openRepo(initial);
  } else {
    showWorkspaces();
    if (active) void openInBackground(active);
  }
}

void start();
