// Above the center view while bisecting: how far along, the verdict
// buttons for the commit being tested, and the result once found.

import { bisectMark, bisectRun, bisectStop, useBisect } from "../bisect";
import { shortId } from "../format";
import { useStore } from "../store";

export function BisectBanner() {
  const status = useBisect((s) => s.status);
  const pending = useBisect((s) => s.pending);
  const commits = useStore((s) => s.graph?.commits);
  const select = useStore((s) => s.select);
  const busy = useStore((s) => !!s.busy);
  const summary = (id: string | null) => commits?.find((c) => c.id === id)?.summary ?? "";

  if (!status) {
    if (!pending) return null;
    return (
      <div className="op-banner bisect">
        <div>
          <strong>Bisect:</strong> {shortId(pending.id)} marked {pending.verdict}. Right-click a{" "}
          {pending.verdict === "bad" ? "good (older)" : "bad (newer)"} commit and mark it to start.
        </div>
        <div className="op-actions">
          <button className="small-btn" onClick={() => useBisect.setState({ pending: null })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (status.found) {
    return (
      <div className="op-banner bisect found">
        <div>
          <strong>First bad commit:</strong>{" "}
          <button className="link-btn" onClick={() => select(status.found, true)}>
            {shortId(status.found)} {summary(status.found)}
          </button>
        </div>
        <div className="op-actions">
          <button className="small-btn primary" disabled={busy} onClick={() => void bisectStop()}>
            Stop bisecting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="op-banner bisect">
      <div>
        <strong>Bisecting</strong> — testing{" "}
        <button className="link-btn" onClick={() => status.current && select(status.current, true)}>
          {status.current ? shortId(status.current) : "?"} {summary(status.current)}
        </button>
        <span className="dim">
          {" "}
          · {status.remaining} commits left, about {status.steps} step{status.steps === 1 ? "" : "s"}
        </span>
      </div>
      <div className="op-actions">
        <button className="small-btn good" disabled={busy} title="The problem isn't here" onClick={() => void bisectMark("good", null)}>
          Good
        </button>
        <button className="small-btn danger" disabled={busy} title="The problem is here" onClick={() => void bisectMark("bad", null)}>
          Bad
        </button>
        <button className="small-btn" disabled={busy} title="Can't tell (doesn't build…)" onClick={() => void bisectMark("skip", null)}>
          Skip
        </button>
        <button className="small-btn" disabled={busy} onClick={() => void bisectRun()}>
          Run a command…
        </button>
        <button className="small-btn" disabled={busy} onClick={() => void bisectStop()}>
          Stop
        </button>
      </div>
    </div>
  );
}
