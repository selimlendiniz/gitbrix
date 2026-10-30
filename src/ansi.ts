// CI logs as the runners print them: ANSI colours, GitLab's collapsible
// section markers, carriage-return progress lines, GitHub's timestamps
// and ##[group] / ##[error] markers. Turned into lines of coloured text.

export interface Span {
  text: string;
  /** `fg-1`…`fg-15` (the 16 terminal colours), `bold`, joined by spaces. */
  cls: string | null;
}

export type LogLine = { spans: Span[]; kind: "plain" | "error" | "group" };

const ESC = "\u001b";

export function parseLog(log: string): LogLine[] {
  let fg: number | null = null;
  let bold = false;
  const out: LogLine[] = [];
  for (let raw of log.replace(/\r\n/g, "\n").split("\n")) {
    // GitLab sections: "section_start:1700000000:name\r\x1b[0K" before the header.
    raw = raw.replace(/section_(?:start|end):\d+:[^\r\n]*\r/g, "");
    // A progress line rewrites itself: what's left after the last \r.
    const cr = raw.lastIndexOf("\r");
    if (cr >= 0 && cr < raw.length - 1) raw = raw.slice(cr + 1);
    else raw = raw.replace(/\r/g, "");
    // GitHub: "2026-10-02T10:00:00.1234567Z " in front of every line.
    raw = raw.replace(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /, "");
    let kind: LogLine["kind"] = "plain";
    const marker = raw.match(/^##\[(group|endgroup|error|warning)\]/);
    if (marker) {
      raw = raw.slice(marker[0].length);
      if (marker[1] === "endgroup") continue;
      kind = marker[1] === "error" ? "error" : marker[1] === "group" ? "group" : "plain";
    }
    const spans: Span[] = [];
    const push = (text: string) => {
      if (!text) return;
      const cls = [fg !== null ? `fg-${fg}` : "", bold ? "bold" : ""].filter(Boolean).join(" ") || null;
      const last = spans[spans.length - 1];
      if (last && last.cls === cls) last.text += text;
      else spans.push({ text, cls });
    };
    const re = new RegExp(`${ESC}\\[([0-9;?]*)([A-Za-z])`, "g");
    let at = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      push(raw.slice(at, m.index));
      at = m.index + m[0].length;
      if (m[2] !== "m") continue;
      const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === 0) {
          fg = null;
          bold = false;
        } else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c >= 30 && c <= 37) fg = c - 30;
        else if (c >= 90 && c <= 97) fg = c - 90 + 8;
        else if (c === 39) fg = null;
        else if (c === 38 && codes[i + 1] === 5) {
          // 256 colours: the first 16 are the usual ones; others dropped.
          const n = codes[i + 2];
          fg = n < 16 ? n : null;
          i += 2;
        } else if (c === 38 && codes[i + 1] === 2) i += 4;
      }
    }
    push(raw.slice(at));
    out.push({ spans, kind });
  }
  // The final newline leaves an empty last line.
  if (out.length && !out[out.length - 1].spans.length) out.pop();
  return out;
}
