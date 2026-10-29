import { describe, expect, it } from "vitest";

import { DiffLine, FileDiff, Hunk } from "../../src/api";
import { buildPatch, lineRange } from "../../src/diff/patch";

const L = (kind: DiffLine["kind"], text: string, noEol = false): DiffLine => ({ kind, text, oldNo: null, newNo: null, noEol });

const hunk: Hunk = {
  header: "@@ -1,4 +1,4 @@",
  oldStart: 1,
  oldLines: 4,
  newStart: 1,
  newLines: 4,
  lines: [L("ctx", "a"), L("del", "b"), L("del", "c"), L("add", "B"), L("add", "C"), L("ctx", "d")],
};
const diff: FileDiff = { path: "f.txt", oldPath: null, status: "modified", binary: false, truncated: false, hunks: [hunk] };

const body = (p: string | null) => p!.split("\n").slice(3, -1);

describe("buildPatch", () => {
  it("emits the whole hunk", () => {
    const p = buildPatch(diff, hunk, null, false)!;
    expect(p.split("\n").slice(0, 3)).toEqual(["diff --git a/f.txt b/f.txt", "--- a/f.txt", "+++ b/f.txt"]);
    expect(body(p)).toEqual(["@@ -1,4 +1,4 @@", " a", "-b", "-c", "+B", "+C", " d"]);
  });

  it("forward: unselected deletions become context, unselected additions vanish", () => {
    expect(body(buildPatch(diff, hunk, new Set([1, 3]), false))).toEqual(["@@ -1,4 +1,4 @@", " a", "-b", " c", "+B", " d"]);
  });

  it("reverse: unselected additions become context, unselected deletions vanish", () => {
    expect(body(buildPatch(diff, hunk, new Set([1, 3]), true))).toEqual(["@@ -1,4 +1,4 @@", " a", "-b", "+B", " C", " d"]);
  });

  it("returns null when nothing changes", () => {
    expect(buildPatch(diff, hunk, new Set([0, 5]), false)).toBeNull();
  });

  it("keeps the no-newline marker after its line", () => {
    const h: Hunk = { ...hunk, lines: [L("del", "x", true), L("add", "y", true)] };
    expect(body(buildPatch(diff, h, null, false))).toEqual([
      "@@ -1,1 +1,1 @@",
      "-x",
      "\\ No newline at end of file",
      "+y",
      "\\ No newline at end of file",
    ]);
  });

  it("uses the old path of a rename", () => {
    const p = buildPatch({ ...diff, oldPath: "old.txt" }, hunk, null, false)!;
    expect(p.split("\n")[0]).toBe("diff --git a/old.txt b/f.txt");
  });
});

describe("lineRange", () => {
  it("collects only changed lines", () => {
    expect(lineRange(hunk, 5, 0)).toEqual([1, 2, 3, 4]);
  });
});
