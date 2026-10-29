// User preferences, kept in localStorage (per machine).

import { create } from "zustand";

import { PullMode } from "./api";

export interface Settings {
  theme: "dark" | "light" | "system";
  pullMode: PullMode;
  dateFormat: "relative" | "absolute";
  sidebarWidth: number;
  detailsWidth: number;
}

const KEY = "gitbrix.settings";

export const DEFAULTS: Settings = {
  theme: "dark",
  pullMode: "ff-only",
  dateFormat: "relative",
  sidebarWidth: 240,
  detailsWidth: 380,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

export const useSettings = create<Settings>(load);

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
