import { describe, expect, it } from "vitest";

import { projectPage, resolveLink } from "../../src/components/Markdown";

describe("markdown links", () => {
  it("finds the project page of a request or issue", () => {
    expect(projectPage("https://gitlab.com/g/sub/app/-/merge_requests/3")).toBe("https://gitlab.com/g/sub/app");
    expect(projectPage("https://git.corp/team/app/-/issues/7")).toBe("https://git.corp/team/app");
    expect(projectPage("https://github.com/o/r/pull/3")).toBe("https://github.com/o/r");
    expect(projectPage("https://github.com/o/r/issues/9")).toBe("https://github.com/o/r");
    expect(projectPage("not a url")).toBeNull();
  });

  it("resolves links against the project", () => {
    const gl = "https://gitlab.com/g/app";
    expect(resolveLink("https://example.com/x", gl)).toBe("https://example.com/x");
    expect(resolveLink("mailto:a@b.c", gl)).toBe("mailto:a@b.c");
    expect(resolveLink("/uploads/abc/shot.png", gl)).toBe("https://gitlab.com/g/app/uploads/abc/shot.png");
    expect(resolveLink("/g/other/-/issues/1", gl)).toBe("https://gitlab.com/g/other/-/issues/1");
    expect(resolveLink("docs/setup.md", gl)).toBe("https://gitlab.com/g/app/-/blob/HEAD/docs/setup.md");
    expect(resolveLink("./README.md", "https://github.com/o/r")).toBe("https://github.com/o/r/blob/HEAD/README.md");
  });

  it("opens nothing that isn't a web or mail address", () => {
    expect(resolveLink("javascript:alert(1)", "https://gitlab.com/g/app")).toBeNull();
    expect(resolveLink("file:///etc/passwd", "https://gitlab.com/g/app")).toBeNull();
    expect(resolveLink("#section", "https://gitlab.com/g/app")).toBeNull();
    expect(resolveLink("docs/x.md", null)).toBeNull();
    expect(resolveLink(undefined, null)).toBeNull();
  });
});
