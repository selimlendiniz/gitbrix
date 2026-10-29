import { ReactNode } from "react";

import { FileStatus } from "../api";
import { splitPath, statusLetter } from "../format";

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
  if (files.length === 0) return <div className="files-empty">{empty ?? "No files"}</div>;
  return (
    <div className="files">
      {files.map((f) => {
        const { dir, base } = splitPath(f.path);
        return (
          <div
            key={`${f.oldPath ?? ""}→${f.path}`}
            className={`file-row${activePath === f.path ? " active" : ""}`}
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
              {dir && <span className="file-dir">{dir}</span>}
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
      })}
    </div>
  );
}
