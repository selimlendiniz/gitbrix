// Open repository tabs, remembered across restarts in localStorage. Only
// the main window's: other windows' tabs last as long as the window.

import { isMainWindow } from "./windows";

const KEY = "gitbrix.tabs";

export interface Tab {
  path: string;
  name: string;
}

export function loadTabs(): { tabs: Tab[]; active: string | null } {
  if (!isMainWindow) return { tabs: [], active: null };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && Array.isArray(raw.tabs)) return { tabs: raw.tabs, active: raw.active ?? null };
  } catch {
    // fall through
  }
  return { tabs: [], active: null };
}

export function saveTabs(tabs: Tab[], active: string | null) {
  if (!isMainWindow) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs, active }));
  } catch {
    // ignore
  }
}
