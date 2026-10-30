// Newer versions: looked for at the address in Settings (at start, if
// allowed, and on request), installed on request.

import { create } from "zustand";

import { api, errorText, UpdateInfo } from "./api";
import { begin, end } from "./activity";
import { useSettings } from "./settings";
import { useStore } from "./store";

export const useUpdates = create<{ info: UpdateInfo | null; checking: boolean; installing: boolean; error: string | null }>(() => ({
  info: null,
  checking: false,
  installing: false,
  error: null,
}));

/** `quiet`: at start; only a newer version is worth a word. */
export async function checkForUpdates(quiet = false) {
  const address = useSettings.getState().updateUrl.trim();
  if (!address) {
    useUpdates.setState({ info: null, error: "Set the release address in Settings first" });
    return;
  }
  useUpdates.setState({ checking: true, error: null });
  const task = begin("Checking for updates");
  try {
    const info = await api.updateCheck(address);
    useUpdates.setState({ info, checking: false });
    end(task);
    if (quiet && info.version) useStore.getState().toast("info", `gitbrix ${info.version} is available — see About gitbrix`);
  } catch (e) {
    useUpdates.setState({ checking: false, error: errorText(e) });
    end(task, quiet ? errorText(e) : undefined);
  }
}

export async function installUpdate() {
  const address = useSettings.getState().updateUrl.trim();
  useUpdates.setState({ installing: true, error: null });
  try {
    // Restarts the app when it's done.
    await api.updateInstall(address);
  } catch (e) {
    useUpdates.setState({ installing: false, error: errorText(e) });
  }
}

/** What to tell the user about the last check. */
export function updateStatus(info: UpdateInfo | null): string | null {
  if (!info) return null;
  if (!info.version) return `Up to date (${info.current})`;
  if (info.canInstall) return `${info.version} is available (you have ${info.current})`;
  return info.kind === "flatpak"
    ? `${info.version} is available; update it with flatpak update`
    : `${info.version} is available; this copy wasn't installed from a package, so install the new one by hand`;
}
