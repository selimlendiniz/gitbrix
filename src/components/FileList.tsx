import { ReactNode, useState } from "react";

import { FileStatus } from "../api";
import { splitPath, statusLetter } from "../format";
import { useSettings } from "../settings";
import { IconChevron, IconFolder } from "./Icons";

export interface FileRow {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export function FileList({
  files,
  activePath,
  onOpen,
  onActivate,
  actions,
  onMenu,
  empty,
}: {
  files: FileRow[];
  activePath?: string | null;
  onOpen: (f: FileRow) => void;
  onActivate?: (f: FileRow) => void;
  actions?: (f: FileRow) => ReactNode;
  onMenu?: (f: FileRow, x: number, y: number) => void;
  empty?: string;
}) {
  const view = useSettings((st) => st.fileView);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (files.length === 0) return <div className="files-empty">{empty ?? "No files"}</div>;

  const row = (f: FileRow, depth: number | null) => (
    <FileRowView
      key={`${f.oldPath ?? ""}→${f.path}`}
      f={f}
      depth={depth}
      active={activePath === f.path}
      onOpen={onOpen}
      onActivate={onActivate}
      onMenu={onMenu}
      actions={actions}
    />
  );

  if (view === "list") return <div className="files">{files.map((f) => row(f, null))}</div>;

  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const render = (node: DirNode, depth: number): ReactNode[] => {
    const out: ReactNode[] = [];
    for (const d of node.dirs) {
      const open = !closed.has(d.path);
      out.push(
        <div key={`dir:${d.path}`} className="file-row dir-row" style={{ paddingLeft: 14 + depth * 14 }} onClick={() => toggle(d.path)}>
          <IconChevron size={10} open={open} />
          <IconFolder size={13} />
          <span className="file-path">
            <span className="file-base">{d.name}</span>
          </span>
          <span className="file-stat">{d.count}</span>
        </div>,
      );
      if (open) out.push(...render(d, depth + 1));
    }
    for (const f of node.files) out.push(row(f, depth));
    return out;
  };
  return <div className="files">{render(fileTree(files), 0)}</div>;
}

interface DirNode {
  name: string;
  path: string;
  dirs: DirNode[];
  files: FileRow[];
  count: number;
}

/** Files grouped by directory; a directory with a single subdirectory
 *  and no files of its own is merged into it ("src/components"). */
export function fileTree(files: FileRow[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: [], files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.dirs.find((d) => d.name === part && d.path === path);
      if (!next) {
        next = { name: part, path, dirs: [], files: [], count: 0 };
        node.dirs.push(next);
      }
      next.count++;
      node = next;
    }
    node.files.push(f);
  }
  const squash = (n: DirNode): DirNode => {
    n.dirs = n.dirs.map(squash);
    if (n.path && n.files.length === 0 && n.dirs.length === 1) {
      const only = n.dirs[0];
      return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return squash(root);
}

function FileRowView({
  f,
  depth,
  active,
  onOpen,
  onActivate,
  onMenu,
  actions,
}: {
  f: FileRow;
  /** Tree depth; null in list view (shows the directory instead). */
  depth: number | null;
  active: boolean;
  onOpen: (f: FileRow) => void;
  onActivate?: (f: FileRow) => void;
  onMenu?: (f: FileRow, x: number, y: number) => void;
  actions?: (f: FileRow) => ReactNode;
}) {
  const { dir, base } = splitPath(f.path);
  return (
    <div
      className={`file-row${active ? " active" : ""}`}
      style={depth !== null ? { paddingLeft: 14 + depth * 14 + 14 } : undefined}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
      onClick={() => onOpen(f)}
      onDoubleClick={onActivate ? () => onActivate(f) : undefined}
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              onMenu(f, e.clientX, e.clientY);
            }
          : undefined
      }
    >
      <span className={`status-badge s-${f.status}`}>{statusLetter(f.status)}</span>
      <span className="file-path">
        <span className="file-base">{base}</span>
        {dir && depth === null && <span className="file-dir">{dir}</span>}
      </span>
      {f.binary ? (
        <span className="file-stat">bin</span>
      ) : (
        (f.additions !== undefined || f.deletions !== undefined) && (
          <span className="file-stat">
            {!!f.additions && <span className="add">+{f.additions}</span>}
            {!!f.deletions && <span className="del">−{f.deletions}</span>}
          </span>
        )
      )}
      {actions && (
        <span className="file-actions" onClick={(e) => e.stopPropagation()}>
          {actions(f)}
        </span>
      )}
    </div>
  );
}
