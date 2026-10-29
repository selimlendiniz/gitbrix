import { RefInfo } from "../api";

/** One label in the graph's ref column. A local branch and remote
 *  branches of the same name on the same commit share one pill. */
export interface RefPill {
  key: string;
  label: string;
  kind: "branch" | "tag";
  local: RefInfo | null;
  remotes: RefInfo[];
  tag: RefInfo | null;
  isHead: boolean;
}

export function primaryRef(p: RefPill): RefInfo {
  return (p.local ?? p.tag ?? p.remotes[0])!;
}

export function refsByCommit(refs: RefInfo[]): Map<string, RefPill[]> {
  const byTarget = new Map<string, RefInfo[]>();
  for (const r of refs) {
    const list = byTarget.get(r.target);
    if (list) list.push(r);
    else byTarget.set(r.target, [r]);
  }

  const out = new Map<string, RefPill[]>();
  for (const [target, list] of byTarget) {
    const pills: RefPill[] = [];
    const usedRemotes = new Set<string>();
    for (const local of list.filter((r) => r.kind === "local")) {
      const remotes = list.filter(
        (r) => r.kind === "remote" && r.name.slice(r.name.indexOf("/") + 1) === local.name,
      );
      remotes.forEach((r) => usedRemotes.add(r.fullName));
      pills.push({ key: local.fullName, label: local.name, kind: "branch", local, remotes, tag: null, isHead: local.isHead });
    }
    for (const remote of list.filter((r) => r.kind === "remote" && !usedRemotes.has(r.fullName))) {
      pills.push({ key: remote.fullName, label: remote.name, kind: "branch", local: null, remotes: [remote], tag: null, isHead: false });
    }
    for (const tag of list.filter((r) => r.kind === "tag")) {
      pills.push({ key: tag.fullName, label: tag.name, kind: "tag", local: null, remotes: [], tag, isHead: false });
    }
    // HEAD first, then branches, then tags.
    pills.sort((a, b) => Number(b.isHead) - Number(a.isHead) || (a.kind === b.kind ? 0 : a.kind === "branch" ? -1 : 1));
    out.set(target, pills);
  }
  return out;
}
