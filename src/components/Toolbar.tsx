import { ReactNode } from "react";

import { branchSwitchMenu, createBranch, fetchAll, pull, push, stashPop, stashSave } from "../actions";
import { PullMode } from "../api";
import { useStore } from "../store";
import { useRepoDialog } from "./RepoDialogs";
import { openRepoDialog } from "./Welcome";
import {
  IconBranch,
  IconChevron,
  IconFetch,
  IconFolder,
  IconPull,
  IconPush,
  IconRefresh,
  IconStash,
  IconPop,
  IconSearch,
  IconSettings,
  IconTerminal,
  IconUndo,
  IconWorkspace,
} from "./Icons";
import { usePalette } from "./CommandPalette";
import { useSettings } from "../settings";
import { nextUndo, undoLast, useUndo } from "../undo";
import { PullRequestsButton } from "./PullRequestsDialog";
import { ProfileButton } from "./Profiles";
import { useSettingsDialog } from "./SettingsDialog";
import { useWorkspaces } from "../workspaces";
import { toggleTerminal, useTerminal } from "../terminal";

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  badge,
  title,
  onMenu,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  badge?: ReactNode;
  title?: string;
  onMenu?: (x: number, y: number) => void;
}) {
  return (
    <div className="tool">
      <button className="tool-btn" disabled={disabled} onClick={onClick} title={title ?? label}>
        <span className="tool-icon">
          {icon}
          {badge}
        </span>
        <span className="tool-label">{label}</span>
      </button>
      {onMenu && (
        <button
          className="tool-more"
          disabled={disabled}
          title={`${label} options`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.left - 60, r.bottom + 4);
          }}
        >
          <IconChevron size={10} style={{ transform: "rotate(90deg)" }} />
        </button>
      )}
    </div>
  );
}

const PULL_MODES: { mode: PullMode; label: string }[] = [
  { mode: "ff-only", label: "Fast-forward only" },
  { mode: "merge", label: "Pull (merge)" },
  { mode: "rebase", label: "Pull (rebase)" },
];

export function Toolbar() {
  const repo = useStore((s) => s.repo);
  const busy = useStore((s) => s.busy);
  const progress = useStore((s) => s.progress);
  const stashes = useStore((s) => s.stashes);
  const status = useStore((s) => s.status);
  const refresh = useStore((s) => s.refresh);
  const showMenu = useStore((s) => s.showMenu);
  const closeTab = useStore((s) => s.closeTab);
  const undoStack = useUndo((s) => s.stack);
  const pullMode = useSettings((s) => s.pullMode);
  const terminalOpen = useTerminal((s) => s.open);
  if (!repo) return null;
  const undoEntry = nextUndo(undoStack, repo.path);

  const dirty = !!status && (status.staged.length > 0 || status.unstaged.length > 0);
  const disabled = !!busy;

  return (
    <header className="toolbar">
      <div className="toolbar-left">
        <button
          className="repo-btn"
          title={repo.path}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, [
              { label: "Open repository…", onSelect: () => openRepoDialog() },
              { label: "Clone repository…", onSelect: () => useRepoDialog.setState({ kind: "clone" }) },
              { label: "New repository…", onSelect: () => useRepoDialog.setState({ kind: "init" }) },
              { label: "Workspace…", onSelect: () => useWorkspaces.setState({ open: true }) },
              { separator: true, label: "" },
              { label: "Reflog (recover lost commits)…", onSelect: () => useStore.getState().openDiff({ kind: "reflog" }) },
              { separator: true, label: "" },
              { label: "Close tab", onSelect: () => closeTab(repo.path) },
            ]);
          }}
        >
          <IconFolder size={14} />
          <span className="repo-name">{repo.name}</span>
        </button>
        <span className="toolbar-sep">/</span>
        <button
          className="branch-name"
          title={`${repo.upstream ? `tracking ${repo.upstream}` : "no upstream"} — click to switch branch`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            showMenu(r.left, r.bottom + 4, branchSwitchMenu());
          }}
        >
          <IconBranch size={13} />
          {repo.detached ? `detached at ${repo.headOid?.slice(0, 7)}` : repo.headBranch ?? "—"}
          <IconChevron size={10} style={{ transform: "rotate(90deg)" }} />
        </button>
        {repo.state !== "clean" && <span className="state-badge">{repo.state} in progress</span>}
      </div>

      <div className="toolbar-center">
        <ToolButton
          icon={<IconUndo />}
          label="Undo"
          title={undoEntry ? `Undo ${undoEntry.label} (Ctrl+Z)` : "Nothing to undo"}
          onClick={() => undoLast()}
          disabled={disabled || !undoEntry}
        />
        <ToolButton icon={<IconRefresh />} label="Refresh" title="Refresh (F5)" onClick={() => refresh()} disabled={disabled} />
        <span className="tool-gap" />
        <ToolButton
          icon={<IconPull />}
          label="Pull"
          disabled={disabled}
          onClick={() => pull(pullMode)}
          title={`Pull (${PULL_MODES.find((m) => m.mode === pullMode)?.label.toLowerCase()})`}
          badge={repo.behind > 0 ? <span className="tool-badge">{repo.behind}</span> : undefined}
          onMenu={(x, y) => showMenu(x, y, PULL_MODES.map((m) => ({ label: m.label, onSelect: () => pull(m.mode) })))}
        />
        <ToolButton
          icon={<IconPush />}
          label="Push"
          disabled={disabled}
          onClick={() => push(false)}
          badge={repo.ahead > 0 ? <span className="tool-badge">{repo.ahead}</span> : undefined}
          onMenu={(x, y) =>
            showMenu(x, y, [
              { label: "Push", onSelect: () => push(false) },
              { label: "Force push (with lease)…", danger: true, onSelect: () => push(true) },
            ])
          }
        />
        <ToolButton icon={<IconFetch />} label="Fetch" disabled={disabled} onClick={() => fetchAll()} />
        <span className="tool-gap" />
        <ToolButton icon={<IconBranch />} label="Branch" disabled={disabled} onClick={() => createBranch(null)} />
        <ToolButton icon={<IconStash />} label="Stash" disabled={disabled || !dirty} onClick={() => stashSave()} />
        <ToolButton icon={<IconPop />} label="Pop" disabled={disabled || stashes.length === 0} onClick={() => stashPop(0)} />
      </div>

      <div className="toolbar-right">
        {busy && (
          <span className="busy" title={progress ?? undefined}>
            <span className="spinner" />
            {busy}…{progress && <span className="busy-progress">{progress}</span>}
          </span>
        )}
        <ProfileButton />
        <PullRequestsButton />
        <button
          className={`icon-btn${terminalOpen ? " on" : ""}`}
          title="Terminal (Ctrl+`)"
          aria-pressed={terminalOpen}
          onClick={toggleTerminal}
        >
          <IconTerminal size={15} />
        </button>
        <button className="icon-btn" title="Workspace" onClick={() => useWorkspaces.setState({ open: true })}>
          <IconWorkspace size={15} />
        </button>
        <button className="icon-btn" title="Command palette (Ctrl+K)" onClick={() => usePalette.setState({ open: true })}>
          <IconSearch size={15} />
        </button>
        <button className="icon-btn" title="Settings" onClick={() => useSettingsDialog.setState({ open: true })}>
          <IconSettings size={15} />
        </button>
      </div>
    </header>
  );
}
