import { ReactNode, useMemo, useState } from "react";

import { RefInfo, RemoteInfo } from "../api";
import { addRemote, addWorktree, checkoutRef, submoduleMenu, updateSubmodules, worktreeMenu, createBranch, refMenu, remoteMenu, remoteOf, stashMenu, toggleHidden, toggleSolo } from "../actions";
import { useStore } from "../store";
import { buildTree, RefTree } from "./RefTree";
import { IconEye, IconEyeOff, IconFetch, IconFolder, IconBranch, IconChevron, IconCloud, IconLaptop, IconPlus, IconStash, IconTag } from "./Icons";

function Section({
  title,
  icon,
  count,
  children,
  action,
}: {
  title: string;
  icon: ReactNode;
  count: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="side-section">
      <div className="side-title" onClick={() => setOpen(!open)}>
        <IconChevron size={12} open={open} />
        {icon}
        <span className="side-title-text">{title}</span>
        <span className="side-count">{count}</span>
        {action && (
          <span className="side-action" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
      </div>
      {open && <div className="side-items">{children}</div>}
    </div>
  );
}

function RefItem({ r, label, indent = 0 }: { r: RefInfo; label: string; indent?: number }) {
  const select = useStore((s) => s.select);
  const showMenu = useStore((s) => s.showMenu);
  const filter = useStore((s) => s.graphFilter);
  const hidden = filter.solo.length ? !filter.solo.includes(r.fullName) : filter.hidden.includes(r.fullName);
  const solo = filter.solo.includes(r.fullName);
  return (
    <div
      className={`side-item${r.isHead ? " head" : ""}${hidden ? " hidden-ref" : ""}`}
      style={{ paddingLeft: 24 + indent * 12 }}
      title={r.upstream ? `${r.name} → ${r.upstream}` : r.name}
      onClick={() => select(r.target, true)}
      onDoubleClick={() => checkoutRef(r)}
      onContextMenu={(e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, refMenu(r));
      }}
    >
      {r.isHead && <span className="side-head-dot" />}
      <span className="side-item-label">{label}</span>
      {(r.ahead > 0 || r.behind > 0) && (
        <span className="ahead-behind">
          {r.behind > 0 && <span title={`${r.behind} behind ${r.upstream}`}>↓{r.behind}</span>}
          {r.ahead > 0 && <span title={`${r.ahead} ahead of ${r.upstream}`}>↑{r.ahead}</span>}
        </span>
      )}
      {solo && <span className="solo-badge">solo</span>}
      {!r.isHead && (
        <button
          className={`eye-btn${hidden && !filter.solo.length ? " on" : ""}`}
          title={hidden ? "Show in graph" : "Hide in graph"}
          onClick={(e) => {
            e.stopPropagation();
            if (filter.solo.length) toggleSolo(r);
            else toggleHidden(r);
          }}
        >
          {hidden ? <IconEyeOff size={12} /> : <IconEye size={12} />}
        </button>
      )}
    </div>
  );
}

export function Sidebar() {
  const graph = useStore((s) => s.graph);
  const stashes = useStore((s) => s.stashes);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const showMenu = useStore((s) => s.showMenu);
  const [filter, setFilter] = useState("");

  const { locals, remotes, tags } = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const refs = (graph?.refs ?? []).filter((r) => !f || r.name.toLowerCase().includes(f));
    const remotes = new Map<string, RefInfo[]>();
    for (const r of refs.filter((r) => r.kind === "remote")) {
      const { remote } = remoteOf(r);
      remotes.set(remote, [...(remotes.get(remote) ?? []), r]);
    }
    return {
      locals: refs.filter((r) => r.kind === "local"),
      remotes,
      tags: refs.filter((r) => r.kind === "tag").sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })),
    };
  }, [graph, filter]);

  const remoteCount = [...remotes.values()].reduce((n, l) => n + l.length, 0);
  const allRemotes = useStore((s) => s.remotes);
  const worktrees = useStore((s) => s.worktrees);
  const submodules = useStore((s) => s.submodules);
  const openRepo = useStore((s) => s.openRepo);
  const repoPath = useStore((s) => s.repo?.path.replace(/\/+$/, ""));

  return (
    <aside className="sidebar">
      <div className="side-filter">
        <input placeholder="Filter branches & tags" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="side-scroll">
        <Section
          title="Local"
          icon={<IconLaptop size={13} />}
          count={locals.length}
          action={
            <button className="icon-btn" title="New branch at HEAD" onClick={() => createBranch(null)}>
              <IconPlus size={12} />
            </button>
          }
        >
          <RefTree
            tree={buildTree(locals, (r) => r.name)}
            indent={1}
            forceOpen={!!filter.trim()}
            renderLeaf={(r, label, depth) => <RefItem key={r.fullName} r={r} label={label} indent={depth - 1} />}
          />
        </Section>
        <Section
          title="Remote"
          icon={<IconCloud size={13} />}
          count={remoteCount}
          action={
            <button className="icon-btn" title="Add remote" onClick={() => addRemote()}>
              <IconPlus size={12} />
            </button>
          }
        >
          {allRemotes.map((rm) => (
            <RemoteGroup key={rm.name} remote={rm} list={remotes.get(rm.name) ?? []} filtering={!!filter.trim()} />
          ))}
        </Section>
        <Section title="Tags" icon={<IconTag size={13} />} count={tags.length}>
          {tags.map((r) => (
            <RefItem key={r.fullName} r={r} label={r.name} />
          ))}
        </Section>
        {worktrees.length > 1 && (
          <Section
            title="Worktrees"
            icon={<IconFolder size={13} />}
            count={worktrees.length}
            action={
              <button className="icon-btn" title="New worktree" onClick={() => addWorktree()}>
                <IconPlus size={12} />
              </button>
            }
          >
            {worktrees.map((wt) => {
              const current = repoPath === wt.path.replace(/\/+$/, "");
              return (
                <div
                  key={wt.path}
                  className={`side-item${current ? " head" : ""}${wt.prunable ? " hidden-ref" : ""}`}
                  style={{ paddingLeft: 24 }}
                  title={wt.path}
                  onDoubleClick={() => !current && !wt.prunable && openRepo(wt.path)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    showMenu(e.clientX, e.clientY, worktreeMenu(wt));
                  }}
                >
                  {current && <span className="side-head-dot" />}
                  <span className="side-item-label">{wt.path.split("/").pop()}</span>
                  <span className="side-count">{wt.main ? "main" : (wt.branch ?? "detached")}</span>
                </div>
              );
            })}
          </Section>
        )}
        {submodules.length > 0 && (
          <Section
            title="Submodules"
            icon={<IconFolder size={13} />}
            count={submodules.length}
            action={
              <button className="icon-btn" title="Update all (init + checkout)" onClick={() => updateSubmodules()}>
                <IconFetch size={12} />
              </button>
            }
          >
            {submodules.map((sm) => (
              <div
                key={sm.path}
                className={`side-item${sm.initialized ? "" : " hidden-ref"}`}
                style={{ paddingLeft: 24 }}
                title={`${sm.path}${sm.url ? `\n${sm.url}` : ""}${sm.initialized ? "" : "\nnot checked out"}`}
                onDoubleClick={() => sm.initialized && openRepo(`${repoPath}/${sm.path}`)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  showMenu(e.clientX, e.clientY, submoduleMenu(sm));
                }}
              >
                <span className="side-item-label">{sm.name}</span>
                {sm.modified && <span className="side-count">changed</span>}
                {!sm.initialized && <span className="side-count">not cloned</span>}
              </div>
            ))}
          </Section>
        )}
        <Section title="Stashes" icon={<IconStash size={13} />} count={stashes.length}>
          {stashes.map((st) => (
            <div
              key={st.id}
              className={`side-item${selectedId === st.id ? " selected" : ""}`}
              style={{ paddingLeft: 24 }}
              title={st.message}
              onClick={() => select(st.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                showMenu(e.clientX, e.clientY, stashMenu(st));
              }}
            >
              <span className="side-item-label">{st.message}</span>
            </div>
          ))}
        </Section>
      </div>
    </aside>
  );
}

function RemoteGroup({ remote, list, filtering }: { remote: RemoteInfo; list: RefInfo[]; filtering: boolean }) {
  const [open, setOpen] = useState(true);
  const showMenu = useStore((s) => s.showMenu);
  return (
    <>
      <div
        className="side-item group"
        style={{ paddingLeft: 18 }}
        title={remote.url ?? undefined}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e.clientX, e.clientY, remoteMenu(remote));
        }}
      >
        <IconChevron size={11} open={open} />
        <IconBranch size={12} />
        <span className="side-item-label">{remote.name}</span>
        {list.length === 0 && <span className="side-count">not fetched</span>}
      </div>
      {open && (
        <RefTree
          tree={buildTree(list, (r) => remoteOf(r).branch)}
          indent={2}
          forceOpen={filtering}
          renderLeaf={(r, label, depth) => <RefItem key={r.fullName} r={r} label={label} indent={depth - 1} />}
        />
      )}
    </>
  );
}
