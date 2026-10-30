// CI status of the open repository's recent commits and branch tips, from
// GitHub checks or GitLab pipelines. Shown as a mark in the graph.

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

import { api, Ci, WIP_ID } from "./api";
import { useSettings } from "./settings";
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

const running = (state: string | undefined) => state === "running" || state === "pending";

/** The checked-out commit's CI at the last look, to tell when it ends. */
let last: { repo: string; sha: string; state: string } | null = null;
let again: ReturnType<typeof setTimeout> | undefined;

/** What a finished run is worth a notification about, if anything. */
export function ciNews(before: typeof last, repo: string, sha: string, state: string | undefined): string | null {
  if (!before || before.repo !== repo || before.sha !== sha || !running(before.state) || !state || running(state)) return null;
  return state;
}

function tellCi(state: string) {
  const st = useStore.getState();
  if (!useSettings.getState().ciNotify || !st.repo) return;
  const where = `${st.repo.headBranch ?? st.repo.headOid?.slice(0, 7)} · ${st.repo.name}`;
  const word = state === "success" ? "passed" : state === "failed" ? "failed" : state;
  invoke("plugin:notification|notify", { options: { title: `CI ${word} on ${where}`, body: "Click the CI mark in the title bar for the jobs" } }).catch(() => {});
}

export async function loadCi() {
  const repo = useStore.getState().repo?.path ?? null;
  const n = ++seq;
  if (useCi.getState().repo !== repo) useCi.setState({ repo, statuses: {} });
  const shas = wanted();
  if (!repo || !shas.length) return;
  try {
    const statuses = await api.ciStatuses(repo, shas);
    if (n === seq && useStore.getState().repo?.path === repo) {
      useCi.setState({ repo, statuses });
      const head = useStore.getState().repo?.headOid;
      if (head) {
        const state = statuses[head]?.state;
        const news = ciNews(last, repo, head, state);
        if (news) tellCi(news);
        last = { repo, sha: head, state: state ?? "" };
        // While it runs, look again soon.
        clearTimeout(again);
        if (running(state)) again = setTimeout(() => void loadCi(), 30_000);
      }
    }
  } catch {
    // Offline, or the token can't read CI: no marks.
  }
}
