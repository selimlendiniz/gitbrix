import { describe, expect, it } from "vitest";

import { issueBranchName, issueOfBranch, sortIssues, withClosing } from "../../src/issues";
import type { Issue } from "../../src/api";

describe("issue branches", () => {
  it("names a branch after the number and title", () => {
    expect(issueBranchName({ number: 12, title: "Login fails on Safari!" })).toBe("12-login-fails-on-safari");
    expect(issueBranchName({ number: 7, title: "Çıkışta şifre ekranı göçüyor" })).toBe("7-cikista-sifre-ekrani-gocuyor");
    expect(issueBranchName({ number: 3, title: "!!!" })).toBe("issue-3");
    expect(issueBranchName({ number: 5, title: "a ".repeat(40) }).length).toBeLessThanOrEqual(42);
    expect(issueBranchName({ number: 5, title: "a ".repeat(40) })).not.toMatch(/-$/);
  });

  it("finds the issue in a branch name", () => {
    expect(issueOfBranch("12-login-fails")).toBe(12);
    expect(issueOfBranch("feature/12-login-fails")).toBe(12);
    expect(issueOfBranch("main")).toBeNull();
    expect(issueOfBranch("v2-api")).toBeNull();
    expect(issueOfBranch(null)).toBeNull();
  });

  it("adds Closes once", () => {
    expect(withClosing("", 12)).toBe("Closes #12");
    expect(withClosing("Why it broke\n", 12)).toBe("Why it broke\n\nCloses #12");
    expect(withClosing("Fixes #12", 12)).toBe("Fixes #12");
    // #120 isn't #12.
    expect(withClosing("See #120", 12)).toBe("See #120\n\nCloses #12");
  });

  it("puts the user's issues first", () => {
    const i = (number: number, assignedToMe: boolean, updated: string) => ({ number, assignedToMe, updated }) as Issue;
    expect(sortIssues([i(1, false, "2026-10-03"), i(2, true, "2026-10-01"), i(3, false, "2026-10-05")]).map((x) => x.number)).toEqual([
      2, 3, 1,
    ]);
  });
});
