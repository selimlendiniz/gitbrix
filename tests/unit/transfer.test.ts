import { describe, expect, it } from "vitest";

import { accountKey, buildExport, mergeById, parseExport } from "../../src/transfer";
import { DEFAULTS } from "../../src/settings";

describe("settings file", () => {
  const accounts = [{ id: "github|https://github.com|me", provider: "github" as const, url: "https://github.com", username: "me", name: "Me" }];
  const file = buildExport(
    { ...DEFAULTS, theme: "light" },
    [{ id: "w1", name: "Work", repos: ["/home/me/code/api"] }],
    [{ id: "p1", name: "Work", userName: "Me", userEmail: "me@work.example", folders: ["/home/me/work"], accounts: [] }],
    accounts,
  );

  it("round-trips, with no tokens or account names", () => {
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/token|"name":"Me"/i);
    const back = parseExport(text);
    expect(back.settings.theme).toBe("light");
    expect(back.workspaces).toEqual(file.workspaces);
    expect(back.profiles).toEqual(file.profiles);
    expect(back.accounts).toEqual([{ provider: "github", url: "https://github.com", username: "me" }]);
  });

  it("keeps only what it knows, with the right types", () => {
    const back = parseExport(
      JSON.stringify({
        gitbrix: 1,
        settings: { theme: "dark", prPoll: "often", unknown: 1 },
        workspaces: [{ id: "w", name: "W", repos: ["/a", 3] }, { name: "no id" }],
        profiles: [{ id: "p", name: "P" }],
        accounts: [{ provider: "bitbucket", url: "https://b.org", username: "x" }, { provider: "gitlab", url: "javascript:x", username: "y" }],
      }),
    );
    expect(back.settings).toEqual({ theme: "dark" });
    expect(back.workspaces).toEqual([{ id: "w", name: "W", repos: ["/a"] }]);
    expect(back.profiles).toEqual([]);
    expect(back.accounts).toEqual([]);
  });

  it("refuses other files and newer formats", () => {
    expect(() => parseExport("not json")).toThrow(/not JSON/);
    expect(() => parseExport('{"a":1}')).toThrow(/isn't a gitbrix settings file/);
    expect(() => parseExport('{"gitbrix":99}')).toThrow(/newer gitbrix/);
  });

  it("merges by id", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    expect(mergeById([a, b], [{ id: "b", v: 2 }, { id: "c", v: 2 }])).toEqual([a, { id: "b", v: 2 }, { id: "c", v: 2 }]);
  });

  it("matches an account however its address ends", () => {
    expect(accountKey({ provider: "gitlab", url: "https://git.corp/", username: "s" })).toBe(
      accountKey({ provider: "gitlab", url: "https://git.corp", username: "s" }),
    );
  });
});
