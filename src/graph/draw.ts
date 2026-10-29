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
}

function segment(ctx: CanvasRenderingContext2D, s: Seg, y0: number, y1: number) {
  const x0 = laneX(s.from);
  const x1 = laneX(s.to);
  ctx.strokeStyle = laneColor(s.color);
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
    const x = laneX(c.lane);
    const y = i * ROW_H - o.scrollTop + ROW_H / 2;
    const color = laneColor(c.color);
    const selected = c.id === o.selectedId;

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
      ctx.strokeStyle = selected ? "#ffffff" : color;
      ctx.beginPath();
      ctx.arc(x, y, NODE_R + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = o.nodeText;
    ctx.fillText(initials(c.authorName), x, y + 0.5);
  }
}
