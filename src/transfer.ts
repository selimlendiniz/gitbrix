// Settings carried to another machine as one JSON file: preferences,
// workspaces, profiles and which accounts exist. Tokens never go into the
// file; accounts arrive as reminders to add a token for.

import { create } from "zustand";

import { Account, api, Profile, Profiles, Provider } from "./api";
import { saveProfiles, useProfiles } from "./profiles";
import { DEFAULTS, Settings, updateSettings, useSettings } from "./settings";
import { setWorkspaces, useWorkspaces, Workspace } from "./workspaces";

export const FORMAT = 1;

/** An account without its token. */
export interface AccountRef {
  provider: Provider;
  url: string;
  username: string;
}

export interface Exported {
  gitbrix: number;
  exported: string;
  settings: Partial<Settings>;
  workspaces: Workspace[];
  profiles: Profile[];
  accounts: AccountRef[];
}

export type Part = "settings" | "workspaces" | "profiles" | "accounts";

export function buildExport(settings: Settings, workspaces: Workspace[], profiles: Profile[], accounts: Account[]): Exported {
  return {
    gitbrix: FORMAT,
    exported: new Date().toISOString(),
    settings,
    workspaces,
    profiles,
    accounts: accounts.map(({ provider, url, username }) => ({ provider, url, username })),
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : []);

/** The file's contents, checked; throws a message for the user. */
export function parseExport(text: string): Exported {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("This isn't a gitbrix settings file (not JSON)");
  }
  if (!raw || typeof raw !== "object" || typeof raw.gitbrix !== "number") {
    throw new Error("This isn't a gitbrix settings file");
  }
  if (raw.gitbrix > FORMAT) throw new Error("The file comes from a newer gitbrix; update this one first");
  // Only known settings, with the type their default has.
  const settings: Partial<Settings> = {};
  const given = (raw.settings ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key in given && typeof given[key] === typeof DEFAULTS[key]) (settings as Record<string, unknown>)[key] = given[key];
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];
  const workspaces: Workspace[] = list(raw.workspaces)
    .filter((w) => isString(w.id) && isString(w.name))
    .map((w) => ({ id: w.id as string, name: w.name as string, repos: strings(w.repos) }));
  const profiles: Profile[] = list(raw.profiles)
    .filter((p) => isString(p.id) && isString(p.name) && isString(p.userName) && isString(p.userEmail))
    .map((p) => ({
      id: p.id as string,
      name: p.name as string,
      userName: p.userName as string,
      userEmail: p.userEmail as string,
      folders: strings(p.folders),
      accounts: strings(p.accounts),
    }));
  const accounts: AccountRef[] = list(raw.accounts)
    .filter((a) => (a.provider === "github" || a.provider === "gitlab") && isString(a.url) && /^https?:\/\//.test(a.url) && isString(a.username))
    .map((a) => ({ provider: a.provider as Provider, url: a.url as string, username: a.username as string }));
  return { gitbrix: raw.gitbrix, exported: isString(raw.exported) ? raw.exported : "", settings, workspaces, profiles, accounts };
}

/** `incoming` over `current`: same id replaced, new ones added at the end. */
export function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const byId = new Map(incoming.map((x) => [x.id, x]));
  return [...current.map((x) => byId.get(x.id) ?? x), ...incoming.filter((x) => !current.some((c) => c.id === x.id))];
}

export const accountKey = (a: AccountRef) => `${a.provider}|${a.url.replace(/\/+$/, "")}|${a.username}`;

/** Accounts from a settings file that still need a token here. */
const PENDING = "gitbrix.accounts.pending";

function loadPending(): AccountRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export const usePendingAccounts = create<{ list: AccountRef[] }>(() => ({ list: typeof localStorage === "undefined" ? [] : loadPending() }));

export function setPendingAccounts(list: AccountRef[]) {
  usePendingAccounts.setState({ list });
  try {
    localStorage.setItem(PENDING, JSON.stringify(list));
  } catch {
    // ignore
  }
}

/** An account was added: it no longer waits for a token. */
export function accountAdded(a: AccountRef) {
  const host = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  setPendingAccounts(usePendingAccounts.getState().list.filter((p) => !(p.provider === a.provider && host(p.url) === host(a.url))));
}

/** What this machine has, as a file. */
export async function exportText(): Promise<string> {
  const [accounts, profiles] = await Promise.all([api.accounts(), api.profiles()]);
  const { list } = useWorkspaces.getState();
  return `${JSON.stringify(buildExport(useSettings.getState(), list, profiles.list, accounts), null, 2)}\n`;
}

/** Take the chosen parts of a file in. Returns the accounts that need a token. */
export async function applyImport(data: Exported, parts: Set<Part>): Promise<AccountRef[]> {
  if (parts.has("settings")) updateSettings(data.settings);
  if (parts.has("workspaces") && data.workspaces.length) {
    setWorkspaces(mergeById(useWorkspaces.getState().list, data.workspaces));
  }
  if (parts.has("profiles") && data.profiles.length) {
    const current: Profiles = useProfiles.getState().profiles;
    await saveProfiles({ active: current.active, list: mergeById(current.list, data.profiles) });
  }
  if (!parts.has("accounts")) return [];
  const have = new Set((await api.accounts()).map((a) => accountKey(a)));
  const waiting = usePendingAccounts.getState().list;
  const missing = data.accounts.filter((a) => !have.has(accountKey(a)));
  setPendingAccounts([...waiting, ...missing.filter((m) => !waiting.some((w) => accountKey(w) === accountKey(m)))]);
  return missing;
}
