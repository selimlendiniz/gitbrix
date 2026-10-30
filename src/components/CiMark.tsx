// A small CI status mark: ✓ passed, ✕ failed, spinning while running.

import { openUrl } from "@tauri-apps/plugin-opener";

import { CiState } from "../api";
import { openCi } from "./CiDialog";

const LABEL: Record<CiState, string> = {
  success: "passed",
  failed: "failed",
  running: "running",
  pending: "pending",
  canceled: "canceled",
  skipped: "skipped",
  manual: "waiting for a manual step",
};

const GLYPH: Record<CiState, string> = {
  success: "✓",
  failed: "✕",
  running: "●",
  pending: "○",
  canceled: "⊘",
  skipped: "»",
  manual: "▸",
};

/** `sha`: the commit, whose jobs and logs a click shows in the app;
 * otherwise `url` opens in the browser. */
export function CiMark({ state, url, sha }: { state: CiState; url?: string; sha?: string }) {
  const clickable = !!(sha || url);
  return (
    <span
      className={`ci-mark ci-${state}${clickable ? " link" : ""}`}
      title={`CI ${LABEL[state]}${sha ? " — click for jobs and logs" : url ? " — click to open" : ""}`}
      aria-label={`CI ${LABEL[state]}`}
      onMouseDown={(e) => clickable && e.stopPropagation()}
      onClick={(e) => {
        if (!clickable) return;
        e.stopPropagation();
        if (sha) openCi(sha);
        else void openUrl(url!);
      }}
    >
      {GLYPH[state]}
    </span>
  );
}
