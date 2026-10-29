import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { api } from "./api";
import { useStore } from "./store";

async function start() {
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
  const initial = await api.initialRepo().catch(() => null);
  if (initial) void useStore.getState().openRepo(initial);
}

void start();
