// "Create release": a GitHub/GitLab release of a tag. The tag is pushed to
// the remote first (a release of a tag the service doesn't have would be
// made at its default branch instead); the notes start as the commits
// since the previous tag.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, errorText } from "../api";
import { useStore } from "../store";

export const useRelease = create<{ tag: string | null }>(() => ({ tag: null }));

export function ReleaseDialog() {
  const tag = useRelease((s) => s.tag);
  if (!tag) return null;
  return <Form key={tag} tag={tag} />;
}

function Form({ tag }: { tag: string }) {
  const repo = useStore((s) => s.repo?.path);
  const remotes = useStore((s) => s.remotes);
  const [remote, setRemote] = useState(remotes.some((r) => r.name === "origin") ? "origin" : (remotes[0]?.name ?? ""));
  const [name, setName] = useState(tag);
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState(false);
  const [prerelease, setPrerelease] = useState(/-(alpha|beta|rc|pre)/i.test(tag));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => useRelease.setState({ tag: null });

  useEffect(() => {
    if (!repo) return;
    api.releaseNotes(repo, tag).then(setNotes, () => {});
  }, [repo, tag]);

  async function create() {
    if (!repo || !remote) return;
    setBusy(true);
    setError(null);
    const st = useStore.getState();
    try {
      useStore.setState({ busy: `Pushing ${tag}`, progress: null });
      try {
        await api.pushTag(repo, remote, tag, false);
      } finally {
        useStore.setState({ busy: null, progress: null });
      }
      const url = await api.createRelease(repo, remote, { tag, name, notes, draft, prerelease });
      close();
      st.toast("info", `Released ${tag}`);
      void openUrl(url).catch(() => {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal wide create-pr"
        role="dialog"
        aria-label="Create release"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void create();
        }}
      >
        <div className="modal-title">Release {tag}</div>
        <div className="create-pr-branches">
          <span className="dim">on</span>
          <select aria-label="Remote" value={remote} onChange={(e) => setRemote(e.target.value)} disabled={busy}>
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="dim">— the tag is pushed there first</span>
        </div>
        <label className="modal-label">Title</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
        <label className="modal-label">Notes</label>
        <textarea rows={10} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={busy} />
        <div className="release-flags">
          <label className="checkbox">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
            Draft <span className="dim">(GitHub)</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} disabled={busy} />
            Pre-release <span className="dim">(GitHub)</span>
          </label>
        </div>
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={busy || !remote}>
            {busy ? "Releasing…" : "Push tag and release"}
          </button>
        </div>
      </form>
    </div>
  );
}
