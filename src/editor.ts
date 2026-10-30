// Opening files (at a line) and the repository's folder in the user's
// editor, chosen in Settings.

import { openPath } from "@tauri-apps/plugin-opener";

import { api, errorText } from "./api";
import { useSettings } from "./settings";
import { useStore } from "./store";

export interface Editor {
  id: string;
  label: string;
  /** With {file}, {line}, {dir}; null: the system's default app. */
  file: string | null;
  dir: string | null;
}

export const EDITORS: Editor[] = [
  { id: "system", label: "System default", file: null, dir: null },
  { id: "code", label: "VS Code", file: "code --goto {file}:{line}", dir: "code {dir}" },
  { id: "codium", label: "VSCodium", file: "codium --goto {file}:{line}", dir: "codium {dir}" },
  { id: "idea", label: "IntelliJ IDEA", file: "idea --line {line} {file}", dir: "idea {dir}" },
  { id: "kate", label: "Kate", file: "kate --line {line} {file}", dir: "kate {dir}" },
  { id: "zed", label: "Zed", file: "zed {file}:{line}", dir: "zed {dir}" },
  { id: "subl", label: "Sublime Text", file: "subl {file}:{line}", dir: "subl {dir}" },
  { id: "custom", label: "Custom command", file: null, dir: null },
];

/** The command for a file (or, without one, the folder). */
export function editorCommand(id: string, custom: string, forFile: boolean): string | null {
  if (id === "custom") return custom.trim() || null;
  const e = EDITORS.find((x) => x.id === id) ?? EDITORS[0];
  return forFile ? e.file : e.dir;
}

/** Open `path` (relative to the repository) at `line`, or the folder. */
export async function openInEditor(path?: string, line?: number) {
  const st = useStore.getState();
  const repo = st.repo?.path;
  if (!repo) return;
  const { editor, editorCommand: custom } = useSettings.getState();
  const command = editorCommand(editor, custom, !!path);
  try {
    if (!command) {
      // The desktop's default app for it; no line.
      await openPath(path ? `${repo}/${path}` : repo);
      return;
    }
    // A custom command opens the folder as it would a file.
    await api.openInEditor(repo, command, path ?? (editor === "custom" ? "." : null), line ?? null);
  } catch (e) {
    st.toast("error", errorText(e));
  }
}
