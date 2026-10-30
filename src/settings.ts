// User preferences, kept in localStorage (per machine).

import { create } from "zustand";

import { PullMode } from "./api";

export interface Settings {
  theme: "dark" | "light" | "system";
  pullMode: PullMode;
  dateFormat: "relative" | "absolute";
  fileView: "list" | "tree";
  /** Hide whitespace-only changes in commit and comparison diffs. */
  ignoreWhitespace: boolean;
  /** When local changes block a checkout, pull or merge: ask to stash
   *  them around it, or always do. */
  autoStash: "ask" | "always";
  /** Minutes between background fetches; 0 = off. */
  autoFetch: number;
  /** Minutes between pull/merge request checks; 0 = only on open. */
  prPoll: number;
  /** Desktop notification for new requests the user can approve. */
  prNotify: boolean;
  /** Desktop notification for comments on the user's requests and mentions. */
  commentNotify: boolean;
  /** Author pictures from Gravatar (sends a hash of each address). */
  gravatar: boolean;
  /** Where releases are announced (`latest.json`); empty = no updates. */
  updateUrl: string;
  /** Look for a newer version when the app starts. */
  updateCheck: boolean;
  sidebarWidth: number;
  detailsWidth: number;
  terminalHeight: number;
}

const KEY = "gitbrix.settings";

export const DEFAULTS: Settings = {
  theme: "dark",
  pullMode: "ff-only",
  dateFormat: "relative",
  fileView: "list",
  ignoreWhitespace: false,
  // Off by default: with a passphrase-protected ssh key not in an agent,
  // a background fetch would pop up a password prompt every time.
  autoFetch: 0,
  autoStash: "ask",
  prPoll: 3,
  prNotify: true,
  commentNotify: true,
  gravatar: true,
  updateUrl: "",
  updateCheck: true,
  sidebarWidth: 240,
  detailsWidth: 380,
  terminalHeight: 240,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export const useSettings = create<Settings>(load);

// Changed in another window.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) useSettings.setState(load());
  });
}

export function updateSettings(patch: Partial<Settings>) {
  useSettings.setState(patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(useSettings.getState()));
  } catch {
    // ignore
  }
}

/** Resolve "system" against the OS preference. */
export function effectiveTheme(theme: Settings["theme"]): "dark" | "light" {
  if (theme !== "system") return theme;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
