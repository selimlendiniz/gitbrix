// Parse a file with git conflict markers into plain and conflicted
// segments, and put a resolved file back together.
//
//   <<<<<<< ours-label
//   ours lines
//   ||||||| base-label     (only with merge.conflictStyle=diff3/zdiff3)
//   base lines
//   =======
//   theirs lines
//   >>>>>>> theirs-label

export type Choice = "ours" | "theirs" | "ours-theirs" | "theirs-ours";

export interface TextSegment {
  kind: "text";
  lines: string[];
}

export interface ConflictSegment {
  kind: "conflict";
  ours: string[];
  base: string[] | null;
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

export type Segment = TextSegment | ConflictSegment;

export interface Parsed {
  segments: Segment[];
  /** The file ended with a newline. */
  finalNewline: boolean;
}

// Lines keep a trailing "\r" in CRLF files (so joining with "\n" restores
// the endings); markers are recognised without it.
const marker = (line: string, c: string) => {
  const l = line.endsWith("\r") ? line.slice(0, -1) : line;
  return l.startsWith(c.repeat(7)) && (l.length === 7 || l[7] === " ");
};
const label = (line: string) => line.slice(8).replace(/\r$/, "");

export function parseConflicts(text: string): Parsed {
  const finalNewline = text.endsWith("\n");
  const lines = (finalNewline ? text.slice(0, -1) : text).split("\n");
  const segments: Segment[] = [];
  let plain: string[] = [];

  let i = 0;
  while (i < lines.length) {
    if (!marker(lines[i], "<")) {
      plain.push(lines[i++]);
      continue;
    }
    // Find the matching end before committing to a conflict block, so a
    // stray "<<<<<<<" in ordinary text stays text.
    const start = i;
    let sep = -1;
    let baseAt = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (marker(lines[j], "|") && sep < 0 && baseAt < 0) baseAt = j;
      else if (marker(lines[j], "=") && sep < 0) sep = j;
      else if (marker(lines[j], ">") && sep >= 0) {
        end = j;
        break;
      } else if (marker(lines[j], "<")) break;
    }
    if (sep < 0 || end < 0) {
      plain.push(lines[i++]);
      continue;
    }
    if (plain.length) segments.push({ kind: "text", lines: plain });
    plain = [];
    const oursEnd = baseAt >= 0 ? baseAt : sep;
    segments.push({
      kind: "conflict",
      ours: lines.slice(start + 1, oursEnd),
      base: baseAt >= 0 ? lines.slice(baseAt + 1, sep) : null,
      theirs: lines.slice(sep + 1, end),
      oursLabel: label(lines[start]),
      theirsLabel: label(lines[end]),
    });
    i = end + 1;
  }
  if (plain.length) segments.push({ kind: "text", lines: plain });
  return { segments, finalNewline };
}

export function resolvedLines(c: ConflictSegment, choice: Choice): string[] {
  switch (choice) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "ours-theirs":
      return [...c.ours, ...c.theirs];
    case "theirs-ours":
      return [...c.theirs, ...c.ours];
  }
}

/** The file with every conflict replaced by its chosen side, or `null`
 *  while some conflict has no choice yet. */
export function resolve(parsed: Parsed, choices: (Choice | undefined)[]): string | null {
  const out: string[] = [];
  let n = 0;
  for (const s of parsed.segments) {
    if (s.kind === "text") {
      out.push(...s.lines);
      continue;
    }
    const choice = choices[n++];
    if (!choice) return null;
    out.push(...resolvedLines(s, choice));
  }
  const text = out.join("\n");
  return parsed.finalNewline && out.length ? text + "\n" : text;
}
