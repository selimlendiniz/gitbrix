// The pinned Workspaces tab: the workspaces on the left, the chosen one's
// repositories on the right — branch, ahead/behind, local changes — with
// fetch for all of them at once.

import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { MouseEvent, useEffect, useState } from "react";

import { errorText, RepoSummary } from "../api";
import { relativeTime } from "../format";
import { prKey, usePrs, wantsReview } from "../prs";
import { useStore } from "../store";
import {
  addRepos,
  createWorkspace,
  deleteWorkspace,
  fetchRepos,
  hideWorkspaces,
  loadSummaries,
  loadWorkspacePrs,
  removeRepo,
  reviewPullRequest,
  renameWorkspace,
  scanFolder,
  selectWorkspace,
  useWorkspaces,
  Workspace,
  folderName,
} from "../workspaces";
import { IconFetch, IconFolder, IconPlus, IconPullRequest, IconWorkspace } from "./Icons";
import { defaultFilter, matchesFilter, PrFilter, PrFilters, PrRow } from "./PullRequestsDialog";

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

function workspaceMenu(x: number, y: number, ws: Workspace) {
  s().showMenu(x, y, [
    {
      label: "Rename…",
      onSelect: async () => {
        const r = await s().prompt({ title: "Rename workspace", label: "Name", initial: ws.name, confirmLabel: "Rename" });
        if (r?.value.trim()) renameWorkspace(ws.id, r.value.trim());
      },
    },
    {
      label: "Delete…",
      danger: true,
      onSelect: async () => {
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
  hideWorkspaces();
  if (s().repo?.path !== path) void s().openRepo(path);
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

function Row({ path, summary }: { path: string; summary: RepoSummary | undefined }) {
  const fetching = useWorkspaces((st) => st.fetching.includes(path));
  const fetchError = useWorkspaces((st) => st.fetchErrors[path]);
  const current = useStore((st) => st.repo?.path === path);
  const prs = usePrs((st) => st.byRepo[path]?.items);
  const waiting = prs?.filter(wantsReview).length ?? 0;
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
        {!!prs?.length && (
          <span
            className={`ws-prs${waiting ? " waiting" : ""}`}
            title={`${prs.length} open request${prs.length === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for your approval` : ""}`}
          >
            <IconPullRequest size={11} /> {prs.length}
          </span>
        )}
      </div>
      <div className="ws-fetched dim">
        {fetching ? <span className="spinner" /> : summary?.fetched ? relativeTime(summary.fetched) : ""}
      </div>
      {error && <div className="ws-error">{error}</div>}
    </div>
  );
}

function WorkspacePrs({ repos }: { repos: string[] }) {
  const byRepo = usePrs((st) => st.byRepo);
  const summaries = useWorkspaces((st) => st.summaries);
  const [filter, setFilter] = useState<PrFilter | null>(null);
  const all = repos.flatMap((path) => (byRepo[path]?.items ?? []).map((pr) => ({ path, pr })));
  // A project reached from two repositories (clones, worktrees) shows once.
  const seen = new Set<string>();
  const items = all.filter(({ pr }) => !seen.has(prKey(pr)) && !!seen.add(prKey(pr)));
  items.sort((a, b) => b.pr.created.localeCompare(a.pr.created));
  const current = filter ?? defaultFilter(items.map((i) => i.pr));
  const shown = items.filter((i) => matchesFilter(i.pr, current));
  const loading = repos.some((p) => byRepo[p]?.loading);
  const problems = repos.flatMap((p) => {
    const d = byRepo[p];
    const name = summaries[p]?.info?.name ?? folderName(p);
    return [...(d?.error ? [d.error] : []), ...(d?.problems ?? [])].map((x) => `${name}: ${x}`);
  });
  const covered = repos.some((p) => byRepo[p]?.covered);
  return (
    <div className="ws-prs-view">
      <div className="ws-prs-head">
        <PrFilters items={items.map((i) => i.pr)} filter={current} onChange={setFilter} />
        {loading && <span className="spinner" />}
      </div>
      <div className="ws-list">
        {shown.map(({ path, pr }) => (
          <PrRow
            key={prKey(pr)}
            pr={pr}
            where={summaries[path]?.info?.name ?? folderName(path)}
            onOpen={() => void reviewPullRequest(path, pr)}
          />
        ))}
        {!loading && !shown.length && (
          <div className="pr-empty">
            {covered || items.length ? "Nothing here" : "No GitHub or GitLab account covers these repositories' remotes (Settings → Accounts)."}
          </div>
        )}
      </div>
      {problems.map((p) => (
        <p key={p} className="modal-error">
          {p}
        </p>
      ))}
    </div>
  );
}

function addMenu(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  s().showMenu(r.left, r.bottom + 4, [
    { label: "Repository…", onSelect: () => void addRepository() },
    { label: "All repositories in a folder…", onSelect: () => void scan() },
    { label: "Open tabs", disabled: !s().tabs.length, onSelect: addOpenTabs },
  ]);
}

export function WorkspaceView() {
  const list = useWorkspaces((st) => st.list);
  const active = useWorkspaces((st) => st.active);
  const summaries = useWorkspaces((st) => st.summaries);
  const loading = useWorkspaces((st) => st.loading);
  const fetching = useWorkspaces((st) => st.fetching.length);
  const tabs = useStore((st) => st.tabs.length);
  const [view, setView] = useState<"repos" | "prs">("repos");
  const byRepo = usePrs((st) => st.byRepo);
  useEffect(() => {
    void loadSummaries();
    void loadWorkspacePrs();
  }, [active]);
  const ws = list.find((w) => w.id === active) ?? list[0] ?? null;
  const repos = ws?.repos ?? [];
  const changed = repos.filter((p) => summaries[p]?.changes).length;
  const behind = repos.filter((p) => summaries[p]?.info?.behind).length;
  const prCount = new Set(repos.flatMap((p) => (byRepo[p]?.items ?? []).map((pr) => `${pr.project}#${pr.number}`))).size;

  return (
    <div className="ws-page" data-testid="workspaces">
      <aside className="ws-side">
        <div className="ws-side-head">
          <span>Workspaces</span>
          <button className="icon-btn" title="New workspace" onClick={() => void newWorkspace()}>
            <IconPlus size={12} />
          </button>
        </div>
        {list.map((w) => (
          <div
            key={w.id}
            className={`side-item ws-item${w.id === ws?.id ? " selected" : ""}`}
            onClick={() => selectWorkspace(w.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              workspaceMenu(e.clientX, e.clientY, w);
            }}
          >
            <IconWorkspace size={13} />
            <span className="side-item-label">{w.name}</span>
            <span className="side-count">{w.repos.length}</span>
          </div>
        ))}
        {list.length === 0 && <div className="side-note">No workspaces yet</div>}
      </aside>
      <section className="ws-main">
        <div className="ws-head">
          <h2>{ws?.name ?? "Workspace"}</h2>
          {ws && (
            <button
              className="icon-btn"
              title="Rename or delete"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                workspaceMenu(r.left, r.bottom + 4, ws);
              }}
            >
              ⋯
            </button>
          )}
          {repos.length > 0 && (
            <span className="dim ws-summary">
              {repos.length} repositor{repos.length === 1 ? "y" : "ies"}
              {changed > 0 && ` · ${changed} with changes`}
              {behind > 0 && ` · ${behind} behind`}
            </span>
          )}
          <span className="ws-spacer" />
          {repos.length > 0 && (
            <span className="segmented">
              <button type="button" className={view === "repos" ? "on" : ""} onClick={() => setView("repos")}>
                Repositories <span className="side-count">{repos.length}</span>
              </button>
              <button type="button" className={view === "prs" ? "on" : ""} onClick={() => setView("prs")}>
                Pull requests <span className="side-count">{prCount}</span>
              </button>
            </span>
          )}
          <button type="button" className="small-btn" onClick={addMenu}>
            <IconPlus size={12} /> Add
          </button>
          <button type="button" className="small-btn" disabled={!repos.length || fetching > 0} onClick={() => void fetchRepos(repos)}>
            <IconFetch size={12} /> Fetch all
          </button>
          <button
            type="button"
            className={`icon-btn${loading ? " spinning" : ""}`}
            title="Check again"
            onClick={() => {
              void loadSummaries();
              void loadWorkspacePrs();
            }}
          >
            <IconFetch size={13} />
          </button>
        </div>
        {repos.length && view === "prs" ? (
          <WorkspacePrs repos={repos} />
        ) : repos.length ? (
          <div className="ws-list">
            <div className="ws-row ws-cols">
              <span>Repository</span>
              <span>Branch</span>
              <span>Sync</span>
              <span>Changes</span>
              <span className="ws-fetched">Fetched</span>
            </div>
            {repos.map((p) => (
              <Row key={p} path={p} summary={summaries[p]} />
            ))}
          </div>
        ) : (
          <div className="ws-empty">
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
      </section>
    </div>
  );
}
