// What the title bar holds besides the tabs: the app menu, the search box
// (the command palette), pull requests waiting for the user across all
// accounts, background work and recent problems, and the user's picture.

import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ReactNode, useEffect, useState } from "react";
import { create } from "zustand";

import { newWindow } from "../actions";
import { clearProblems, seeProblems, useActivity } from "../activity";
import { api, PullRequest } from "../api";
import { relativeTime } from "../format";
import { loadInbox, prKey, usePrs, wantsReview } from "../prs";
import { useProfiles, switchProfile } from "../profiles";
import { loadRecent } from "../recent";
import { useSettings } from "../settings";
import { checkForUpdates, installUpdate, updateStatus, useUpdates } from "../updates";
import { MenuItem, useStore } from "../store";
import { reviewPullRequest, useWorkspaces } from "../workspaces";
import { useCi } from "../ci";
import { CiMark } from "./CiMark";
import { openCi } from "./CiDialog";
import { Avatar } from "./Avatar";
import { usePalette } from "./CommandPalette";
import { IconActivity, IconAlert, IconBell, IconFetch, IconSearch, IconUser } from "./Icons";
import { PrRow } from "./PullRequestsDialog";
import { useRepoDialog } from "./RepoDialogs";
import { useSettingsDialog } from "./SettingsDialog";
import { useShortcuts } from "./ShortcutsDialog";
import { openRepoDialog } from "./Welcome";

export const useAbout = create<{ open: boolean }>(() => ({ open: false }));

function menuAt(el: HTMLElement, items: MenuItem[], alignRight = false) {
  const r = el.getBoundingClientRect();
  useStore.getState().showMenu(alignRight ? r.right - 260 : r.left, r.bottom + 4, items);
}

/** The gitbrix mark: open, clone, recent repositories, settings, about, quit. */
export function AppMenu({ onQuit, onCloseWindow }: { onQuit: () => void; onCloseWindow: () => void }) {
  return (
    <button
      type="button"
      className="app-menu-btn"
      title="gitbrix menu"
      aria-label="gitbrix menu"
      onClick={(e) => {
        const recent = loadRecent().slice(0, 8);
        menuAt(e.currentTarget, [
          { label: "Open repository…", hint: "Ctrl+O", onSelect: () => void openRepoDialog() },
          { label: "Clone repository…", onSelect: () => useRepoDialog.setState({ kind: "clone" }) },
          { label: "New repository…", onSelect: () => useRepoDialog.setState({ kind: "init" }) },
          { label: "New window", hint: "Ctrl+Shift+N", onSelect: () => newWindow() },
          ...(recent.length
            ? [
                { separator: true, label: "" },
                { label: "Recent", disabled: true },
                ...recent.map((r) => ({
                  label: r.name,
                  hint: r.path.replace(/^(\/home\/[^/]+|[A-Za-z]:[\\/]Users[\\/][^\\/]+)/, "~"),
                  onSelect: () => void useStore.getState().openRepo(r.path),
                })),
              ]
            : []),
          { separator: true, label: "" },
          { label: "Command palette…", hint: "Ctrl+K", onSelect: () => usePalette.setState({ open: true }) },
          { label: "Settings…", onSelect: () => useSettingsDialog.setState({ open: true }) },
          { label: "Keyboard shortcuts", hint: "?", onSelect: () => useShortcuts.setState({ open: true }) },
          { label: "About gitbrix", onSelect: () => useAbout.setState({ open: true }) },
          { separator: true, label: "" },
          { label: "Close window", hint: "Alt+F4", onSelect: onCloseWindow },
          { label: "Quit", hint: "Ctrl+Q", onSelect: onQuit },
        ]);
      }}
    >
      <img src="/gitbrix.svg" alt="" width={16} height={16} draggable={false} />
    </button>
  );
}

/** Looks like a search field; opens the command palette, which searches. */
export function TitleSearch() {
  return (
    <button type="button" className="title-search" onClick={() => usePalette.setState({ open: true })}>
      <IconSearch size={12} />
      <span className="title-search-text">Search or run a command…</span>
      <kbd>Ctrl K</kbd>
    </button>
  );
}

/** A panel under a title bar button; closes on a click outside or Escape. */
export function Popover({
  anchor,
  onClose,
  children,
  label,
  align = "right",
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
  label: string;
  /** Which edge of the anchor the popover lines up with. */
  align?: "left" | "right";
}) {
  const r = anchor.getBoundingClientRect();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  return (
    <>
      <div className="menu-backdrop" onMouseDown={onClose} />
      <div
        className="title-popover"
        role="dialog"
        aria-label={label}
        style={
          align === "right"
            ? { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right - 8) }
            : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 428)) }
        }
      >
        {children}
      </div>
    </>
  );
}

/** A request from the account-wide list, as the repository that has it
 * locally knows it (with its remote), if one does. */
function localCopy(pr: PullRequest): { path: string; pr: PullRequest } | null {
  for (const [path, data] of Object.entries(usePrs.getState().byRepo)) {
    const hit = data.items.find((p) => prKey(p) === prKey(pr));
    if (hit) return { path, pr: hit };
  }
  return null;
}

function openInboxPr(pr: PullRequest) {
  const local = localCopy(pr);
  if (local) void reviewPullRequest(local.path, local.pr);
  else void openUrl(pr.url).catch(() => {});
}

function shortProject(project: string): string {
  return project.split("/").slice(-2).join("/");
}

/** Requests involving the user on every account; the count is those
 * waiting for their review or approval. */
export function InboxBell() {
  const inbox = usePrs((s) => s.inbox);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items = [...(inbox?.items ?? [])].sort((a, b) => b.created.localeCompare(a.created));
  const waitingFor = (p: PullRequest) => wantsReview(p) || (p.reviewRequested && !p.mine && !p.approvedByMe);
  const waiting = items.filter(waitingFor);
  const groups: [string, PullRequest[]][] = [
    ["Waiting for you", waiting],
    ["Yours", items.filter((p) => p.mine)],
    ["Assigned and others", items.filter((p) => !p.mine && !waitingFor(p))],
  ];
  const noAccounts = !!inbox && !inbox.loading && !inbox.accounts.length && !inbox.items.length;
  return (
    <>
      <button
        type="button"
        className={`title-btn bell${waiting.length ? " waiting" : ""}${anchor ? " on" : ""}`}
        title={waiting.length ? `${waiting.length} pull request${waiting.length === 1 ? "" : "s"} waiting for you` : "Pull requests for you"}
        aria-label="Pull requests for you"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        <IconBell size={15} />
        {waiting.length > 0 && <span className="title-count">{waiting.length}</span>}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="Pull requests for you">
          <div className="title-popover-head">
            <span>Pull requests for you</span>
            <button
              type="button"
              className={`icon-btn${inbox?.loading ? " spinning" : ""}`}
              title="Check again"
              onClick={() => void loadInbox()}
            >
              <IconFetch size={12} />
            </button>
          </div>
          <div className="title-popover-body">
            {noAccounts ? (
              <div className="pr-empty">
                Add a GitHub or GitLab account to see requests here.{" "}
                <button
                  type="button"
                  className="small-btn"
                  onClick={() => {
                    setAnchor(null);
                    useSettingsDialog.setState({ open: true });
                  }}
                >
                  Open Settings
                </button>
              </div>
            ) : (
              groups
                .filter(([, list]) => list.length)
                .map(([title, list]) => (
                  <section key={title} className="inbox-group">
                    <div className="inbox-group-title">
                      {title} <span className="side-count">{list.length}</span>
                    </div>
                    {list.map((pr) => (
                      <PrRow
                        key={prKey(pr)}
                        pr={pr}
                        where={shortProject(pr.project)}
                        onOpen={() => {
                          setAnchor(null);
                          openInboxPr(pr);
                        }}
                      />
                    ))}
                  </section>
                ))
            )}
            {!noAccounts && inbox && !inbox.loading && !items.length && <div className="pr-empty">Nothing involves you right now</div>}
            {!inbox && <div className="pr-empty">Loading…</div>}
            {[...(inbox?.error ? [inbox.error] : []), ...(inbox?.problems ?? [])].map((p) => (
              <p key={p} className="modal-error">
                {p}
              </p>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** Background work while it runs; a warning while problems are unseen. */
export function ActivityButton() {
  const running = useActivity((s) => s.running);
  const problems = useActivity((s) => s.problems);
  const unseen = useActivity((s) => s.unseen);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!running.length && !problems.length) return null;
  const close = () => setAnchor(null);
  return (
    <>
      <button
        type="button"
        className={`title-btn activity${unseen ? " problem" : ""}${anchor ? " on" : ""}`}
        title={running.length ? running.map((t) => t.label).join("\n") : unseen ? `${unseen} new problem${unseen === 1 ? "" : "s"}` : "Recent problems"}
        aria-label="Background work"
        onClick={(e) => {
          if (anchor) return close();
          setAnchor(e.currentTarget);
          seeProblems();
        }}
      >
        {running.length ? (
          <>
            <span className="spinner" />
            <span className="activity-label">{running[0].label}</span>
            {running.length > 1 && <span className="dim">+{running.length - 1}</span>}
          </>
        ) : unseen ? (
          <>
            <IconAlert size={14} />
            <span className="title-count">{unseen}</span>
          </>
        ) : (
          <IconActivity size={14} />
        )}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} label="Background work">
          <div className="title-popover-head">
            <span>Background work</span>
            {problems.length > 0 && (
              <button type="button" className="small-btn" onClick={clearProblems}>
                Clear
              </button>
            )}
          </div>
          <div className="title-popover-body">
            {running.map((t) => (
              <div key={t.id} className="activity-row">
                <span className="spinner" /> {t.label}
              </div>
            ))}
            {!running.length && <div className="activity-row dim">Nothing running</div>}
            {problems.length > 0 && <div className="inbox-group-title">Recent problems</div>}
            {problems.map((p) => (
              <div key={p.id} className="activity-row problem">
                <div className="activity-row-head">
                  <span>{p.label}</span>
                  <span className="dim">
                    {p.count > 1 && `${p.count}× · `}
                    {relativeTime(p.time / 1000)}
                  </span>
                </div>
                <div className="activity-text">{p.text}</div>
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}

/** The user's picture: who commits here, the accounts, the profiles. */
export function AccountButton() {
  const identity = useProfiles((s) => s.identity);
  const profiles = useProfiles((s) => s.profiles);
  const active = profiles.list.find((p) => p.id === profiles.active);
  const email = identity?.email ?? active?.userEmail ?? null;
  const name = identity?.name ?? active?.userName ?? "";
  return (
    <button
      type="button"
      className="title-btn account"
      title={email ? `${name} <${email}>` : "Accounts and profiles"}
      aria-label="Accounts and profiles"
      onClick={async (e) => {
        const el = e.currentTarget;
        const accounts = await api.accounts().catch(() => []);
        menuAt(
          el,
          [
            ...(email ? [{ label: name || email, hint: email, disabled: true }] : [{ label: "No commit identity", disabled: true }]),
            { separator: true, label: "" },
            ...(accounts.length
              ? accounts.map((a) => ({
                  label: `${a.provider === "github" ? "GitHub" : "GitLab"} · ${a.username}`,
                  hint: a.url.replace(/^https?:\/\//, ""),
                  onSelect: () => useSettingsDialog.setState({ open: true }),
                }))
              : [{ label: "No GitHub or GitLab account", disabled: true }]),
            ...(profiles.list.length
              ? [
                  { separator: true, label: "" },
                  ...profiles.list.map((p) => ({
                    label: `${profiles.active === p.id ? "✓ " : ""}${p.name}`,
                    hint: p.userEmail,
                    onSelect: () => void switchProfile(p.id),
                  })),
                  { label: `${profiles.active ? "" : "✓ "}No profile`, hint: "git config", onSelect: () => void switchProfile(null) },
                ]
              : []),
            { separator: true, label: "" },
            { label: "Accounts and profiles…", onSelect: () => useSettingsDialog.setState({ open: true }) },
          ],
          true,
        );
      }}
    >
      {email ? <Avatar email={email} name={name || email} size={20} /> : <IconUser size={15} />}
    </button>
  );
}

function UpdateBox() {
  const { info, checking, installing, error } = useUpdates();
  const address = useSettings((s) => s.updateUrl.trim());
  const status = updateStatus(info);
  return (
    <div className="update-box">
      {status && <div className={info?.version ? "update-new" : "dim"}>{status}</div>}
      {info?.version && info.notes && <pre className="update-notes">{info.notes}</pre>}
      {error && <div className="modal-error">{error}</div>}
      {!address ? (
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            useAbout.setState({ open: false });
            useSettingsDialog.setState({ open: true });
          }}
        >
          Set a release address in Settings to get updates
        </button>
      ) : info?.version && info.canInstall ? (
        <button type="button" className="small-btn primary" disabled={installing} onClick={() => void installUpdate()}>
          {installing ? "Installing…" : `Install ${info.version} and restart`}
        </button>
      ) : (
        <button type="button" className="small-btn" disabled={checking} onClick={() => void checkForUpdates()}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      )}
    </div>
  );
}

/** The checked-out commit's CI, for the branch being worked on. */
export function BranchCi() {
  const repo = useStore((s) => s.repo);
  const onWorkspaces = useWorkspaces((s) => s.open);
  const ci = useCi((s) => (repo?.headOid && s.repo === repo.path ? s.statuses[repo.headOid] : undefined));
  if (!repo || !ci || onWorkspaces) return null;
  const word: Record<string, string> = { success: "passed", failed: "failed", running: "running", pending: "pending", canceled: "canceled", skipped: "skipped", manual: "manual" };
  return (
    <button
      type="button"
      className={`title-btn branch-ci ci-${ci.state}`}
      title={`CI of ${repo.headBranch ?? "the checked-out commit"}: ${word[ci.state] ?? ci.state} — click for jobs and logs`}
      aria-label="CI of the checked-out branch"
      onClick={() => openCi(repo.headOid!)}
    >
      <CiMark state={ci.state} />
      <span className="branch-ci-text">
        {repo.headBranch ?? repo.headOid?.slice(0, 7)} {word[ci.state] ?? ci.state}
      </span>
    </button>
  );
}

export function AboutDialog() {
  const open = useAbout((s) => s.open);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (open) void getVersion().then(setVersion, () => setVersion(null));
  }, [open]);
  if (!open) return null;
  const close = () => useAbout.setState({ open: false });
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal about"
        role="dialog"
        aria-label="About gitbrix"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <img src="/gitbrix.svg" alt="" width={56} height={56} />
        <h2>gitbrix</h2>
        {version && <div className="dim">Version {version}</div>}
        <p className="dim">A graph-first Git client</p>
        <UpdateBox />
        <div className="modal-actions">
          <button type="button" className="small-btn primary" onClick={close} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
