// Vertical drag handle between two panels. Reports the new width of the
// panel on its `side` while dragging.

import { useRef } from "react";

export function Splitter({
  width,
  side,
  min,
  max,
  onChange,
}: {
  width: number;
  /** Which neighbour the width belongs to. */
  side: "left" | "right";
  min: number;
  max: number;
  onChange: (w: number) => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const dx = e.clientX - start.current.x;
        const w = start.current.w + (side === "left" ? dx : -dx);
        onChange(Math.round(Math.max(min, Math.min(max, w))));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
    />
  );
}
