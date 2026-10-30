// A small CI status mark: ✓ passed, ✕ failed, spinning while running.

import { openUrl } from "@tauri-apps/plugin-opener";

import { CiState } from "../api";

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

export function CiMark({ state, url }: { state: CiState; url?: string }) {
  return (
    <span
      className={`ci-mark ci-${state}${url ? " link" : ""}`}
      title={`CI ${LABEL[state]}${url ? " — click to open" : ""}`}
      aria-label={`CI ${LABEL[state]}`}
      onMouseDown={(e) => url && e.stopPropagation()}
      onClick={(e) => {
        if (!url) return;
        e.stopPropagation();
        void openUrl(url);
      }}
    >
      {GLYPH[state]}
    </span>
  );
}
