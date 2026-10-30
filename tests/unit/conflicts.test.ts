import { describe, expect, it } from "vitest";

import { baseOf, conflictRange, conflictsOf, parseConflicts, replaceConflict, resolve } from "../../src/diff/conflicts";

const file = [
  "top",
  "<<<<<<< HEAD",
  "ours 1",
  "ours 2",
  "=======",
  "theirs",
  ">>>>>>> feature",
  "middle",
  "<<<<<<< HEAD",
  "a",
  "||||||| base",
  "b",
  "=======",
  "c",
  ">>>>>>> feature",
  "end",
  "",
].join("\n");

describe("parseConflicts", () => {
  it("splits text and conflict blocks, with optional base", () => {
    const p = parseConflicts(file);
    expect(p.finalNewline).toBe(true);
    expect(p.segments.map((s) => s.kind)).toEqual(["text", "conflict", "text", "conflict", "text"]);
    const [, c1, , c2] = p.segments;
    expect(c1).toMatchObject({ ours: ["ours 1", "ours 2"], theirs: ["theirs"], base: null, oursLabel: "HEAD", theirsLabel: "feature" });
    expect(c2).toMatchObject({ ours: ["a"], base: ["b"], theirs: ["c"] });
  });

  it("leaves an unmatched marker as text", () => {
    const p = parseConflicts("x\n<<<<<<< not a conflict\ny\n");
    expect(p.segments).toEqual([{ kind: "text", lines: ["x", "<<<<<<< not a conflict", "y"] }]);
  });

  it("does not treat longer marker runs as markers", () => {
    const p = parseConflicts("<<<<<<<< eight\n");
    expect(p.segments[0].kind).toBe("text");
  });
});

describe("resolve", () => {
  const p = parseConflicts(file);

  it("needs a choice for every conflict", () => {
    expect(resolve(p, ["ours"])).toBeNull();
  });

  it("assembles the chosen sides and keeps the final newline", () => {
    expect(resolve(p, ["theirs", "ours-theirs"])).toBe("top\ntheirs\nmiddle\na\nc\nend\n");
    expect(resolve(p, ["ours", "theirs-ours"])).toBe("top\nours 1\nours 2\nmiddle\nc\na\nend\n");
  });

  it("keeps a missing final newline missing", () => {
    const q = parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b");
    expect(resolve(q, ["ours"])).toBe("x");
  });
});

describe("CRLF files", () => {
  it("recognises markers with \\r and keeps the line endings", () => {
    const text = "top\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> side\r\nend\r\n";
    const p = parseConflicts(text);
    expect(p.segments.map((s) => s.kind)).toEqual(["text", "conflict", "text"]);
    expect(p.segments[1]).toMatchObject({ oursLabel: "HEAD", theirsLabel: "side" });
    expect(resolve(p, ["theirs"])).toBe("top\r\ntheirs\r\nend\r\n");
  });
});

describe("editing conflicts in place", () => {
  it("replaces one block and keeps everything else, hand edits included", () => {
    const edited = file.replace("middle", "middle, edited by hand");
    const once = replaceConflict(edited, 1, ["c"]);
    expect(once).toBe(["top", "<<<<<<< HEAD", "ours 1", "ours 2", "=======", "theirs", ">>>>>>> feature", "middle, edited by hand", "c", "end", ""].join("\n"));
    // What was the first block is still the first.
    const twice = replaceConflict(once, 0, ["ours 1", "theirs"]);
    expect(twice).toBe("top\nours 1\ntheirs\nmiddle, edited by hand\nc\nend\n");
    expect(conflictsOf(twice)).toEqual([]);
    expect(replaceConflict(twice, 0, ["x"])).toBe(twice);
  });

  it("keeps CRLF lines and a missing final newline", () => {
    const crlf = "a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> b\r\nz";
    expect(replaceConflict(crlf, 0, ["y\r"])).toBe("a\r\ny\r\nz");
  });

  it("finds a block's characters", () => {
    const [from, to] = conflictRange(file, 0)!;
    expect(file.slice(from, to)).toBe("<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> feature");
    expect(conflictRange(file, 5)).toBeNull();
  });

  it("borrows a conflict's base from the diff3 merge", () => {
    const diff3 = conflictsOf("<<<<<<< ours\nours 1\nours 2\n||||||| base\nold\n=======\ntheirs\n>>>>>>> theirs\n");
    const [plain, withBase] = conflictsOf(file);
    expect(baseOf(plain, diff3)).toEqual(["old"]);
    expect(baseOf(withBase, diff3)).toEqual(["b"]);
    expect(baseOf({ ...plain, ours: ["other"] }, diff3)).toBeNull();
  });
});
