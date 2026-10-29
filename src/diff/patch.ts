// Build a patch for part of a diff, for `git apply` (see apply_patch in
// src-tauri/src/git/ops.rs). This is how hunks and single lines get staged,
// unstaged or discarded.
//
// Forward (staging): the patch is applied as-is to the index, whose
// content matches the diff's old side. Unselected additions are left out;
// unselected deletions stay as context because those lines remain.
//
// Reverse (unstaging from the staged diff, discarding from the unstaged
// diff): the patch is applied with --reverse to the side that matches the
// diff's new side. Unselected additions stay as context because they must
// survive; unselected deletions are left out because they aren't there.

import { FileDiff, Hunk } from "../api";

const NO_EOL = "\\ No newline at end of file";

/** `selected`: indices into `hunk.lines`; `null` means the whole hunk. */
export function buildPatch(diff: FileDiff, hunk: Hunk, selected: Set<number> | null, reverse: boolean): string | null {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  let changes = 0;

  hunk.lines.forEach((l, i) => {
    const picked = selected === null || selected.has(i);
    let prefix: string | null;
    if (l.kind === "ctx") prefix = " ";
    else if (picked) prefix = l.kind === "add" ? "+" : "-";
    else if (l.kind === "add") prefix = reverse ? " " : null;
    else prefix = reverse ? null : " ";

    if (prefix === null) return;
    if (prefix !== " ") changes++;
    if (prefix !== "+") oldCount++;
    if (prefix !== "-") newCount++;
    body.push(prefix + l.text);
    if (l.noEol) body.push(NO_EOL);
  });

  if (changes === 0) return null;

  const oldPath = diff.oldPath ?? diff.path;
  const header = [
    `diff --git a/${oldPath} b/${diff.path}`,
    `--- a/${oldPath}`,
    `+++ b/${diff.path}`,
    `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`,
  ];
  return [...header, ...body].join("\n") + "\n";
}

/** Indices of the add/del lines between two clicked lines, inclusive. */
export function lineRange(hunk: Hunk, a: number, b: number): number[] {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) if (hunk.lines[i]?.kind !== "ctx") out.push(i);
  return out;
}
