// Profiles (work, personal…): the identity commits are made with and the
// accounts used. Kept by the backend, which applies them; this mirrors
// them for the UI, with the open repository's resulting identity.

import { create } from "zustand";

import { api, errorText, Identity, Profiles } from "./api";
import { loadInbox, loadPrs } from "./prs";
import { useStore } from "./store";

export const useProfiles = create<{ profiles: Profiles; identity: Identity | null }>(() => ({
  profiles: { active: null, list: [] },
  identity: null,
}));

let identitySeq = 0;

export async function loadIdentity(repo: string | null) {
  const seq = ++identitySeq;
  if (!repo) {
    useProfiles.setState({ identity: null });
    return;
  }
  try {
    const identity = await api.identity(repo);
    if (seq === identitySeq) useProfiles.setState({ identity });
  } catch {
    if (seq === identitySeq) useProfiles.setState({ identity: null });
  }
}

export async function loadProfiles() {
  try {
    useProfiles.setState({ profiles: await api.profiles() });
  } catch (e) {
    useStore.getState().toast("error", errorText(e));
  }
}

/** Store the profiles; what depends on them (identity, request lists) is
 * read again. Throws the backend's complaint for the form to show. */
export async function saveProfiles(profiles: Profiles) {
  useProfiles.setState({ profiles: await api.saveProfiles(profiles) });
  const repo = useStore.getState().repo?.path ?? null;
  void loadIdentity(repo);
  if (repo) void loadPrs(repo);
  void loadInbox();
}

export async function switchProfile(id: string | null) {
  try {
    await saveProfiles({ ...useProfiles.getState().profiles, active: id });
  } catch (e) {
    useStore.getState().toast("error", errorText(e));
  }
}

export function newProfileId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
