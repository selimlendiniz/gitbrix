// "Create pull request" form: source → target branch on a remote's
// GitHub/GitLab project, title, description, draft and reviewers. Pushes
// the branch first when the remote doesn't have its latest commit.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";

import { api, errorText, RequestForm } from "../api";
import { loadPrs, useCreatePr } from "../prs";
import { useStore } from "../store";

export function CreatePullRequestDialog() {
  const branch = useCreatePr((s) => s.branch);
  if (!branch) return null;
  return <Form key={branch} initialSource={branch} />;
}

function Form({ initialSource }: { initialSource: string }) {
  const repo = useStore((s) => s.repo);
  const refs = useStore((s) => s.graph?.refs ?? []);
  const commits = useStore((s) => s.graph?.commits ?? []);
  const remotes = useStore((s) => s.remotes);
  const close = () => useCreatePr.setState({ branch: null });

  const locals = refs.filter((r) => r.kind === "local");
  const [remote, setRemote] = useState(remotes.some((r) => r.name === "origin") ? "origin" : (remotes[0]?.name ?? ""));
  const [source, setSource] = useState(initialSource);
  const [target, setTarget] = useState("");
  const tip = locals.find((r) => r.name === source);
  const [title, setTitle] = useState(() => commits.find((c) => c.id === tip?.target)?.summary ?? source);
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<number[]>([]);
  const [who, setWho] = useState("");
  const [form, setForm] = useState<RequestForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!repo || !remote) return;
    let live = true;
    setForm(null);
    setError(null);
    api
      .pullRequestForm(repo.path, remote)
      .then((f) => {
        if (!live) return;
        setForm(f);
        setTarget((t) => t || f.defaultBranch);
      })
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [repo?.path, remote]);

  // Branches the remote has, as targets.
  const targets = useMemo(
    () =>
      refs
        .filter((r) => r.kind === "remote" && r.name.startsWith(`${remote}/`) && !r.name.endsWith("/HEAD"))
        .map((r) => r.name.slice(remote.length + 1))
        .filter((b) => b !== source),
    [refs, remote, source],
  );
  const remoteTip = refs.find((r) => r.kind === "remote" && r.name === `${remote}/${source}`);
  // Push first when the remote lacks the branch or its latest commit.
  const needsPush = !remoteTip || remoteTip.target !== tip?.target;
  const people = (form?.people ?? []).filter(
    (p) => !who || p.username.toLowerCase().includes(who.toLowerCase()) || p.name?.toLowerCase().includes(who.toLowerCase()),
  );
  const label = form?.provider === "gitlab" ? "merge request" : "pull request";

  async function submit() {
    if (!repo || !form) return;
    setBusy(true);
    setError(null);
    const st = useStore.getState();
    try {
      if (needsPush) {
        useStore.setState({ busy: `Pushing ${source}`, progress: null });
        try {
          await api.pushBranch(repo.path, remote, source, false);
        } finally {
          useStore.setState({ busy: null, progress: null });
        }
      }
      const created = await api.createPullRequest(repo.path, remote, {
        source,
        target,
        title,
        body,
        draft,
        reviewers,
      });
      close();
      const name = form.provider === "gitlab" ? `!${created.number}` : `#${created.number}`;
      st.toast("info", `Opened ${name}${created.warning ? ` — ${created.warning}` : ""}`);
      void openUrl(created.url).catch(() => {});
      void st.refresh();
      void loadPrs(repo.path);
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
        aria-label="Create pull request"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && form && title.trim() && target) void submit();
        }}
      >
        <div className="modal-title">Create {label}</div>
        <div className="create-pr-branches">
          <select aria-label="Source branch" value={source} onChange={(e) => setSource(e.target.value)} disabled={busy}>
            {locals.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="dim">into</span>
          <select aria-label="Remote" value={remote} onChange={(e) => setRemote(e.target.value)} disabled={busy}>
            {remotes.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          <span className="dim">/</span>
          <select aria-label="Target branch" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy || !form}>
            {!targets.includes(target) && target && <option value={target}>{target}</option>}
            {targets.map((b) => (
              <option key={b} value={b}>
                {b}
                {b === form?.defaultBranch ? " (default)" : ""}
              </option>
            ))}
          </select>
        </div>
        {form && <div className="dim create-pr-project">{form.project}</div>}
        <label className="modal-label">Title</label>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        <label className="modal-label">Description</label>
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changes and why" disabled={busy} />
        {form && form.people.length > 0 && (
          <>
            <label className="modal-label">
              Reviewers{" "}
              {reviewers.length > 0 && (
                <span className="dim">
                  ({form.people.filter((p) => reviewers.includes(p.id)).map((p) => p.username).join(", ")})
                </span>
              )}
            </label>
            <input placeholder="Filter people" value={who} onChange={(e) => setWho(e.target.value)} disabled={busy} />
            <div className="create-pr-people">
              {people.map((p) => (
                <label key={p.id} className="checkbox">
                  <input
                    type="checkbox"
                    checked={reviewers.includes(p.id)}
                    onChange={(e) => setReviewers((r) => (e.target.checked ? [...r, p.id] : r.filter((x) => x !== p.id)))}
                    disabled={busy}
                  />
                  {p.username}
                  {p.name && <span className="dim">{p.name}</span>}
                </label>
              ))}
            </div>
          </>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
          Draft
        </label>
        {needsPush && tip && (
          <div className="dim create-pr-note">
            {remoteTip ? `${remote}/${source} is behind ${source};` : `${remote} doesn't have ${source} yet;`} it is pushed first.
          </div>
        )}
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={busy || !form || !title.trim() || !target}>
            {busy ? "Creating…" : needsPush ? `Push and create ${label}` : `Create ${label}`}
          </button>
        </div>
      </form>
    </div>
  );
}
