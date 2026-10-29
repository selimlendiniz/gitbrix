import { api, SequencerOp, WIP_ID } from "../api";
import { useStore } from "../store";
import { trackHead } from "../undo";

// Shown above the center view while a merge, rebase, cherry-pick or
// revert is in progress, whatever is selected.
export function OperationBanner() {
  const repo = useStore((s) => s.repo);
  const status = useStore((s) => s.status);
  const select = useStore((s) => s.select);
  const run = useStore((s) => s.run);
  if (!repo || repo.state === "clean") return null;
  const op = repo.state;
  const conflicts = status?.conflicted.length ?? 0;
  const seqOp = (op === "am" || op === "bisect" ? null : op) as SequencerOp | null;
  return (
    <div className={`op-banner${conflicts ? " conflict" : ""}`}>
      <div>
        <strong>{op}</strong> in progress
        {conflicts > 0 ? (
          <>
            {` — ${conflicts} conflicted file${conflicts === 1 ? "" : "s"}. `}
            <button className="link-btn" onClick={() => select(WIP_ID, true)}>
              Show conflicts
            </button>
          </>
        ) : (
          " — ready to continue."
        )}
      </div>
      {seqOp && (
        <div className="op-actions">
          <button className="small-btn" onClick={() => run(`Aborting ${op}`, (r) => api.sequencer(r, seqOp, "abort"))}>
            Abort
          </button>
          {seqOp === "rebase" && (
            <button className="small-btn" onClick={() => run("Skipping commit", (r) => api.sequencer(r, seqOp, "skip"))}>
              Skip
            </button>
          )}
          <button
            className="small-btn primary"
            disabled={conflicts > 0}
            onClick={() => trackHead(`${op}`, () => run(`Continuing ${op}`, (r) => api.sequencer(r, seqOp, "continue")))}
          >
            Continue
          </button>
        </div>
      )}
    </div>
  );
}
