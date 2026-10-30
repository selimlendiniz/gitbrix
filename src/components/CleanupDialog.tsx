// "Clean up branches": local branches merged into the checked-out or main
// branch, local branches whose upstream was deleted on the remote, and
// remote branches merged into the remote's main branch — delete the
// ticked ones at once. Local deletions can be undone (Ctrl+Z).

import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, errorText, StaleBranch } from "../api";
import { relativeTime } from "../format";
import { useStore } from "../store";
import { pushUndo } from "../undo";

export const useCleanup = create<{ open: boolean }>(() => ({ open: false }));

const key = (b: StaleBranch) => `${b.remote ? "r" : "l"}:${b.name}`;

export function CleanupDialog() {
  const open = useCleanup((s) => s.open);
  const repo = useStore((s) => s.repo?.path);
  const [list, setList] = useState<StaleBranch[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !repo) return;
    let live = true;
    setList(null);
    setError(null);
    api
      .staleBranches(repo)
      .then((l) => {
        if (!live) return;
        setList(l);
        // Merged local branches are safe; the rest waits for a tick.
        setPicked(new Set(l.filter((b) => !b.remote && b.merged).map(key)));
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [open, repo]);

  if (!open || !repo) return null;
  const close = () => useCleanup.setState({ open: false });
  const chosen = (list ?? []).filter((b) => picked.has(key(b)));
  const remotes = chosen.filter((b) => b.remote).length;
  const unmerged = chosen.filter((b) => !b.merged).length;

  async function remove() {
    const st = useStore.getState();
    if (remotes) {
      const ok = await st.confirm({
        title: "Delete remote branches",
        message: `${remotes} of these branches are deleted on the remote, for everyone using it. Go on?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const failed: string[] = [];
    const tips = new Map((st.graph?.refs ?? []).filter((r) => r.kind === "local").map((r) => [r.name, r.target]));
    for (const b of chosen) {
      try {
        if (b.remote) {
          const i = b.name.indexOf("/");
          await api.deleteRemoteBranch(repo!, b.name.slice(0, i), b.name.slice(i + 1));
        } else {
          await api.deleteBranch(repo!, b.name, !b.merged);
          const tip = tips.get(b.name);
          if (tip) pushUndo({ label: `delete branch ${b.name}`, repo: repo!, run: (r) => api.createBranch(r, b.name, tip, false) });
        }
      } catch (e) {
        failed.push(`${b.name}: ${errorText(e)}`);
      }
    }
    setBusy(false);
    const done = chosen.length - failed.length;
    if (done) st.toast("info", `Deleted ${done} branch${done === 1 ? "" : "es"}`);
    void st.refresh();
    if (failed.length) setError(failed.join("\n"));
    else close();
  }

  const toggle = (b: StaleBranch, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(key(b));
      else next.delete(key(b));
      return next;
    });

  const section = (title: string, items: StaleBranch[]) =>
    items.length > 0 && (
      <>
        <div className="cleanup-title">{title}</div>
        {items.map((b) => (
          <label key={key(b)} className="cleanup-row">
            <input type="checkbox" checked={picked.has(key(b))} onChange={(e) => toggle(b, e.target.checked)} disabled={busy} />
            <span className="cleanup-name">{b.name}</span>
            <span className="dim cleanup-why">
              {b.reason === "gone" ? `${b.into} was deleted` : `merged into ${b.into}`} · {relativeTime(b.time)}
            </span>
          </label>
        ))}
      </>
    );

  const items = list ?? [];
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal wide cleanup"
        role="dialog"
        aria-label="Clean up branches"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="modal-title">Clean up branches</div>
        {!list && !error && <div className="dim">Looking…</div>}
        {list && !list.length && <div className="dim">Nothing to clean up: every branch has work that isn't merged.</div>}
        {section("Merged local branches", items.filter((b) => !b.remote && b.reason === "merged"))}
        {section("Local branches whose remote branch was deleted", items.filter((b) => !b.remote && b.reason === "gone"))}
        {section("Merged remote branches (deleted for everyone)", items.filter((b) => b.remote))}
        {unmerged > 0 && (
          <div className="cleanup-warn">
            {unmerged} ticked branch{unmerged === 1 ? " has" : "es have"} commits that may not be merged anywhere; Ctrl+Z brings a local one back.
          </div>
        )}
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="small-btn danger" disabled={busy || !chosen.length} onClick={() => void remove()}>
            {busy ? "Deleting…" : `Delete ${chosen.length} branch${chosen.length === 1 ? "" : "es"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
