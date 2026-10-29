import { describe, expect, it } from "vitest";

import { changedRange, diffTokens, languageFor, markRange, parseHighlighted } from "../../src/diff/highlight";

describe("parseHighlighted", () => {
  it("splits spans across lines and decodes entities", () => {
    const html = '<span class="hljs-comment">/* a\nb */</span> x &lt; y &amp;&amp; <span class="hljs-string">&quot;s&quot;</span>';
    expect(parseHighlighted(html)).toEqual([
      [{ text: "/* a", cls: "comment" }],
      [
        { text: "b */", cls: "comment" },
        { text: " x < y && ", cls: null },
        { text: '"s"', cls: "string" },
      ],
    ]);
  });

  it("keeps empty lines", () => {
    expect(parseHighlighted("a\n\nb")).toEqual([[{ text: "a", cls: null }], [], [{ text: "b", cls: null }]]);
  });
});

describe("intra-line changes", () => {
  it("finds the differing middle", () => {
    expect(changedRange("let x = 1;", "let x = 42;")).toEqual([
      [8, 9],
      [8, 10],
    ]);
    expect(changedRange("abc", "xyz")).toBeNull();
  });

  it("marks a range across token boundaries", () => {
    const t = markRange(
      [
        { text: "let ", cls: "keyword" },
        { text: "x = 1", cls: null },
      ],
      2,
      6,
    );
    expect(t).toEqual([
      { text: "le", cls: "keyword" },
      { text: "t ", cls: "keyword", mark: true },
      { text: "x ", cls: null, mark: true },
      { text: "= 1", cls: null },
    ]);
  });
});

describe("diffTokens", () => {
  it("highlights by language and marks paired changes", async () => {
    const [hunk] = await diffTokens("src/a.ts", [
      {
        lines: [
          { kind: "ctx", text: "// hi" },
          { kind: "del", text: "const x = 1;" },
          { kind: "add", text: "const x = 2;" },
        ],
      },
    ]);
    expect(hunk[0][0].cls).toBe("comment");
    expect(hunk[1].find((t) => t.text === "const")?.cls).toBe("keyword");
    expect(hunk[1].filter((t) => t.mark).map((t) => t.text).join("")).toBe("1");
    expect(hunk[2].filter((t) => t.mark).map((t) => t.text).join("")).toBe("2");
  });

  it("works without a known language", async () => {
    const [hunk] = await diffTokens("notes.unknownext", [{ lines: [{ kind: "add", text: "hello" }] }]);
    expect(hunk[0]).toEqual([{ text: "hello", cls: null }]);
  });

  it("maps file names to languages", () => {
    expect(languageFor("src-tauri/src/lib.rs")).toBe("rust");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBeNull();
    expect(languageFor("a/b.TSX")).toBe("typescript");
  });
});
