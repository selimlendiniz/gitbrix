import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";

import { errorText } from "../api";
import { relativeTime } from "../format";
import { loadRecent, removeRecent } from "../recent";
import { useStore } from "../store";
import { IconClose, IconCloud, IconFolder, IconPlus, IconWorkspace } from "./Icons";
import { useWorkspaces } from "../workspaces";
import { useRepoDialog } from "./RepoDialogs";

export async function openRepoDialog() {
  try {
    const picked = await open({ directory: true, multiple: false, title: "Open a Git repository" });
    if (typeof picked === "string") await useStore.getState().openRepo(picked);
  } catch (e) {
    useStore.getState().toast("error", errorText(e));
  }
}

export function Welcome() {
  const openRepo = useStore((s) => s.openRepo);
  const loading = useStore((s) => s.loading);
  const [recent, setRecent] = useState(loadRecent);
  const [path, setPath] = useState("");

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="welcome-brand">
          <img src="/gitbrix.svg" alt="" width={44} height={44} />
          <div>
            <h1>gitbrix</h1>
            <p className="dim">A graph-first Git client</p>
          </div>
        </div>

        <button className="primary-btn big" onClick={openRepoDialog} disabled={loading}>
          <IconFolder size={16} /> Open repository…
        </button>
        <div className="welcome-row">
          <button className="secondary-btn" onClick={() => useRepoDialog.setState({ kind: "clone" })} disabled={loading}>
            <IconCloud size={15} /> Clone…
          </button>
          <button className="secondary-btn" onClick={() => useRepoDialog.setState({ kind: "init" })} disabled={loading}>
            <IconPlus size={15} /> New repository…
          </button>
          <button className="secondary-btn" onClick={() => useWorkspaces.setState({ open: true })} disabled={loading}>
            <IconWorkspace size={15} /> Workspace…
          </button>
        </div>

        <form
          className="path-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) openRepo(path.trim());
          }}
        >
          <input placeholder="…paste a path, or drop a folder on the window" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="small-btn" type="submit" disabled={!path.trim() || loading}>
            Open
          </button>
        </form>

        {recent.length > 0 && (
          <div className="recent">
            <div className="recent-title">Recent</div>
            {recent.map((r) => (
              <div key={r.path} className="recent-item" onClick={() => openRepo(r.path)} title={r.path}>
                <IconFolder size={14} />
                <span className="recent-name">{r.name}</span>
                <span className="recent-path dim">{r.path}</span>
                <span className="recent-time dim">{relativeTime(r.openedAt / 1000)}</span>
                <button
                  className="icon-btn"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(r.path);
                    setRecent(loadRecent());
                  }}
                >
                  <IconClose size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
