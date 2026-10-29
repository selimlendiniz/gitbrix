// Recently opened repositories, kept in localStorage. Storage can be
// unavailable or full; the app works without it.

const KEY = "gitbrix.recent";
const MAX = 12;

export interface RecentRepo {
  path: string;
  name: string;
  openedAt: number;
}

export function loadRecent(): RecentRepo[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentRepo[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function addRecent(path: string, name: string) {
  const list = loadRecent().filter((r) => r.path !== path);
  list.unshift({ path, name, openedAt: Date.now() });
  save(list.slice(0, MAX));
}

export function removeRecent(path: string) {
  save(loadRecent().filter((r) => r.path !== path));
}

function save(list: RecentRepo[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // ignore
  }
}
