// Drag handle between two panels. Reports the new width of the panel on
// its `side` while dragging; "top" is a horizontal handle that sizes the
// panel below it (the terminal) by height.

import { PointerEvent, useRef } from "react";

export function Splitter({
  width,
  side,
  min,
  max,
  onChange,
}: {
  width: number;
  /** Which neighbour the size belongs to. */
  side: "left" | "right" | "top";
  min: number;
  max: number;
  onChange: (w: number) => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const pos = (e: PointerEvent) => (side === "top" ? e.clientY : e.clientX);
  return (
    <div
      className={side === "top" ? "splitter horizontal" : "splitter"}
      role="separator"
      aria-orientation={side === "top" ? "horizontal" : "vertical"}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: pos(e), w: width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = pos(e) - start.current.x;
        const w = start.current.w + (side === "left" ? dx : -dx);
        onChange(Math.round(Math.max(min, Math.min(max, w))));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
}
