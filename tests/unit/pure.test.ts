import { describe, expect, it } from "vitest";

import { DiffLine, RefInfo } from "../../src/api";
import { fuzzyScore } from "../../src/components/CommandPalette";
import { coAuthorsOf } from "../../src/components/CommitPanel";
import { fileTree } from "../../src/components/FileList";
import { planProblems, Row } from "../../src/components/RebaseView";
import { buildTree, countLeaves } from "../../src/components/RefTree";
import { nameFromUrl } from "../../src/components/RepoDialogs";
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

describe("nameFromUrl", () => {
  it("derives a folder name from common URL shapes", () => {
    expect(nameFromUrl("https://github.com/owner/project.git")).toBe("project");
    expect(nameFromUrl("git@github.com:owner/tool.git")).toBe("tool");
    expect(nameFromUrl("https://gitlab.com/group/sub/repo/")).toBe("repo");
    expect(nameFromUrl("/srv/git/local.git")).toBe("local");
    expect(nameFromUrl("")).toBe("");
  });
});

describe("planProblems", () => {
  const row = (id: string, action: Row["action"], newMessage = "msg"): Row => ({
    id,
    summary: id,
    message: "m",
    authorName: "a",
    time: 0,
    action,
    newMessage,
  });

  it("accepts a normal plan", () => {
    expect(planProblems([row("c", "squash"), row("b", "pick"), row("a", "drop")])).toEqual([]);
  });

  it("rejects squashing the oldest kept commit", () => {
    expect(planProblems([row("b", "pick"), row("a", "fixup")])).toHaveLength(1);
    expect(planProblems([row("b", "squash"), row("a", "drop")])).toHaveLength(1);
  });

  it("requires a message for reword", () => {
    expect(planProblems([row("b", "reword", "  "), row("a", "pick")])).toHaveLength(1);
  });
});


describe("fuzzyScore", () => {
  it("matches subsequences and prefers tighter, word-start matches", () => {
    expect(fuzzyScore("fx", "Checkout fix/typo")).not.toBeNull();
    expect(fuzzyScore("zz", "Checkout main")).toBeNull();
    const tight = fuzzyScore("push", "Action Push")!;
    const loose = fuzzyScore("push", "Action Pull (rebase) stash")!;
    expect(tight).toBeGreaterThan(loose);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("buildTree", () => {
  const r = (name: string) => ({ name }) as RefInfo;
  it("groups slash-separated names into folders", () => {
    const t = buildTree([r("main"), r("feature/a"), r("feature/b"), r("fix/deep/c")], (x) => x.name);
    expect(t.leaves.map((l) => l.label)).toEqual(["main"]);
    expect(t.folders.map((f) => f.name)).toEqual(["feature", "fix"]);
    expect(t.folders[0].leaves.map((l) => l.label)).toEqual(["a", "b"]);
    expect(t.folders[1].folders[0].path).toBe("fix/deep");
    expect(countLeaves(t)).toBe(4);
  });
});

describe("coAuthorsOf", () => {
  it("reads Co-authored-by trailers, case-insensitively", () => {
    const msg = "Fix it\n\nBody\n\nCo-authored-by: Grace Hopper <grace@x>\nco-authored-by:Ada <ada@y>\n";
    expect(coAuthorsOf(msg)).toEqual([
      { name: "Grace Hopper", email: "grace@x" },
      { name: "Ada", email: "ada@y" },
    ]);
    expect(coAuthorsOf("nothing here")).toEqual([]);
  });
});

describe("fileTree", () => {
  const f = (path: string) => ({ path, oldPath: null, status: "modified" as const });
  it("groups by directory and merges single-child chains", () => {
    const t = fileTree([f("README.md"), f("src/components/A.tsx"), f("src/components/B.tsx"), f("src/main.ts"), f("docs/deep/x/y.md")]);
    expect(t.files.map((x) => x.path)).toEqual(["README.md"]);
    expect(t.dirs.map((d) => d.name)).toEqual(["src", "docs/deep/x"]);
    const src = t.dirs[0];
    expect(src.count).toBe(3);
    expect(src.dirs.map((d) => d.name)).toEqual(["components"]);
    expect(src.files.map((x) => x.path)).toEqual(["src/main.ts"]);
  });
});
