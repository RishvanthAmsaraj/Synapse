/**
 * layout.ts — the panel layout engine.
 *
 * Every panel has an explicit position: x (column, 0-based), y (row, 0-based),
 * w and h in grid cells. Nothing is inferred from the DOM and nothing is left
 * to CSS auto-placement.
 *
 * That is a deliberate reversal. Earlier versions let CSS Grid place panels
 * automatically and then tried to work out, at drag time, where a panel had
 * ended up — by measuring rectangles, reading computed track lists, and
 * mapping pixels back to line numbers. Every one of those readings was a
 * guess about a layout the browser owned, and each guess failed differently:
 * auto-placement moved panels mid-resize, and `grid-template-rows` reports
 * `none` for an implicit grid, which silently pinned every panel to row 1.
 *
 * Owning the coordinates removes the entire class of bug. It also makes the
 * layout a pure data structure, so all of this is unit-testable without a
 * browser — which is what the DOM-measuring approach never allowed.
 */

export const COLUMNS = 12;
export const MIN_W = 2;
export const MAX_W = COLUMNS;
export const MIN_H = 2;
export const MAX_H = 14;

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const clampW = (n: number) => Math.max(MIN_W, Math.min(MAX_W, Math.round(n)));
export const clampH = (n: number) => Math.max(MIN_H, Math.min(MAX_H, Math.round(n)));

export function overlaps(a: Box, b: Box): boolean {
  if (a.id === b.id) return false;
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Everything the given box currently runs into. */
export function collisions(boxes: Box[], box: Box): Box[] {
  return boxes.filter((b) => overlaps(box, b));
}

/**
 * Pull every box as far up as it will go, preserving relative order.
 *
 * This is what keeps the stage from developing holes after a resize or a
 * removal, and it is what makes the layout stable: the same set of boxes
 * always compacts to the same arrangement.
 */
export function compact(boxes: Box[]): Box[] {
  const sorted = [...boxes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const placed: Box[] = [];
  for (const box of sorted) {
    const moved = { ...box };
    while (moved.y > 0) {
      const up = { ...moved, y: moved.y - 1 };
      if (collisions(placed, up).length > 0) break;
      moved.y = up.y;
    }
    placed.push(moved);
  }
  return placed;
}

/**
 * Resolve overlaps by pushing whatever `anchor` displaced downward, then
 * compacting. The anchor keeps the position the user chose; everything else
 * yields to it, which is how a direct-manipulation grid should behave.
 */
export function resolve(boxes: Box[], anchorId: string): Box[] {
  const anchor = boxes.find((b) => b.id === anchorId);
  if (!anchor) return compact(boxes);

  const result = boxes.map((b) => ({ ...b }));
  const settled = new Set<string>([anchorId]);

  // Repeatedly displace anything overlapping a settled box. Bounded by the
  // box count so a pathological arrangement cannot spin.
  for (let pass = 0; pass < result.length + 2; pass++) {
    let moved = false;
    for (const box of result) {
      if (settled.has(box.id)) continue;
      const hits = result.filter((o) => settled.has(o.id) && overlaps(box, o));
      if (hits.length === 0) continue;
      box.y = Math.max(...hits.map((o) => o.y + o.h));
      moved = true;
    }
    for (const box of result) {
      if (result.filter((o) => overlaps(box, o)).length === 0) settled.add(box.id);
    }
    if (!moved) break;
  }

  // Anything still overlapping gets pushed below everything else.
  for (const box of result) {
    let guard = 0;
    while (collisions(result, box).length > 0 && guard++ < result.length * 2) {
      const hits = collisions(result, box);
      box.y = Math.max(...hits.map((o) => o.y + o.h));
    }
  }

  return compact(result);
}

/** First position, scanning top-to-bottom then left-to-right, that fits w x h. */
export function findSlot(boxes: Box[], w: number, h: number): { x: number; y: number } {
  const width = Math.min(w, COLUMNS);
  const maxY = boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + width <= COLUMNS; x++) {
      const probe: Box = { id: '__probe', x, y, w: width, h };
      if (collisions(boxes, probe).length === 0) return { x, y };
    }
  }
  return { x: 0, y: maxY };
}

/** Add a box at the first slot that fits. */
export function place(boxes: Box[], id: string, w: number, h: number): Box[] {
  const width = clampW(w);
  const height = clampH(h);
  const { x, y } = findSlot(boxes, width, height);
  return compact([...boxes, { id, x, y, w: width, h: height }]);
}

/** Resize in place, keeping the top-left corner and pushing others aside. */
export function resize(boxes: Box[], id: string, w: number, h: number): Box[] {
  const next = boxes.map((b) => {
    if (b.id !== id) return { ...b };
    const width = clampW(w);
    return {
      ...b,
      // Never let a panel run off the right edge — slide it left instead of
      // silently truncating what the user asked for.
      x: Math.min(b.x, COLUMNS - width),
      w: width,
      h: clampH(h),
    };
  });
  return resolve(next, id);
}

/** Move a box to a target cell, clamped into the grid. */
export function moveTo(boxes: Box[], id: string, x: number, y: number): Box[] {
  const next = boxes.map((b) => {
    if (b.id !== id) return { ...b };
    return {
      ...b,
      x: Math.max(0, Math.min(COLUMNS - b.w, Math.round(x))),
      y: Math.max(0, Math.round(y)),
    };
  });
  return resolve(next, id);
}

export function removeBox(boxes: Box[], id: string): Box[] {
  return compact(boxes.filter((b) => b.id !== id));
}

/** Total rows the arrangement occupies. */
export function height(boxes: Box[]): number {
  return boxes.reduce((m, b) => Math.max(m, b.y + b.h), 0);
}
