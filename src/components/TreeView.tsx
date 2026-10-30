// The files of any commit: a folder tree on the left (folders load as
// they open), the chosen file on the right, highlighted, with links to its
// history and its blame at that commit.

import { useEffect, useState } from "react";

import { api, errorText, FileAt, TreeEntry } from "../api";
import { highlightLines, languageFor, Token } from "../diff/highlight";
import { shortId } from "../format";
import { useStore } from "../store";
import { ext, IMAGE_TYPES } from "./DiffView";
import { IconChevron, IconClose, IconFile, IconFolder } from "./Icons";

function Folder({ rev, dir, depth, chosen, onPick }: { rev: string; dir: string; depth: number; chosen: string | null; onPick: (p: string) => void }) {
  const repo = useStore((s) => s.repo?.path);
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!repo) return;
    let live = true;
    api.treeAt(repo, rev, dir).then(
      (e) => live && setEntries(e),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [repo, rev, dir]);
  if (error) return <div className="tree-note">{error}</div>;
  if (!entries) return <div className="tree-note">Loading…</div>;
  const pad = 10 + depth * 14;
  return (
    <>
      {entries.map((e) =>
        e.kind === "dir" ? (
          <div key={e.path}>
            <div
              className="tree-item"
              style={{ paddingLeft: pad }}
              onClick={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(e.path)) n.delete(e.path);
                  else n.add(e.path);
                  return n;
                })
              }
            >
              <IconChevron size={10} open={open.has(e.path)} />
              <IconFolder size={13} />
              <span>{e.name}</span>
            </div>
            {open.has(e.path) && <Folder rev={rev} dir={e.path} depth={depth + 1} chosen={chosen} onPick={onPick} />}
          </div>
        ) : (
          <div
            key={e.path}
            className={`tree-item${chosen === e.path ? " selected" : ""}${e.kind !== "file" ? " dim" : ""}`}
            style={{ paddingLeft: pad + 14 }}
            title={e.kind === "submodule" ? "Submodule" : e.kind === "link" ? "Symbolic link" : e.path}
            onClick={() => e.kind === "file" && onPick(e.path)}
          >
            <IconFile size={13} />
            <span>{e.name}</span>
          </div>
        ),
      )}
    </>
  );
}

function Content({ rev, path }: { rev: string; path: string }) {
  const repo = useStore((s) => s.repo?.path);
  const [file, setFile] = useState<FileAt | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mime = IMAGE_TYPES[ext(path)];
  useEffect(() => {
    if (!repo) return;
    let live = true;
    setFile(null);
    setTokens(null);
    setImage(null);
    setError(null);
    if (mime) {
      api.fileBase64(repo, rev, path).then((b) => live && setImage(b), (e) => live && setError(errorText(e)));
      return;
    }
    api.fileAt(repo, rev, path).then(
      (f) => {
        if (!live) return;
        setFile(f);
        const lang = languageFor(path);
        if (f.text != null && lang) {
          const lines = f.text.replace(/\n$/, "").split("\n");
          highlightLines(lines, lang).then((t) => live && setTokens(t), () => {});
        }
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [repo, rev, path, mime]);

  if (error) return <div className="diff-message">{error}</div>;
  if (mime) return image ? <div className="tree-image"><img alt={path} src={`data:${mime};base64,${image}`} /></div> : <div className="diff-message">Loading…</div>;
  if (!file) return <div className="diff-message">Loading…</div>;
  if (file.text == null) return <div className="diff-message">{file.binary ? "Binary file" : "Too large to show"} — {file.size.toLocaleString()} bytes.</div>;
  const lines = file.text.replace(/\n$/, "").split("\n");
  return (
    <div className="diff-table tree-code">
      {lines.map((l, i) => (
        <div key={i} className="dl ctx">
          <span className="ln">{i + 1}</span>
          <span className="code">
            {tokens?.[i]
              ? tokens[i].map((t, k) => (
                  <span key={k} className={t.cls ? t.cls.split(" ").map((c) => `hl-${c}`).join(" ") : undefined}>
                    {t.text}
                  </span>
                ))
              : l || " "}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TreeView() {
  const source = useStore((s) => s.diffSource);
  const commits = useStore((s) => s.graph?.commits);
  const openDiff = useStore((s) => s.openDiff);
  const close = useStore((s) => s.closeDiff);
  if (source?.kind !== "tree") return null;
  const { rev, path } = source;
  const summary = commits?.find((c) => c.id === rev)?.summary ?? "";
  const pick = (p: string) => void openDiff({ kind: "tree", rev, path: p });

  return (
    <div className="diff-view tree-view" data-testid="tree">
      <div className="diff-header">
        <span className="view-kind">Files</span>
        <span className="diff-path">
          {path ?? "at"} <span className="sha-inline">{shortId(rev)}</span>
        </span>
        <span className="dim diff-where">{summary}</span>
        <span className="diff-header-actions">
          {path && (
            <>
              <button className="link-btn" onClick={() => openDiff({ kind: "history", path })}>
                History
              </button>
              <button className="link-btn" onClick={() => openDiff({ kind: "blame", path, rev })}>
                Blame
              </button>
              <button className="link-btn" onClick={() => void navigator.clipboard?.writeText(path)}>
                Copy path
              </button>
            </>
          )}
          <button className="icon-btn" title="Close (Esc)" onClick={close}>
            <IconClose size={14} />
          </button>
        </span>
      </div>
      <div className="tree-body">
        <div className="tree-side">
          <Folder rev={rev} dir="" depth={0} chosen={path} onPick={pick} />
        </div>
        <div className="tree-file">{path ? <Content rev={rev} path={path} /> : <div className="diff-message">Pick a file.</div>}</div>
      </div>
    </div>
  );
}
