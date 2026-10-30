// Ctrl+P: find a file of the open repository by name, then view it, its
// history or its blame.

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { api, errorText } from "../api";
import { useStore } from "../store";
import { fuzzyScore } from "./CommandPalette";

export const useFileFinder = create<{ open: boolean }>(() => ({ open: false }));

/** The files at HEAD, per repository and commit, read once. */
let cache: { key: string; files: string[] } | null = null;

const SHOWN = 80;

/** Best matches first: the name counts more than the folders. */
export function findFiles(files: string[], query: string): string[] {
  const q = query.trim();
  if (!q) return files.slice(0, SHOWN);
  const scored: [string, number][] = [];
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    const inName = fuzzyScore(q, name);
    const inPath = inName === null ? fuzzyScore(q, f) : null;
    if (inName !== null) scored.push([f, inName + 10]);
    else if (inPath !== null) scored.push([f, inPath]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return scored.slice(0, SHOWN).map(([f]) => f);
}

export function FileFinder() {
  const open = useFileFinder((s) => s.open);
  const repo = useStore((s) => s.repo);
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !repo) return;
    setQuery("");
    setActive(0);
    setError(null);
    const key = `${repo.path}@${repo.headOid}`;
    if (cache?.key === key) {
      setFiles(cache.files);
      return;
    }
    setFiles(null);
    let live = true;
    api.listFiles(repo.path, "HEAD").then(
      (list) => {
        cache = { key, files: list };
        if (live) setFiles(list);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [open, repo]);

  const results = useMemo(() => (files ? findFiles(files, query) : []), [files, query]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open || !repo) return null;
  const close = () => useFileFinder.setState({ open: false });
  const go = (path: string | undefined, how: "view" | "history" | "blame") => {
    if (!path) return;
    close();
    const openDiff = useStore.getState().openDiff;
    if (how === "history") void openDiff({ kind: "history", path });
    else if (how === "blame") void openDiff({ kind: "blame", path, rev: null });
    else void openDiff({ kind: "tree", rev: useStore.getState().repo?.headOid ?? "HEAD", path });
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Find a file" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Find a file by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(results[active], e.ctrlKey || e.metaKey ? "history" : e.shiftKey ? "blame" : "view");
            }
          }}
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {error && <div className="palette-empty">{error}</div>}
          {!files && !error && <div className="palette-empty">Reading the files…</div>}
          {files && results.length === 0 && <div className="palette-empty">No file matches</div>}
          {results.map((f, i) => {
            const cut = f.lastIndexOf("/");
            return (
              <div
                key={f}
                role="option"
                aria-selected={i === active}
                className={`palette-item${i === active ? " active" : ""}`}
                onMouseMove={() => setActive(i)}
                onClick={() => go(f, "view")}
              >
                <span className="palette-label">{f.slice(cut + 1)}</span>
                {cut > 0 && <span className="palette-hint finder-dir">{f.slice(0, cut)}</span>}
              </div>
            );
          })}
        </div>
        <div className="finder-keys dim">Enter: view · Ctrl+Enter: history · Shift+Enter: blame</div>
      </div>
    </div>
  );
}
