// Clone and "new repository" dialogs. Shown from the welcome screen and
// the repository menu.

import { homeDir, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, errorText } from "../api";
import { useStore } from "../store";

export const useRepoDialog = create<{ kind: "clone" | "init" | null }>(() => ({ kind: null }));

const PARENT_KEY = "gitbrix.cloneParent";

function rememberedParent(): string | null {
  try {
    return localStorage.getItem(PARENT_KEY);
  } catch {
    return null;
  }
}

/** "https://host/org/project.git" → "project" */
export function nameFromUrl(url: string): string {
  const last = url.trim().replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

async function pickFolder(title: string): Promise<string | null> {
  try {
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export function RepoDialogs() {
  const kind = useRepoDialog((s) => s.kind);
  if (!kind) return null;
  return kind === "clone" ? <CloneDialog /> : <InitDialog />;
}

function close() {
  useRepoDialog.setState({ kind: null });
}

function CloneDialog() {
  const openRepo = useStore((s) => s.openRepo);
  const progress = useStore((s) => s.progress);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(rememberedParent() ?? "");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!parent) homeDir().then((h) => h && setParent((p) => p || h)).catch(() => {});
  }, [parent]);

  useEffect(() => {
    if (!nameTouched) setName(nameFromUrl(url));
  }, [url, nameTouched]);

  async function submit() {
    setRunning(true);
    setError(null);
    useStore.setState({ progress: null });
    try {
      const dest = await api.cloneRepo(url.trim(), parent, name.trim());
      try {
        localStorage.setItem(PARENT_KEY, parent);
      } catch {
        // ignore
      }
      close();
      await openRepo(dest);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && close()}>
      <form
        className="modal wide"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !running && close()}
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim() && parent && name.trim() && !running) void submit();
        }}
      >
        <div className="modal-title">Clone a repository</div>
        <label className="modal-label">URL</label>
        <input autoFocus value={url} placeholder="https://github.com/owner/project.git or git@host:owner/project.git" onChange={(e) => setUrl(e.target.value)} disabled={running} />
        <label className="modal-label">Where to</label>
        <div className="input-row">
          <input value={parent} onChange={(e) => setParent(e.target.value)} disabled={running} />
          <button type="button" className="small-btn" disabled={running} onClick={async () => setParent((await pickFolder("Clone into…")) ?? parent)}>
            Browse…
          </button>
        </div>
        <label className="modal-label">Folder name</label>
        <input
          value={name}
          onChange={(e) => {
            setNameTouched(true);
            setName(e.target.value);
          }}
          disabled={running}
        />
        {running && (
          <div className="clone-progress">
            <span className="spinner" />
            <span>{progress ?? "Starting…"}</span>
          </div>
        )}
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={running}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={!url.trim() || !parent || !name.trim() || running}>
            {running ? "Cloning…" : "Clone"}
          </button>
        </div>
      </form>
    </div>
  );
}

function InitDialog() {
  const openRepo = useStore((s) => s.openRepo);
  const [parent, setParent] = useState(rememberedParent() ?? "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!parent) homeDir().then((h) => h && setParent((p) => p || h)).catch(() => {});
  }, [parent]);

  async function submit() {
    setError(null);
    try {
      const path = await api.initRepo(await join(parent, name.trim()));
      close();
      await openRepo(path);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal wide"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          if (parent && name.trim()) void submit();
        }}
      >
        <div className="modal-title">New repository</div>
        <label className="modal-label">Parent folder</label>
        <div className="input-row">
          <input value={parent} onChange={(e) => setParent(e.target.value)} />
          <button type="button" className="small-btn" onClick={async () => setParent((await pickFolder("Create in…")) ?? parent)}>
            Browse…
          </button>
        </div>
        <label className="modal-label">Name</label>
        <input autoFocus value={name} placeholder="my-project" onChange={(e) => setName(e.target.value)} />
        <p className="modal-message">An existing folder is fine: it becomes a repository, files untouched.</p>
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={!parent || !name.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
