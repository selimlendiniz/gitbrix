// Workspace window: the repositories of a workspace side by side — branch,
// ahead/behind, local changes — with fetch for all of them at once.

import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { useEffect } from "react";

import { errorText, RepoSummary } from "../api";
import { relativeTime } from "../format";
import { useStore } from "../store";
import {
  activeWorkspace,
  addRepos,
  createWorkspace,
  deleteWorkspace,
  fetchRepos,
  loadSummaries,
  removeRepo,
  renameWorkspace,
  scanFolder,
  selectWorkspace,
  useWorkspaces,
} from "../workspaces";
import { IconFetch, IconFolder, IconPlus } from "./Icons";

const s = () => useStore.getState();

async function addRepository() {
  try {
    const picked = await pickFolder({ directory: true, multiple: false, title: "Add a repository to the workspace" });
    if (typeof picked === "string") addRepos([picked]);
  } catch (e) {
    s().toast("error", errorText(e));
  }
}

async function scan() {
  try {
    const picked = await pickFolder({ directory: true, multiple: false, title: "Find repositories in a folder" });
    if (typeof picked !== "string") return;
    const added = await scanFolder(picked);
    s().toast("info", added ? `Added ${added} repositor${added === 1 ? "y" : "ies"}` : "No new repositories in that folder");
  } catch (e) {
    s().toast("error", errorText(e));
  }
}

function addOpenTabs() {
  addRepos(s().tabs.map((t) => t.path));
}

async function newWorkspace() {
  const r = await s().prompt({ title: "New workspace", label: "Name", placeholder: "Work", confirmLabel: "Create" });
  if (r?.value.trim()) createWorkspace(r.value.trim());
}

function workspaceMenu(x: number, y: number) {
  const ws = activeWorkspace();
  s().showMenu(x, y, [
    { label: "New workspace…", onSelect: () => void newWorkspace() },
    {
      label: "Rename…",
      disabled: !ws,
      onSelect: async () => {
        if (!ws) return;
        const r = await s().prompt({ title: "Rename workspace", label: "Name", initial: ws.name, confirmLabel: "Rename" });
        if (r?.value.trim()) renameWorkspace(ws.id, r.value.trim());
      },
    },
    {
      label: "Delete…",
      danger: true,
      disabled: !ws,
      onSelect: async () => {
        if (!ws) return;
        const ok = await s().confirm({
          title: "Delete workspace",
          message: `Delete the workspace "${ws.name}"? The repositories themselves stay where they are.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (ok) deleteWorkspace(ws.id);
      },
    },
  ]);
}

function openRepo(path: string) {
  useWorkspaces.setState({ open: false });
  void s().openRepo(path);
}

function rowMenu(x: number, y: number, path: string) {
  s().showMenu(x, y, [
    { label: "Open", onSelect: () => openRepo(path) },
    { label: "Fetch", onSelect: () => void fetchRepos([path]) },
    { label: "Copy path", onSelect: () => void navigator.clipboard?.writeText(path) },
    { separator: true, label: "" },
    { label: "Remove from workspace", onSelect: () => removeRepo(path) },
  ]);
}

function folderName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function Row({ path, summary }: { path: string; summary: RepoSummary | undefined }) {
  const fetching = useWorkspaces((st) => st.fetching.includes(path));
  const fetchError = useWorkspaces((st) => st.fetchErrors[path]);
  const current = useStore((st) => st.repo?.path === path);
  const info = summary?.info;
  const error = fetchError ?? summary?.error;
  return (
    <div
      className={`ws-row${current ? " current" : ""}`}
      title={path}
      onClick={() => openRepo(path)}
      onContextMenu={(e) => {
        e.preventDefault();
        rowMenu(e.clientX, e.clientY, path);
      }}
    >
      <div className="ws-name">
        <IconFolder size={13} />
        <span>{info?.name ?? folderName(path)}</span>
      </div>
      <div className="ws-branch">
        {info ? (info.detached ? `detached ${info.headOid?.slice(0, 7)}` : info.headBranch ?? "—") : ""}
      </div>
      <div className="ws-sync">
        {info && info.ahead > 0 && <span className="ws-ahead">↑{info.ahead}</span>}
        {info && info.behind > 0 && <span className="ws-behind">↓{info.behind}</span>}
        {info && !info.upstream && !info.unborn && <span className="dim">no upstream</span>}
      </div>
      <div className="ws-changes">
        {!!summary?.conflicts && <span className="ws-conflict">{summary.conflicts} conflicted</span>}
        {!!summary?.changes && <span className="ws-dirty">{summary.changes} changed</span>}
        {info && info.state !== "clean" && <span className="pr-badge review">{info.state}</span>}
      </div>
      <div className="ws-fetched dim">
        {fetching ? <span className="spinner" /> : summary?.fetched ? relativeTime(summary.fetched) : ""}
      </div>
      {error && <div className="ws-error">{error}</div>}
    </div>
  );
}

export function WorkspaceDialog() {
  const open = useWorkspaces((st) => st.open);
  const list = useWorkspaces((st) => st.list);
  const active = useWorkspaces((st) => st.active);
  const summaries = useWorkspaces((st) => st.summaries);
  const loading = useWorkspaces((st) => st.loading);
  const fetching = useWorkspaces((st) => st.fetching.length);
  const tabs = useStore((st) => st.tabs.length);
  useEffect(() => {
    if (open) void loadSummaries();
  }, [open]);
  if (!open) return null;
  const close = () => useWorkspaces.setState({ open: false });
  const ws = list.find((w) => w.id === active) ?? list[0] ?? null;
  const repos = ws?.repos ?? [];

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide ws-dialog"
        role="dialog"
        aria-label="Workspace"
        tabIndex={-1}
        ref={(e) => {
          if (e && !e.contains(document.activeElement)) e.focus();
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && !s().dialog && !s().menu && close()}
      >
        <div className="pr-dialog-head">
          <span className="modal-title">Workspace</span>
          {list.length > 0 && (
            <select aria-label="Workspace" value={ws?.id ?? ""} onChange={(e) => selectWorkspace(e.target.value)}>
              {list.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.repos.length})
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="small-btn"
            title="New, rename or delete workspaces"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              workspaceMenu(r.left, r.bottom + 4);
            }}
          >
            ⋯
          </button>
          <span className="ws-spacer" />
          <button
            type="button"
            className="small-btn"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              s().showMenu(r.left, r.bottom + 4, [
                { label: "Repository…", onSelect: () => void addRepository() },
                { label: "All repositories in a folder…", onSelect: () => void scan() },
                { label: "Open tabs", disabled: !tabs, onSelect: addOpenTabs },
              ]);
            }}
          >
            <IconPlus size={12} /> Add
          </button>
          <button
            type="button"
            className="small-btn"
            disabled={!repos.length || fetching > 0}
            onClick={() => void fetchRepos(repos)}
          >
            <IconFetch size={12} /> Fetch all
          </button>
          <button
            type="button"
            className={`icon-btn${loading ? " spinning" : ""}`}
            title="Check again"
            onClick={() => void loadSummaries()}
          >
            <IconFetch size={13} />
          </button>
        </div>
        {repos.length ? (
          <div className="ws-list">
            {repos.map((p) => (
              <Row key={p} path={p} summary={summaries[p]} />
            ))}
          </div>
        ) : (
          <div className="pr-empty ws-empty">
            <p>Keep the repositories you work on together: see which have changes or are behind, and fetch them all at once.</p>
            <div className="ws-empty-actions">
              <button type="button" className="small-btn" onClick={() => void scan()}>
                Add all repositories in a folder…
              </button>
              <button type="button" className="small-btn" onClick={() => void addRepository()}>
                Add a repository…
              </button>
              {tabs > 0 && (
                <button type="button" className="small-btn" onClick={addOpenTabs}>
                  Add the open tabs
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
