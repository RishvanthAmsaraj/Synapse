import { createContext, useContext, useReducer, useRef, useCallback } from 'react';
import * as LAYOUT from './layout';

/**
 * Widgets carry their own geometry, but every decision about that geometry is
 * made by layout.ts — which is pure, and therefore testable without a browser.
 * These two functions are the only bridge between the two representations.
 */
const toBoxes = (ws: Widget[]): LAYOUT.Box[] =>
  ws.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.cols, h: w.rows }));

function applyBoxes(ws: Widget[], boxes: LAYOUT.Box[]): Widget[] {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return ws
    .map((w) => {
      const b = byId.get(w.id);
      return b ? { ...w, x: b.x, y: b.y, cols: b.w, rows: b.h } : w;
    })
    .sort((a, b) => (a.y - b.y) || (a.x - b.x));
}
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Widget {
  id: string;
  type: string;
  data: unknown;
  /** Column of the panel's left edge, 0-based. Owned by the layout engine. */
  x: number;
  /** Row of the panel's top edge, 0-based. */
  y: number;
  /** Column span on a 12-column grid (2–12). */
  cols: number;
  /** Row span (1–4). */
  rows: number;
  /**
   * Which agent produced this panel, when it did not come from the voice
   * model. Several agents can be working on the canvas at once, and a panel
   * that does not say who made it is not much use for supervising them.
   */
  source?: string;
}

/** Bounds for anything the agent or the user can set. */
export const GRID_COLUMNS = LAYOUT.COLUMNS;
export const MIN_COLS = LAYOUT.MIN_W;
export const MIN_ROWS = LAYOUT.MIN_H;
export const MAX_ROWS = LAYOUT.MAX_H;
/**
 * Soft cap. Past this the grid stops being readable and the compositor starts
 * to struggle, so an agent that keeps opening panels retires its own oldest
 * one rather than degrading the whole stage.
 */
export const MAX_PANELS = 8;
export const clampCols = LAYOUT.clampW;
export const clampRows = LAYOUT.clampH;

type Action =
  | { type: 'ADD'; widget: Widget }
  | { type: 'REMOVE'; id: string }
  | { type: 'UPDATE'; id: string; data: unknown }
  | { type: 'FOCUS'; id: string }
  | { type: 'RESIZE'; id: string; cols: number; rows: number }
  | { type: 'MOVE'; id: string; x: number; y: number }
  | { type: 'CLEAR' };

interface CanvasState {
  widgets: Widget[];
  focusedId: string | null;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: CanvasState, action: Action): CanvasState {
  switch (action.type) {
    case 'ADD': {
      let others = state.widgets;
      if (others.length + 1 > MAX_PANELS) {
        const victim = others.find((w) => w.id !== state.focusedId);
        if (victim) others = others.filter((w) => w.id !== victim.id);
      }
      const boxes = LAYOUT.place(toBoxes(others), action.widget.id, action.widget.cols, action.widget.rows);
      return {
        widgets: applyBoxes([...others, action.widget], boxes),
        focusedId: action.widget.id,
      };
    }
    case 'REMOVE': {
      const kept = state.widgets.filter((w) => w.id !== action.id);
      return {
        widgets: applyBoxes(kept, LAYOUT.compact(toBoxes(kept))),
        focusedId: state.focusedId === action.id ? null : state.focusedId,
      };
    }
    case 'UPDATE':
      return {
        widgets: state.widgets.map((w) =>
          w.id === action.id ? { ...w, data: action.data } : w
        ),
        focusedId: state.focusedId,
      };
    case 'FOCUS':
      return { widgets: state.widgets, focusedId: action.id };
    case 'RESIZE':
      return {
        widgets: applyBoxes(
          state.widgets,
          LAYOUT.resize(toBoxes(state.widgets), action.id, action.cols, action.rows),
        ),
        focusedId: state.focusedId,
      };
    case 'MOVE':
      return {
        widgets: applyBoxes(
          state.widgets,
          LAYOUT.moveTo(toBoxes(state.widgets), action.id, action.x, action.y),
        ),
        focusedId: state.focusedId,
      };
    case 'CLEAR':
      return { widgets: [], focusedId: null };
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface CanvasContextValue {
  widgets: Widget[];
  focusedId: string | null;
  addWidget: (widgetType: string, data: unknown, cols?: number, rows?: number, source?: string) => string;
  removeWidget: (id: string) => void;
  updateWidget: (id: string, data: unknown) => void;
  focusWidget: (id: string) => void;
  resizeWidget: (id: string, cols: number, rows: number) => void;
  moveWidget: (id: string, x: number, y: number) => void;
  clearWidgets: () => void;
  getInventoryString: () => string;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CanvasProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { widgets: [], focusedId: null });
  // Use a ref for the ID counter — synchronous, no stale closure issues
  const counterRef = useRef(1);

  const addWidget = useCallback(
    (widgetType: string, data: unknown, cols = 4, rows = 2, source?: string): string => {
      const id = `widget_${counterRef.current++}`;
      dispatch({
        type: 'ADD',
        widget: {
          id, type: widgetType, data, x: 0, y: 0,
          cols: clampCols(cols), rows: clampRows(rows), source,
        },
      });
      return id;
    },
    []
  );

  const removeWidget = useCallback((id: string) => {
    dispatch({ type: 'REMOVE', id });
  }, []);

  const clearWidgets = useCallback(() => {
    dispatch({ type: 'CLEAR' });
  }, []);

  const updateWidget = useCallback((id: string, data: unknown) => {
    dispatch({ type: 'UPDATE', id, data });
  }, []);

  const focusWidget = useCallback((id: string) => {
    dispatch({ type: 'FOCUS', id });
  }, []);

  const resizeWidget = useCallback((id: string, cols: number, rows: number) => {
    dispatch({ type: 'RESIZE', id, cols: clampCols(cols), rows: clampRows(rows) });
  }, []);

  const moveWidget = useCallback((id: string, x: number, y: number) => {
    dispatch({ type: 'MOVE', id, x, y });
  }, []);

  const getInventoryString = useCallback(() => {
    if (state.widgets.length === 0) return 'The canvas is currently empty.';
    const items = state.widgets
      .map((w: Widget) => `[${w.id}: ${w.type}]`)
      .join(' ');
    return `Current canvas state: ${items}`;
  }, [state.widgets]);

  return (
    <CanvasContext.Provider
      value={{ widgets: state.widgets, focusedId: state.focusedId, addWidget, removeWidget, updateWidget, focusWidget, resizeWidget, moveWidget, clearWidgets, getInventoryString }}
    >
      {children}
    </CanvasContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCanvas() {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within a CanvasProvider');
  return ctx;
}
