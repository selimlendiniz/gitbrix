// CI status of the open repository's recent commits and branch tips, from
// GitHub checks or GitLab pipelines. Shown as a mark in the graph.

import { create } from "zustand";

import { api, Ci, WIP_ID } from "./api";
import { useStore } from "./store";

export const useCi = create<{ repo: string | null; statuses: Record<string, Ci> }>(() => ({ repo: null, statuses: {} }));

/** Commits worth asking about: branch tips and the newest commits. */
function wanted(): string[] {
  const g = useStore.getState().graph;
  if (!g) return [];
  const tips = g.refs.filter((r) => r.kind !== "tag").map((r) => r.target);
  const recent = g.commits.filter((c) => c.kind === "commit" && c.id !== WIP_ID).slice(0, 40).map((c) => c.id);
  return [...new Set([...tips, ...recent])].slice(0, 120);
}

let seq = 0;

export async function loadCi() {
  const repo = useStore.getState().repo?.path ?? null;
  const n = ++seq;
  if (useCi.getState().repo !== repo) useCi.setState({ repo, statuses: {} });
  const shas = wanted();
  if (!repo || !shas.length) return;
  try {
    const statuses = await api.ciStatuses(repo, shas);
    if (n === seq && useStore.getState().repo?.path === repo) useCi.setState({ repo, statuses });
  } catch {
    // Offline, or the token can't read CI: no marks.
  }
}
