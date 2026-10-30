// Changing an open request: title, description, draft, reviewers,
// labels. The same picker for labels serves new issues.

import { useEffect, useState } from "react";
import { create } from "zustand";

import { api, errorText, IssueLabel, Person, PullRequest } from "../api";
import { loadInbox, loadPrs, prLabel, usePrView } from "../prs";
import { refreshConversation } from "../review";
import { useStore } from "../store";

export const useEditRequest = create<{ pr: PullRequest | null }>(() => ({ pr: null }));

/** Labels to toggle, shown in their colours. */
export function LabelPicker({ all, chosen, onChange, disabled }: { all: IssueLabel[]; chosen: string[]; onChange: (labels: string[]) => void; disabled?: boolean }) {
  if (!all.length) return <div className="dim">The project has no labels.</div>;
  return (
    <div className="label-picker">
      {all.map((l) => {
        const on = chosen.includes(l.name);
        return (
          <button
            key={l.name}
            type="button"
            className={`issue-label${on ? " on" : ""}`}
            aria-pressed={on}
            disabled={disabled}
            style={l.color ? { borderColor: l.color, background: on ? `color-mix(in srgb, ${l.color} 25%, transparent)` : undefined } : undefined}
            onClick={() => onChange(on ? chosen.filter((x) => x !== l.name) : [...chosen, l.name])}
          >
            {l.color && <span className="issue-label-dot" style={{ background: l.color }} />}
            {l.name}
          </button>
        );
      })}
    </div>
  );
}

export function EditRequestDialog() {
  const pr = useEditRequest((s) => s.pr);
  const repo = useStore((s) => s.repo?.path);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [labels, setLabels] = useState<string[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [allLabels, setAllLabels] = useState<IssueLabel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pr || !repo) return;
    let live = true;
    setLoaded(false);
    setError(null);
    Promise.all([api.pullRequestDetails(repo, pr.remote, pr.number), api.pullRequestForm(repo, pr.remote), api.projectLabels(repo, pr.remote).catch(() => [])]).then(
      ([d, form, ls]) => {
        if (!live) return;
        setTitle(d.title);
        setBody(d.body);
        setDraft(d.draft);
        setReviewers(d.reviewers);
        setLabels(d.labels);
        // Reviewers already asked stay listed even if not members any more.
        const known = new Set(form.people.map((p) => p.username));
        setPeople([...form.people, ...d.reviewers.filter((r) => !known.has(r)).map((r) => ({ id: 0, username: r, name: null }))]);
        setAllLabels([...ls, ...d.labels.filter((l) => !ls.some((x) => x.name === l)).map((name) => ({ name, color: "" }))]);
        setLoaded(true);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [pr, repo]);

  if (!pr) return null;
  const close = () => useEditRequest.setState({ pr: null });
  const save = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      await api.editPullRequest(repo, pr.remote, pr.number, { title, body, draft, reviewers, labels });
      useStore.getState().toast("info", `Saved ${prLabel(pr)}`);
      const shown = usePrView.getState().pr;
      if (shown && shown.number === pr.number && shown.project === pr.project) usePrView.setState({ pr: { ...shown, title: title.trim(), draft } });
      close();
      void loadPrs(repo);
      void loadInbox();
      void refreshConversation();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal wide create-pr"
        role="dialog"
        aria-label="Edit request"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="modal-title">Edit {prLabel(pr)}</div>
        {!loaded && !error && <div className="files-empty">Loading…</div>}
        {loaded && (
          <>
            <label className="modal-label">Title</label>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
            <label className="modal-label">Description</label>
            <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} disabled={busy} />
            {people.length > 0 && (
              <>
                <label className="modal-label">Reviewers</label>
                <div className="create-pr-people">
                  {people.map((p) => (
                    <label key={p.username} className="checkbox">
                      <input
                        type="checkbox"
                        checked={reviewers.includes(p.username)}
                        onChange={(e) => setReviewers((r) => (e.target.checked ? [...r, p.username] : r.filter((x) => x !== p.username)))}
                        disabled={busy}
                      />
                      {p.username}
                      {p.name && <span className="dim">{p.name}</span>}
                    </label>
                  ))}
                </div>
              </>
            )}
            <label className="modal-label">Labels</label>
            <LabelPicker all={allLabels} chosen={labels} onChange={setLabels} disabled={busy} />
            <label className="checkbox">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} />
              Draft (not ready for review)
            </label>
          </>
        )}
        {error && <pre className="modal-error">{error}</pre>}
        <div className="modal-actions">
          <button type="button" className="small-btn" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="small-btn primary" disabled={busy || !loaded || !title.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Close the request (after asking), or reopen it. */
export async function setRequestOpen(pr: PullRequest, open: boolean) {
  const st = useStore.getState();
  const repo = st.repo?.path;
  if (!repo) return;
  if (!open && !(await st.confirm({ title: `Close ${prLabel(pr)}?`, message: `${pr.title}\n\nIt isn't merged; it can be reopened later.`, confirmLabel: "Close request", danger: true }))) {
    return;
  }
  try {
    await api.setPullRequestOpen(repo, pr.remote, pr.number, open);
    st.toast("info", `${open ? "Reopened" : "Closed"} ${prLabel(pr)}`);
    if (!open) usePrView.setState({ pr: null });
    void loadPrs(repo);
    void loadInbox();
  } catch (e) {
    st.toast("error", errorText(e));
  }
}
