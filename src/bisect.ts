// Bisect: the session's state for the banner and graph marks, and the
// actions that drive it. Before a session starts, the first verdict
// (good or bad) waits here for the other one.

import { create } from "zustand";

import { api, BisectStatus, errorText } from "./api";
import { MenuItem, useStore } from "./store";
import { trackHead } from "./undo";

export const useBisect = create<{ status: BisectStatus | null; pending: { verdict: "good" | "bad"; id: string } | null }>(() => ({
  status: null,
  pending: null,
}));

const s = () => useStore.getState();

export async function loadBisect() {
  const repo = s().repo?.path;
  if (!repo) return;
  try {
    const status = await api.bisectStatus(repo);
    if (s().repo?.path === repo) useBisect.setState({ status: status.active ? status : null });
  } catch {
    useBisect.setState({ status: null });
  }
}

// A repository switch drops the waiting verdict and the old status.
useStore.subscribe((st, prev) => {
  if (st.repo?.path !== prev.repo?.path) {
    useBisect.setState({ status: null, pending: null });
    void loadBisect();
  }
});

// Commits made, checkouts done outside the app: the session may have changed.
window.addEventListener("gitbrix:refreshed", () => {
  if (useBisect.getState().status || s().repo?.state === "bisect") void loadBisect();
});

function report(st: BisectStatus | null) {
  if (st?.found) s().toast("info", "Found the first bad commit");
}

async function step(label: string, fn: (repo: string) => Promise<BisectStatus>) {
  let result: BisectStatus | null = null;
  await trackHead(label, () => s().run(label, async (r) => (result = await fn(r))));
  await loadBisect();
  report(result);
  const found = useBisect.getState().status?.found;
  if (found) s().select(found, true);
}

/** Mark `id` good or bad. Without a session, the first mark waits and the
 * second starts it. */
export async function bisectMark(verdict: "good" | "bad" | "skip", id: string | null) {
  const status = useBisect.getState().status;
  if (status) {
    await step(`Marking ${verdict}`, (r) => api.bisectMark(r, verdict, id));
    return;
  }
  if (verdict === "skip" || !id) return;
  const pending = useBisect.getState().pending;
  if (!pending || pending.verdict === verdict) {
    useBisect.setState({ pending: { verdict, id } });
    s().toast("info", `Marked ${verdict}. Now mark a ${verdict === "bad" ? "good (older)" : "bad (newer)"} commit to start bisecting.`);
    return;
  }
  useBisect.setState({ pending: null });
  const [bad, good] = verdict === "bad" ? [id, pending.id] : [pending.id, id];
  await step("Starting bisect", (r) => api.bisectStart(r, bad, good));
}

export async function bisectRun() {
  const r = await s().prompt({
    title: "Let a command decide",
    label: "Command, run in the repository folder at each step",
    placeholder: "cargo test, npm test, ./check.sh…",
    confirmLabel: "Run",
  });
  if (!r?.value.trim()) return;
  await step("Bisecting with a command", (repo) => api.bisectRun(repo, r.value.trim()));
}

export async function bisectStop() {
  try {
    await trackHead("stop bisect", () => s().run("Stopping bisect", (r) => api.bisectReset(r)));
  } catch (e) {
    s().toast("error", errorText(e));
  }
  useBisect.setState({ status: null, pending: null });
  await loadBisect();
}

export function bisectMenu(id: string): MenuItem[] {
  const { status, pending } = useBisect.getState();
  if (status) {
    return [
      { label: "Bisect: mark good", onSelect: () => void bisectMark("good", id) },
      { label: "Bisect: mark bad", onSelect: () => void bisectMark("bad", id) },
      { label: "Bisect: skip", onSelect: () => void bisectMark("skip", id) },
    ];
  }
  return [
    {
      label: pending?.verdict === "bad" ? "Bisect: this one is good (start)" : "Bisect: mark good",
      hint: pending ? undefined : "find the bad commit",
      onSelect: () => void bisectMark("good", id),
    },
    {
      label: pending?.verdict === "good" ? "Bisect: this one is bad (start)" : "Bisect: mark bad",
      onSelect: () => void bisectMark("bad", id),
    },
  ];
}
