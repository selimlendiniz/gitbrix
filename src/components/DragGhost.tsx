import { useDrag } from "../dnd";

/** What is being dragged, next to the pointer. */
export function DragGhost() {
  const { label, x, y } = useDrag();
  if (!label) return null;
  return (
    <div className="drag-ghost" style={{ left: x + 14, top: y + 10 }}>
      {label}
    </div>
  );
}
