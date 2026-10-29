export function shortId(id: string): string {
  return id.slice(0, 7);
}

/** "3 min ago", "yesterday", "12 Mar", "12 Mar 2023". */
export function relativeTime(seconds: number, now = Date.now()): string {
  const diff = Math.max(0, now / 1000 - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diff / 86400);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** "Oct 26, 14:05" (year added when not this year). */
export function shortTime(seconds: number, now = Date.now()): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fullTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Last path segment and the directory before it. */
export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflicted: "!",
};

export function statusLetter(status: string): string {
  return STATUS_LETTER[status] ?? "?";
}
