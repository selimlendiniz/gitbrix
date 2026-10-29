import { describe, expect, it } from "vitest";

import { parseConflicts, resolve } from "../../src/diff/conflicts";

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
