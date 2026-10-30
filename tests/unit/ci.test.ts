import { describe, expect, it } from "vitest";

import { ciNews } from "../../src/ci";

describe("CI news", () => {
  const was = (state: string) => ({ repo: "/r", sha: "a", state });
  it("tells when a run on the same commit ends", () => {
    expect(ciNews(was("running"), "/r", "a", "failed")).toBe("failed");
    expect(ciNews(was("pending"), "/r", "a", "success")).toBe("success");
  });
  it("stays quiet otherwise", () => {
    expect(ciNews(null, "/r", "a", "failed")).toBeNull();
    expect(ciNews(was("success"), "/r", "a", "failed")).toBeNull();
    expect(ciNews(was("running"), "/r", "a", "running")).toBeNull();
    expect(ciNews(was("running"), "/r", "b", "failed")).toBeNull();
    expect(ciNews(was("running"), "/other", "a", "failed")).toBeNull();
    expect(ciNews(was("running"), "/r", "a", undefined)).toBeNull();
  });
});
