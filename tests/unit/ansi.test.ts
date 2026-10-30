import { describe, expect, it } from "vitest";

import { parseLog } from "../../src/ansi";

const E = "\u001b";

describe("CI logs", () => {
  it("colours, bold and resets", () => {
    const [line] = parseLog(`${E}[32;1mok${E}[0m done ${E}[31merror${E}[39m`);
    expect(line.spans).toEqual([
      { text: "ok", cls: "fg-2 bold" },
      { text: " done ", cls: null },
      { text: "error", cls: "fg-1" },
    ]);
  });

  it("GitLab sections and erase-line codes go", () => {
    const lines = parseLog(`section_start:1700000000:prepare\r${E}[0K${E}[36;1mPreparing${E}[0;m\nsection_end:1700000001:prepare\r${E}[0K\n`);
    expect(lines.map((l) => l.spans.map((s) => s.text).join(""))).toEqual(["Preparing", ""]);
  });

  it("progress lines keep their last state", () => {
    expect(parseLog("10%\r50%\r100%")[0].spans[0].text).toBe("100%");
  });

  it("GitHub timestamps and markers", () => {
    const lines = parseLog("2026-10-02T10:00:00.1234567Z ##[group]Run tests\n2026-10-02T10:00:01.0Z ok\n2026-10-02T10:00:02Z ##[endgroup]\n2026-10-02T10:00:03Z ##[error]Process completed with exit code 1.");
    expect(lines.map((l) => [l.kind, l.spans.map((s) => s.text).join("")])).toEqual([
      ["group", "Run tests"],
      ["plain", "ok"],
      ["error", "Process completed with exit code 1."],
    ]);
  });
});
