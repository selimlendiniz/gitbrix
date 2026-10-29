// Branch names with slashes shown as folders: feature/a, feature/b →
// feature ▸ a, b. Single-level names stay at the top.

import { ReactNode, useState } from "react";

import { RefInfo } from "../api";
import { IconChevron, IconFolder } from "./Icons";

export interface TreeNode {
  name: string;
  path: string;
  folders: TreeNode[];
  leaves: { ref: RefInfo; label: string }[];
}

/** Group refs by the slash-separated folders of `nameOf(ref)`. */
export function buildTree(refs: RefInfo[], nameOf: (r: RefInfo) => string): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: [], leaves: [] };
  for (const ref of refs) {
    const parts = nameOf(ref).split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      const path = node.path ? `${node.path}/${part}` : part;
      let next = node.folders.find((f) => f.name === part);
      if (!next) {
        next = { name: part, path, folders: [], leaves: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.leaves.push({ ref, label: parts[parts.length - 1] });
  }
  return root;
}

export function countLeaves(node: TreeNode): number {
  return node.leaves.length + node.folders.reduce((n, f) => n + countLeaves(f), 0);
}

export function RefTree({
  tree,
  indent,
  forceOpen,
  renderLeaf,
}: {
  tree: TreeNode;
  indent: number;
  /** Expand everything (while filtering). */
  forceOpen: boolean;
  renderLeaf: (ref: RefInfo, label: string, indent: number) => ReactNode;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  function render(node: TreeNode, depth: number): ReactNode[] {
    const out: ReactNode[] = [];
    for (const f of node.folders) {
      const open = forceOpen || !closed.has(f.path);
      out.push(
        <div
          key={`folder:${f.path}`}
          className="side-item folder"
          style={{ paddingLeft: 12 + depth * 12 }}
          onClick={() => toggle(f.path)}
        >
          <IconChevron size={10} open={open} />
          <IconFolder size={12} />
          <span className="side-item-label">{f.name}</span>
          <span className="side-count">{countLeaves(f)}</span>
        </div>,
      );
      if (open) out.push(...render(f, depth + 1));
    }
    for (const l of node.leaves) out.push(renderLeaf(l.ref, l.label, depth));
    return out;
  }

  return <>{render(tree, indent)}</>;
}
