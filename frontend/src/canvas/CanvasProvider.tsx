import { createContext, useContext, useReducer, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Widget {
  id: string;
  type: string;
  data: unknown;
  cols: number; // grid column span (1–3)
  rows: number; // grid row span (1–2)
}

type Action =
  | { type: 'ADD'; widget: Widget }
  | { type: 'REMOVE'; id: string }
  | { type: 'UPDATE'; id: string; data: unknown }
  | { type: 'CLEAR' };

interface CanvasState {
  widgets: Widget[];
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: CanvasState, action: Action): CanvasState {
  switch (action.type) {
    case 'ADD':
      return { widgets: [...state.widgets, action.widget] };
    case 'REMOVE':
      return { widgets: state.widgets.filter((w) => w.id !== action.id) };
    case 'UPDATE':
      return {
        widgets: state.widgets.map((w) =>
          w.id === action.id ? { ...w, data: action.data } : w
        ),
      };
    case 'CLEAR':
      return { widgets: [] };
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface CanvasContextValue {
  widgets: Widget[];
  addWidget: (widgetType: string, data: unknown, cols?: number, rows?: number) => string;
  removeWidget: (id: string) => void;
  updateWidget: (id: string, data: unknown) => void;
  clearWidgets: () => void;
  getInventoryString: () => string;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function CanvasProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, { widgets: [] });
  // Use a ref for the ID counter — synchronous, no stale closure issues
  const counterRef = useRef(1);

  const addWidget = useCallback(
    (widgetType: string, data: unknown, cols = 2, rows = 2): string => {
      const id = `widget_${counterRef.current++}`;
      dispatch({ type: 'ADD', widget: { id, type: widgetType, data, cols, rows } });
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

  const getInventoryString = useCallback(() => {
    if (state.widgets.length === 0) return 'The canvas is currently empty.';
    const items = state.widgets
      .map((w) => `[${w.id}: ${w.type}]`)
      .join(' ');
    return `Current canvas state: ${items}`;
  }, [state.widgets]);

  return (
    <CanvasContext.Provider
      value={{ widgets: state.widgets, addWidget, removeWidget, updateWidget, clearWidgets, getInventoryString }}
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
