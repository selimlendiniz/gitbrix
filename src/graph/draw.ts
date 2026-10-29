// Canvas drawing for the commit graph. Rows are self-contained (see
// src-tauri/src/git/graph.rs), so only the visible window is drawn.

import { CommitRow, Seg, WIP_ID } from "../api";
import { laneColor } from "../colors";
import { initials } from "../format";

export const ROW_H = 30;
export const LANE_W = 20;
export const GRAPH_PAD = 14;
const NODE_R = 10;
const MERGE_R = 4.5;

export function laneX(lane: number): number {
  return GRAPH_PAD + lane * LANE_W;
}

export function graphWidth(maxLanes: number): number {
  return Math.max(64, GRAPH_PAD * 2 + Math.max(1, maxLanes) * LANE_W - LANE_W / 2);
}

export interface DrawOptions {
  commits: CommitRow[];
  first: number;
  last: number;
  scrollTop: number;
  width: number;
  height: number;
  selectedId: string | null;
  headId: string | null;
  background: string;
  nodeText: string;
  /** Ring around the selected commit. */
  ring: string;
}

function segment(ctx: CanvasRenderingContext2D, [from, to, color]: Seg, y0: number, y1: number) {
  const x0 = laneX(from);
  const x1 = laneX(to);
  ctx.strokeStyle = laneColor(color);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (x0 === x1) {
    ctx.lineTo(x1, y1);
  } else {
    // S-curve: leave vertically, arrive vertically.
    const my = (y0 + y1) / 2;
    ctx.bezierCurveTo(x0, my, x1, my, x1, y1);
  }
  ctx.stroke();
}

export function drawGraph(ctx: CanvasRenderingContext2D, o: DrawOptions) {
  ctx.clearRect(0, 0, o.width, o.height);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";

  for (let i = o.first; i <= o.last; i++) {
    const c = o.commits[i];
    if (!c) continue;
    const top = i * ROW_H - o.scrollTop;
    const mid = top + ROW_H / 2;
    for (const s of c.up) segment(ctx, s, top, mid);
    for (const s of c.down) segment(ctx, s, mid, top + ROW_H);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "600 9px Inter, system-ui, sans-serif";

  for (let i = o.first; i <= o.last; i++) {
    const c = o.commits[i];
    if (!c) continue;
    const y = i * ROW_H - o.scrollTop + ROW_H / 2;
    const color = laneColor(c.color);
    const selected = c.id === o.selectedId;
    let x = laneX(c.lane);

    // Lane is beyond the visible graph column: mark the commit at the edge.
    if (x > o.width - NODE_R) {
      x = o.width - 7;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x - 5, y - 6);
      ctx.lineTo(x + 4, y);
      ctx.lineTo(x - 5, y + 6);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      if (selected) {
        ctx.strokeStyle = o.ring;
        ctx.stroke();
      }
      continue;
    }

    if (c.id === WIP_ID) {
      ctx.fillStyle = o.background;
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(x, y, NODE_R - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }

    if (c.kind === "stash") {
      // A stash: an open box in the lane colour.
      const r = 6.5;
      ctx.fillStyle = o.background;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x - r, y - r, r * 2, r * 2, 3);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 3, y - 1.5);
      ctx.lineTo(x + 3, y - 1.5);
      ctx.moveTo(x - 3, y + 1.5);
      ctx.lineTo(x + 3, y + 1.5);
      ctx.stroke();
      if (selected) {
        ctx.strokeStyle = o.ring;
        ctx.beginPath();
        ctx.roundRect(x - r - 3, y - r - 3, (r + 3) * 2, (r + 3) * 2, 5);
        ctx.stroke();
      }
      continue;
    }

    if (c.parents.length > 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, selected ? MERGE_R + 1.5 : MERGE_R, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    // Ordinary commit: a filled disc with the author's initials.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, NODE_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = o.background;
    ctx.stroke();
    if (c.id === o.headId || selected) {
      ctx.strokeStyle = selected ? o.ring : color;
      ctx.beginPath();
      ctx.arc(x, y, NODE_R + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = o.nodeText;
    ctx.fillText(initials(c.authorName), x, y + 0.5);
  }
}
