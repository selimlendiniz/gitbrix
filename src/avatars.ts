// Author pictures (Gravatar, or GitHub's for its noreply addresses). The
// backend fetches and keeps them on disk; here they are asked for in
// batches as rows appear, and remembered for the session. Off in
// Settings, everyone gets initials.

import { create } from "zustand";

import { api } from "./api";
import { useSettings } from "./settings";

/** Picture per address (lowercased): a data URL, null for none. Missing:
 * not asked yet. */
export const useAvatars = create<{ pics: Record<string, string | null>; /** Bumped as canvas pictures finish decoding. */ decoded: number }>(
  () => ({ pics: {}, decoded: 0 }),
);

export function avatarKey(email: string): string {
  return email.trim().toLowerCase();
}

const wanted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function flush() {
  timer = null;
  const emails = [...wanted];
  wanted.clear();
  if (!emails.length) return;
  let got: Record<string, string | null> = {};
  try {
    got = await api.avatars(emails);
  } catch {
    // Not there (browser mode without it): initials.
  }
  useAvatars.setState((s) => ({
    pics: { ...s.pics, ...Object.fromEntries(emails.map((e) => [e, got[e] ?? null])) },
  }));
}

/** The picture for an address if known; asks for it otherwise. */
export function avatarFor(email: string | null | undefined): string | null {
  if (!email || !useSettings.getState().gravatar) return null;
  const key = avatarKey(email);
  const pics = useAvatars.getState().pics;
  if (key in pics) return pics[key];
  if (!wanted.has(key)) {
    wanted.add(key);
    // Rows render together: one request for all of them.
    timer ??= setTimeout(() => void flush(), 30);
  }
  return null;
}

/** Reactive `avatarFor`. */
export function useAvatar(email: string | null | undefined): string | null {
  const on = useSettings((s) => s.gravatar);
  const pic = useAvatars((s) => (email ? s.pics[avatarKey(email)] : undefined));
  if (!on || !email) return null;
  return pic === undefined ? avatarFor(email) : pic;
}

// Decoded pictures for the graph canvas, which draws them in the commit dots.
const images = new Map<string, HTMLImageElement | null>();

/** A decoded picture for the canvas, or null until there is one (the
 * `decoded` count goes up when it is). */
export function avatarImage(email: string): HTMLImageElement | null {
  const url = avatarFor(email);
  if (!url) return null;
  const key = avatarKey(email);
  const img = images.get(key);
  if (img !== undefined) return img?.complete && img.naturalWidth ? img : null;
  const el = new Image();
  images.set(key, el);
  el.onload = () => useAvatars.setState((s) => ({ decoded: s.decoded + 1 }));
  el.onerror = () => images.set(key, null);
  el.src = url;
  return null;
}
