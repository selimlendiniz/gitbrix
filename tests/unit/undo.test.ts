import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoInfo } from "../../src/api";

const calls: unknown[][] = [];
vi.mock("../../src/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/api")>();
  const rec =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  return {
    ...real,
    api: { checkoutBranch: rec("checkoutBranch"), checkoutDetached: rec("checkoutDetached"), reset: rec("reset") },
  };
});

const { headUndo, nextUndo } = await import("../../src/undo");

const info = (over: Partial<RepoInfo>): RepoInfo => ({
  path: "/r",
  name: "r",
  headBranch: "main",
  headOid: "a".repeat(40),
  detached: false,
  unborn: false,
  state: "clean",
  upstream: null,
  ahead: 0,
  behind: 0,
  ...over,
});

describe("headUndo", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("switches back when the branch changed", async () => {
    await headUndo(info({}), info({ headBranch: "topic" }))!("/r");
    expect(calls).toEqual([["checkoutBranch", "/r", "main"]]);
  });

  it("moves the branch back with reset --keep when it advanced", async () => {
    await headUndo(info({}), info({ headOid: "b".repeat(40) }))!("/r");
    expect(calls).toEqual([["reset", "/r", "a".repeat(40), "keep"]]);
  });

  it("goes back to a detached commit", async () => {
    await headUndo(info({ detached: true, headBranch: null }), info({}))!("/r");
    expect(calls).toEqual([["checkoutDetached", "/r", "a".repeat(40)]]);
  });

  it("has nothing to do when HEAD didn't move or there was no HEAD", () => {
    expect(headUndo(info({}), info({}))).toBeNull();
    expect(headUndo(info({ headOid: null, unborn: true }), info({}))).toBeNull();
  });
});

describe("nextUndo", () => {
  it("picks the newest entry for the open repo", () => {
    const run = async () => {};
    const stack = [
      { label: "a", repo: "/x", run },
      { label: "b", repo: "/y", run },
      { label: "c", repo: "/x", run },
    ];
    expect(nextUndo(stack, "/x")?.label).toBe("c");
    expect(nextUndo(stack, "/z")).toBeUndefined();
  });
});
