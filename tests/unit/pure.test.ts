import { describe, expect, it } from "vitest";

import { DiffLine, RefInfo } from "../../src/api";
import { splitRows } from "../../src/diff/split";
import { initials, relativeTime, splitPath } from "../../src/format";
import { refsByCommit } from "../../src/graph/refs";

const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text, oldNo: null, newNo: null });

describe("splitRows", () => {
  it("pairs deletions with the additions that follow", () => {
    const rows = splitRows([line("ctx", "a"), line("del", "b"), line("del", "c"), line("add", "B"), line("ctx", "d")]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["a", "a"],
      ["b", "B"],
      ["c", null],
      ["d", "d"],
    ]);
  });

  it("puts lone additions on the right", () => {
    const rows = splitRows([line("add", "x")]);
    expect(rows).toEqual([{ left: null, right: line("add", "x") }]);
  });
});

const ref = (name: string, kind: RefInfo["kind"], target: string, isHead = false): RefInfo => ({
  fullName: `${kind}/${name}`,
  name,
  kind,
  target,
  isHead,
  upstream: null,
  ahead: 0,
  behind: 0,
});

describe("refsByCommit", () => {
  it("merges a local branch with same-named remote branches on the same commit", () => {
    const pills = refsByCommit([
      ref("v1", "tag", "c1"),
      ref("origin/main", "remote", "c1"),
      ref("main", "local", "c1", true),
      ref("origin/other", "remote", "c1"),
    ]).get("c1")!;
    expect(pills.map((p) => p.label)).toEqual(["main", "origin/other", "v1"]);
    expect(pills[0].remotes.map((r) => r.name)).toEqual(["origin/main"]);
    expect(pills[0].isHead).toBe(true);
  });

  it("keeps a remote branch separate when it points elsewhere", () => {
    const map = refsByCommit([ref("main", "local", "c2"), ref("origin/main", "remote", "c1")]);
    expect(map.get("c2")![0].remotes).toEqual([]);
    expect(map.get("c1")![0].label).toBe("origin/main");
  });
});

describe("format", () => {
  it("makes initials", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Grace Brewster Hopper")).toBe("GH");
    expect(initials("linus")).toBe("LI");
    expect(initials("  ")).toBe("?");
  });

  it("formats relative times", () => {
    const now = Date.UTC(2026, 9, 29, 12);
    const s = now / 1000;
    expect(relativeTime(s - 30, now)).toBe("just now");
    expect(relativeTime(s - 5 * 60, now)).toBe("5 min ago");
    expect(relativeTime(s - 3600, now)).toBe("1 hour ago");
    expect(relativeTime(s - 86400 * 1.5, now)).toBe("yesterday");
    expect(relativeTime(s - 86400 * 3, now)).toBe("3 days ago");
  });

  it("splits paths", () => {
    expect(splitPath("src/a/b.ts")).toEqual({ dir: "src/a/", base: "b.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", base: "README.md" });
  });
});
