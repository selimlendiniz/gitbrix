// Work going on in the background (auto-fetch, fetching a workspace,
// checking pull requests) and the problems met lately, anywhere in the
// app, for the indicator in the title bar. Toasts vanish; these stay.

import { create } from "zustand";

export interface Task {
  id: number;
  label: string;
}

export interface Problem {
  id: number;
  label: string;
  text: string;
  /** Milliseconds since the epoch; the latest time it happened. */
  time: number;
  /** Times in a row it happened (a check failing while offline). */
  count: number;
}

export const useActivity = create<{ running: Task[]; problems: Problem[]; unseen: number }>(() => ({
  running: [],
  problems: [],
  unseen: 0,
}));

const KEEP = 30;
let seq = 0;

export function begin(label: string): number {
  const id = ++seq;
  useActivity.setState((s) => ({ running: [...s.running, { id, label }] }));
  return id;
}

export function end(id: number, problem?: string) {
  const task = useActivity.getState().running.find((t) => t.id === id);
  useActivity.setState((s) => ({ running: s.running.filter((t) => t.id !== id) }));
  if (problem && task) report(task.label, problem);
}

/** Note a problem. The same one again moves to the top instead of adding a row. */
export function report(label: string, text: string) {
  useActivity.setState((s) => {
    const same = s.problems.find((p) => p.label === label && p.text === text);
    const rest = s.problems.filter((p) => p !== same);
    const problem = { id: ++seq, label, text, time: Date.now(), count: (same?.count ?? 0) + 1 };
    return { problems: [problem, ...rest].slice(0, KEEP), unseen: s.unseen + 1 };
  });
}

/** Run `fn` as a background task; a failure is noted and thrown on. */
export async function track<T>(label: string, fn: () => Promise<T>, text: (e: unknown) => string = String): Promise<T> {
  const id = begin(label);
  try {
    const out = await fn();
    end(id);
    return out;
  } catch (e) {
    end(id, text(e));
    throw e;
  }
}

export function seeProblems() {
  useActivity.setState({ unseen: 0 });
}

export function clearProblems() {
  useActivity.setState({ problems: [], unseen: 0 });
}
