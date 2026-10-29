// Drag and drop, tracked with mouse events. HTML5 drag and drop doesn't
// reach the page in Tauri's Linux webview while dropping files on the
// window is enabled (we use that to open folders), and mouse events also
// let WebDriver tests drive drags in the real app.
//
// Sources call `beginDrag` from onMouseDown; drop targets register with
// `dropTarget(...)` as a ref. What a drop does comes from `dropActions`
// (actions.ts): one direct action runs at once, otherwise a menu opens.

import { create } from "zustand";

import { CommitRow, RefInfo, StashInfo } from "./api";
import { MenuItem, useStore } from "./store";

export type DragItem =
  | { kind: "ref"; ref: RefInfo }
  | { kind: "commit"; commit: CommitRow }
  | { kind: "stash"; stash: StashInfo }
  | { kind: "files"; paths: string[]; staged: boolean };

export type DropTarget =
  | { kind: "ref"; ref: RefInfo }
  /** A graph row; the WIP row has id WIP_ID. */
  | { kind: "commit"; commit: CommitRow }
  | { kind: "remote"; remote: string }
  /** The staged (true) or unstaged file area. */
  | { kind: "files"; staged: boolean };

export interface DropAction extends MenuItem {
  /** Run without asking when it is the only choice. */
  direct?: boolean;
}

type Resolver = (item: DragItem, target: DropTarget) => DropAction[];

let resolve: Resolver = () => [];

/** Set by actions.ts (it knows what the operations are). */
export function setDropResolver(r: Resolver) {
  resolve = r;
}

export const useDrag = create<{ label: string | null; x: number; y: number }>(() => ({ label: null, x: 0, y: 0 }));

const targets = new WeakMap<Element, DropTarget>();

/** Ref callback marking an element as a drop target. */
export function dropTarget(target: DropTarget) {
  return (el: HTMLElement | null) => {
    if (el) targets.set(el, target);
  };
}

function targetAt(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  while (el && !targets.has(el)) el = el.parentElement;
  return el;
}

/** Inner sources (a branch label inside a commit row) win over outer ones. */
let claimed: Event | null = null;

const THRESHOLD = 5;

/**
 * Follow the mouse after a mousedown: nothing happens until it moves a few
 * pixels, so plain clicks stay clicks. The click that ends a drag is
 * swallowed.
 */
export function trackDrag(
  e: React.MouseEvent,
  handlers: { start: () => void; move: (ev: MouseEvent) => void; end: (ev: MouseEvent | null) => void },
) {
  if (e.button !== 0 || claimed === e.nativeEvent) return;
  claimed = e.nativeEvent;
  const sx = e.clientX;
  const sy = e.clientY;
  let active = false;

  const move = (ev: MouseEvent) => {
    if (!active) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < THRESHOLD) return;
      active = true;
      window.getSelection()?.removeAllRanges();
      document.body.classList.add("dragging");
      handlers.start();
    }
    ev.preventDefault();
    handlers.move(ev);
  };
  const finish = (ev: MouseEvent | null) => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("keydown", key, true);
    if (!active) return;
    document.body.classList.remove("dragging");
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    handlers.end(ev);
  };
  const up = (ev: MouseEvent) => finish(ev);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      finish(null);
    }
  };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("keydown", key, true);
}

/** Start dragging `item` (shown as `label` next to the pointer). */
export function beginDrag(e: React.MouseEvent, item: DragItem, label: string) {
  let over: Element | null = null;
  const setOver = (el: Element | null) => {
    if (el === over) return;
    over?.classList.remove("drop-target");
    el?.classList.add("drop-target");
    over = el;
  };
  trackDrag(e, {
    start: () => useDrag.setState({ label }),
    move: (ev) => {
      useDrag.setState({ x: ev.clientX, y: ev.clientY });
      const el = targetAt(ev.clientX, ev.clientY);
      setOver(el && resolve(item, targets.get(el)!).length > 0 ? el : null);
    },
    end: (ev) => {
      const el = over;
      setOver(null);
      useDrag.setState({ label: null });
      if (!ev || !el) return;
      const actions = resolve(item, targets.get(el)!);
      if (actions.length === 1 && actions[0].direct) actions[0].onSelect?.();
      else if (actions.length) useStore.getState().showMenu(ev.clientX, ev.clientY, actions);
    },
  });
}
