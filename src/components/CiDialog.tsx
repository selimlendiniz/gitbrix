// A commit's CI: the pipeline's jobs by stage, a job's log (coloured as in
// the runner), running a job again. Refreshes itself while jobs run.

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { api, CiJob, CiPipeline, CiState, errorText } from "../api";
import { parseLog } from "../ansi";
import { useStore } from "../store";
import { CiMark } from "./CiMark";

export const useCiView = create<{ sha: string | null }>(() => ({ sha: null }));

export function openCi(sha: string) {
  useCiView.setState({ sha });
}

const KNOWN: CiState[] = ["success", "failed", "running", "pending", "canceled", "skipped", "manual"];
const asState = (s: string): CiState => (KNOWN.includes(s as CiState) ? (s as CiState) : "pending");
const busy = (s: string) => s === "running" || s === "pending";

function duration(s: number | null): string {
  if (s == null) return "";
  const m = Math.floor(s / 60);
  return m ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
}

function Log({ text }: { text: string }) {
  const lines = useMemo(() => parseLog(text), [text]);
  const ref = useRef<HTMLPreElement>(null);
  // Failures are at the end.
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre className="ci-log" ref={ref} data-testid="ci-log">
      {lines.map((l, i) => (
        <div key={i} className={`ci-log-line ${l.kind}`}>
          {l.spans.map((s, k) => (
            <span key={k} className={s.cls ? s.cls.split(" ").map((c) => `ansi-${c}`).join(" ") : undefined}>
              {s.text}
            </span>
          ))}
          {!l.spans.length && "\n"}
        </div>
      ))}
    </pre>
  );
}

export function CiDialog() {
  const sha = useCiView((s) => s.sha);
  const repo = useStore((s) => s.repo?.path);
  const [pipeline, setPipeline] = useState<CiPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CiJob | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const close = () => useCiView.setState({ sha: null });

  // The jobs, again every few seconds while some run.
  useEffect(() => {
    if (!sha || !repo) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setPipeline(null);
    setError(null);
    setJob(null);
    const load = async () => {
      try {
        const p = await api.ciJobs(repo, sha);
        if (!live) return;
        setPipeline(p);
        setJob((j) => p.jobs.find((x) => x.id === j?.id) ?? j ?? p.jobs.find((x) => x.state === "failed" && x.hasLog) ?? null);
        if (p.jobs.some((j) => busy(j.state))) timer = setTimeout(load, 5000);
      } catch (e) {
        if (live) setError(errorText(e));
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sha, repo]);

  // The chosen job's log, again while it runs.
  const jobId = job?.id;
  const jobBusy = job ? busy(job.state) : false;
  const hasLog = job?.hasLog ?? false;
  useEffect(() => {
    if (!jobId || !repo || !hasLog) {
      setLog(null);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    setLogError(null);
    const load = async () => {
      try {
        const text = await api.ciLog(repo, jobId);
        if (live) setLog(text);
      } catch (e) {
        if (live) setLogError(errorText(e));
      }
      if (live && jobBusy) timer = setTimeout(load, 5000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, repo, jobBusy, hasLog]);

  if (!sha) return null;
  const stages = [...new Set(pipeline?.jobs.map((j) => j.stage) ?? [])];
  const retry = async (j: CiJob) => {
    if (!repo) return;
    try {
      await api.ciRetry(repo, j.id);
      useStore.getState().toast("info", `${j.name} runs again`);
      // Show the new run: read the jobs again.
      useCiView.setState({ sha: null });
      setTimeout(() => useCiView.setState({ sha }), 0);
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal ci-modal"
        role="dialog"
        aria-label="CI"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <div className="modal-title ci-title">
          {pipeline?.state && <CiMark state={pipeline.state} />}
          CI for <code>{sha.slice(0, 8)}</code>
          <span className="spacer" />
          {pipeline?.url && (
            <button type="button" className="small-btn" onClick={() => void openUrl(pipeline.url)}>
              Open in browser
            </button>
          )}
          <button type="button" className="small-btn" onClick={close} autoFocus>
            Close
          </button>
        </div>
        {error && <pre className="modal-error">{error}</pre>}
        {!pipeline && !error && <div className="files-empty">Loading…</div>}
        {pipeline && !pipeline.jobs.length && <div className="files-empty">No CI ran for this commit.</div>}
        {pipeline && pipeline.jobs.length > 0 && (
          <div className="ci-body">
            <div className="ci-jobs" role="list">
              {stages.map((stage) => (
                <div key={stage} className="ci-stage">
                  {stage && <div className="ci-stage-name">{stage}</div>}
                  {pipeline.jobs
                    .filter((j) => j.stage === stage)
                    .map((j) => (
                      <div
                        key={j.id}
                        role="listitem"
                        className={`ci-job${job?.id === j.id ? " selected" : ""}`}
                        onClick={() => setJob(j)}
                        title={j.hasLog ? "Show its log" : "Its details are on its page"}
                      >
                        <CiMark state={asState(j.state)} />
                        <span className="ci-job-name">{j.name}</span>
                        <span className="dim">{duration(j.duration)}</span>
                        {j.hasLog && !busy(j.state) && (
                          <button
                            type="button"
                            className="link-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              void retry(j);
                            }}
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              ))}
            </div>
            <div className="ci-log-pane">
              {!job && <div className="files-empty">Pick a job to see its log</div>}
              {job && !job.hasLog && (
                <div className="files-empty">
                  {job.name}'s details are on its page.{" "}
                  <button type="button" className="link-btn" onClick={() => void openUrl(job.url)}>
                    Open it
                  </button>
                </div>
              )}
              {job && job.hasLog && logError && <pre className="modal-error">{logError}</pre>}
              {job && job.hasLog && !logError && (log === null ? <div className="files-empty">Loading the log…</div> : <Log text={log} />)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
