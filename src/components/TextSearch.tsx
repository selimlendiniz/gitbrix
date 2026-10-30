// Ctrl+Shift+F: text (or a regex) in the work tree's files; a hit opens
// in the editor at its line.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { api, errorText, TextHit } from "../api";
import { openInEditor } from "../editor";
import { useStore } from "../store";

export const useTextSearch = create<{ open: boolean }>(() => ({ open: false }));

function Highlighted({ hit }: { hit: TextHit }) {
  const chars = [...hit.text];
  return (
    <>
      {chars.slice(0, hit.start).join("")}
      <mark>{chars.slice(hit.start, hit.end).join("")}</mark>
      {chars.slice(hit.end).join("")}
    </>
  );
}

export function TextSearch() {
  const open = useTextSearch((s) => s.open);
  const repo = useStore((s) => s.repo?.path);
  const openDiff = useStore((s) => s.openDiff);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCase] = useState(false);
  const [found, setFound] = useState<{ hits: TextHit[]; files: number; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.select(), 0);
  }, [open]);

  // Searched shortly after typing stops; a later search wins.
  useEffect(() => {
    if (!open || !repo || !query) {
      setFound(null);
      setError(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      setBusy(true);
      api.searchText(repo, query, regex, caseSensitive).then(
        (f) => {
          if (!live) return;
          setFound(f);
          setError(null);
          setBusy(false);
        },
        (e) => {
          if (!live) return;
          setError(errorText(e));
          setBusy(false);
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, repo, query, regex, caseSensitive]);

  const byFile = useMemo(() => {
    const m = new Map<string, TextHit[]>();
    for (const h of found?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m.entries()];
  }, [found]);

  if (!open) return null;
  const close = () => useTextSearch.setState({ open: false });
  const toggle = (on: boolean, set: (v: boolean) => void, label: string, title: string) => (
    <button type="button" className={`search-toggle${on ? " on" : ""}`} aria-pressed={on} aria-label={title} title={title} onClick={() => set(!on)}>
      {label}
    </button>
  );

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal text-search" role="dialog" aria-label="Search in files" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="text-search-bar">
          <input ref={inputRef} placeholder="Search the work tree's files…" value={query} onChange={(e) => setQuery(e.target.value)} />
          {toggle(caseSensitive, setCase, "Aa", "Match case")}
          {toggle(regex, setRegex, ".*", "Regular expression")}
        </div>
        <div className="text-search-status dim">
          {error ??
            (busy
              ? "Searching…"
              : found
                ? `${found.hits.length}${found.truncated ? "+" : ""} match${found.hits.length === 1 ? "" : "es"} in ${byFile.length} file${byFile.length === 1 ? "" : "s"} (${found.files} searched)`
                : "Tracked files and untracked ones git doesn't ignore, as they are now. Click a line to edit it.")}
        </div>
        <div className="text-search-results">
          {byFile.map(([path, hits]) => (
            <div key={path} className="text-search-file">
              <div className="text-search-path">
                <span>{path}</span>
                <span className="side-count">{hits.length}</span>
                <span className="spacer" />
                <button type="button" className="link-btn" onClick={() => { close(); void openDiff({ kind: "history", path }); }}>
                  History
                </button>
                <button type="button" className="link-btn" onClick={() => { close(); void openDiff({ kind: "blame", path, rev: null }); }}>
                  Blame
                </button>
              </div>
              {hits.map((h) => (
                <button key={`${h.line}`} type="button" className="text-search-hit" title={`Open ${path}:${h.line} in the editor`} onClick={() => void openInEditor(path, h.line)}>
                  <span className="ln">{h.line}</span>
                  <span className="text-search-line">
                    <Highlighted hit={h} />
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
