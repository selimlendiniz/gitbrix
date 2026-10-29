// Open repository tabs, remembered across restarts in localStorage.

const KEY = "gitbrix.tabs";

export interface Tab {
  path: string;
  name: string;
}

export function loadTabs(): { tabs: Tab[]; active: string | null } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && Array.isArray(raw.tabs)) return { tabs: raw.tabs, active: raw.active ?? null };
  } catch {
    // fall through
  }
  return { tabs: [], active: null };
}

export function saveTabs(tabs: Tab[], active: string | null) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tabs, active }));
  } catch {
    // ignore
  }
}
