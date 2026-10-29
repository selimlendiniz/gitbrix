import { stashApply, stashDrop, stashPop } from "../actions";
import { laneColor } from "../colors";
import { fullTime, initials, shortId } from "../format";
import { useStore } from "../store";
import { FileList } from "./FileList";

export function CommitPanel() {
  const details = useStore((s) => s.details);
  const graph = useStore((s) => s.graph);
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

  const row = graph?.commits.find((c) => c.id === details.id);
  const stash = stashes.find((st) => st.id === details.id);
  const [summary, ...bodyLines] = details.message.split("\n");
  const body = bodyLines.join("\n").trim();
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
        <div className="avatar" style={{ background: laneColor(row?.color ?? 0) }}>
          {initials(details.author.name)}
        </div>
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
        </div>
      </div>

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
        <span className="file-stat">
          <span className="add">+{adds}</span> <span className="del">−{dels}</span>
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
            { label: "Copy path", onSelect: () => navigator.clipboard?.writeText(f.path).then(() => toast("info", "Copied path")) },
          ])
        }
      />
    </div>
  );
}
