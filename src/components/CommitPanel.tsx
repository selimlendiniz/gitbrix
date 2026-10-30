import { useMemo } from "react";

import { checkoutRef, fileItems, refMenu, stashApply, stashDrop, stashPop } from "../actions";
import { fullTime, shortId } from "../format";
import { Avatar } from "./Avatar";
import { useStore } from "../store";
import { FileList } from "./FileList";
import { updateSettings, useSettings } from "../settings";
import { IconBranch, IconCloud, IconFile, IconFolder, IconTag } from "./Icons";

export function CommitPanel() {
  const details = useStore((s) => s.details);
  const selectedId = useStore((s) => s.selectedId);
  const diffSource = useStore((s) => s.diffSource);
  const openDiff = useStore((s) => s.openDiff);
  const select = useStore((s) => s.select);
  const toast = useStore((s) => s.toast);
  const showMenu = useStore((s) => s.showMenu);
  const stashes = useStore((s) => s.stashes);

  if (!details || details.id !== selectedId) {
    return <div className="panel-loading">Loading commit…</div>;
  }

  const stash = stashes.find((st) => st.id === details.id);
  const [summary, ...bodyLines] = details.message.split("\n");
  const coAuthors = coAuthorsOf(details.message);
  // Trailers shown as people below, not repeated in the body.
  const body = bodyLines
    .filter((l) => !/^co-authored-by:/i.test(l.trim()))
    .join("\n")
    .trim();
  const sameCommitter =
    details.author.email === details.committer.email && details.author.time === details.committer.time;
  const adds = details.files.reduce((n, f) => n + f.additions, 0);
  const dels = details.files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div className="commit-panel">
      <div className="commit-head">
        {stash && <div className="stash-kicker">stash@{"{"}{stash.index}{"}"}</div>}
        <div className="commit-summary">{stash ? stash.message : summary}</div>
        {body && !stash && <pre className="commit-body">{body}</pre>}
        {!stash && (
          <div className="stash-actions">
            <button className="small-btn" onClick={() => void useStore.getState().openDiff({ kind: "tree", rev: details.id, path: null })}>
              Browse files
            </button>
          </div>
        )}
        {stash && (
          <div className="stash-actions">
            <button className="small-btn primary" onClick={() => stashPop(stash.index)}>
              Pop
            </button>
            <button className="small-btn" onClick={() => stashApply(stash.index)}>
              Apply
            </button>
            <button className="small-btn danger" onClick={() => stashDrop(stash)}>
              Drop
            </button>
          </div>
        )}
      </div>

      <div className="commit-meta">
        <Avatar email={details.author.email} name={details.author.name} size={34} />
        <div className="commit-people">
          <div>
            <strong>{details.author.name}</strong> <span className="dim">&lt;{details.author.email}&gt;</span>
          </div>
          <div className="dim">authored {fullTime(details.author.time)}</div>
          {!sameCommitter && (
            <div className="dim">
              committed by {details.committer.name} {fullTime(details.committer.time)}
            </div>
          )}
          {coAuthors.length > 0 && (
            <div className="dim">
              with{" "}
              {coAuthors.map((c) => (
                <span key={c.email || c.name} className="coauthor" title={c.email}>
                  <Avatar email={c.email} name={c.name} size={14} />
                  {c.name}
                </span>
              ))}
            </div>
          )}
          {details.signed && (
            <div>
              <span className="signed-badge" title="The commit carries a signature (not verified here)">
                signed
              </span>
            </div>
          )}
        </div>
      </div>

      {!stash && <CommitRefs id={details.id} />}

      <div className="commit-ids" style={stash ? { display: "none" } : undefined}>
        <span className="dim">commit</span>
        <button
          className="sha"
          title="Copy full SHA"
          onClick={() => navigator.clipboard?.writeText(details.id).then(() => toast("info", "Copied SHA"))}
        >
          {shortId(details.id)}
        </button>
        {details.parents.length > 0 && <span className="dim">{details.parents.length > 1 ? "parents" : "parent"}</span>}
        {details.parents.map((p) => (
          <button key={p} className="sha link" onClick={() => select(p, true)}>
            {shortId(p)}
          </button>
        ))}
      </div>

      <div className="panel-subhead">
        <span>
          {details.files.length} file{details.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="subhead-actions">
          <span className="file-stat">
            <span className="add">+{adds}</span> <span className="del">−{dels}</span>
          </span>
          <FileViewToggle />
        </span>
      </div>
      <FileList
        files={details.files}
        activePath={diffSource?.kind === "commit" ? diffSource.path : null}
        onOpen={(f) => openDiff({ kind: "commit", id: details.id, path: f.path, oldPath: f.oldPath })}
        onMenu={(f, x, y) =>
          showMenu(x, y, [
            { label: "Show diff", onSelect: () => openDiff({ kind: "commit", id: details.id, path: f.path, oldPath: f.oldPath }) },
            { label: "File history", onSelect: () => openDiff({ kind: "history", path: f.path }) },
            {
              label: "Blame at this commit",
              disabled: f.status === "deleted",
              onSelect: () => openDiff({ kind: "blame", path: f.path, rev: details.id }),
            },
            { separator: true, label: "" },
            ...fileItems(f.path, f.status === "deleted"),
          ])
        }
      />
    </div>
  );
}

/** Branches and tags pointing at this commit. */
function CommitRefs({ id }: { id: string }) {
  // Select the stable array, filter outside: a selector returning a new
  // array on every call would re-render forever.
  const all = useStore((s) => s.graph?.refs);
  const refs = useMemo(() => all?.filter((r) => r.target === id) ?? [], [all, id]);
  const showMenu = useStore((s) => s.showMenu);
  if (refs.length === 0) return null;
  return (
    <div className="commit-refs">
      {refs.map((r) => (
        <span
          key={r.fullName}
          className={`ref-chip ${r.kind}${r.isHead ? " head" : ""}`}
          onDoubleClick={() => checkoutRef(r)}
          onContextMenu={(e) => {
            e.preventDefault();
            showMenu(e.clientX, e.clientY, refMenu(r));
          }}
          title={r.message ?? (r.upstream ? `tracks ${r.upstream}` : undefined)}
        >
          {r.kind === "tag" ? <IconTag size={11} /> : r.kind === "remote" ? <IconCloud size={11} /> : <IconBranch size={11} />}
          {r.name}
        </span>
      ))}
    </div>
  );
}

/** People from "Co-authored-by: Name <email>" trailers. */
export function coAuthorsOf(message: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const m of message.matchAll(/^\s*co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)) {
    out.push({ name: m[1], email: m[2] });
  }
  return out;
}

export function FileViewToggle() {
  const view = useSettings((s) => s.fileView);
  return (
    <button
      className="icon-btn"
      title={view === "list" ? "Show as tree" : "Show as paths"}
      onClick={() => updateSettings({ fileView: view === "list" ? "tree" : "list" })}
    >
      {view === "list" ? <IconFolder size={12} /> : <IconFile size={12} />}
    </button>
  );
}
