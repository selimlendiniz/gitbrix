// More windows: each shows its own tabs. The first window ("main") keeps
// the tabs across restarts; the others start from the repository they
// were opened for and are forgotten when closed.

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";

import { errorText } from "./api";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/** This window's label when it isn't the main one. */
export const windowLabel: string | null = params.get("window");

/** The repository a new window was opened for. */
export const windowRepo: string | null = params.get("repo");

export const isMainWindow = windowLabel === null;

/** A new window, showing `repo` if given (else the Workspaces tab). */
export function openWindow(repo?: string, onError?: (text: string) => void) {
  const label = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const query = new URLSearchParams({ window: label, ...(repo ? { repo } : {}) });
  const w = new WebviewWindow(label, {
    url: `/?${query}`,
    title: repo ? `${repo.split("/").pop()} — gitbrix` : "gitbrix",
    width: 1300,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    decorations: false,
  });
  void w.once("tauri://error", (e) => onError?.(errorText(e.payload)));
}
