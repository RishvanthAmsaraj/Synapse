import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCanvas, GRID_COLUMNS, clampCols, clampRows, type Widget } from './CanvasProvider';
import { getWidget } from '../widgets/registry';
import { gesture } from './gesture';
import './Canvas.css';

/**
 * Canvas — the stage.
 *
 * Panels sit on a 12-column grid that both parties control: the agent
 * arranges them as it explains, and the user can pick them up and move or
 * resize them at any time.
 *
 * The important thing about this file is what it does NOT do during a
 * gesture. The previous version dispatched React state on every pointermove,
 * so dragging a panel re-rendered every other panel — including re-running
 * syntax highlighting — sixty times a second, which is what made the whole
 * app stutter and eventually cost the face its WebGL context. Now a gesture
 * writes transforms straight to the DOM inside a rAF and commits exactly one
 * state update, on pointerup.
 */

/**
 * Pull the saveable text out of a panel, and pick a sensible filename.
 * Returns null for panels that are not text — an image panel has nothing
 * meaningful to write to a file from here.
 */
function exportable(w: Widget): { text: string; name: string } | null {
  const d = w.data as Record<string, unknown> | null;
  if (!d) return null;
  const slug = (typeof d.panel === 'string' && d.panel) || w.id;
  if (typeof d.content === 'string') {
    const title = typeof d.title === 'string' ? d.title : '';
    return { text: title ? `# ${title}\n\n${d.content}` : d.content, name: `${slug}.md` };
  }
  if (typeof d.code === 'string') {
    const ext: Record<string, string> = {
      python: 'py', javascript: 'js', typescript: 'ts', tsx: 'tsx', jsx: 'jsx',
      rust: 'rs', go: 'go', java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs',
      ruby: 'rb', php: 'php', sql: 'sql', bash: 'sh', shell: 'sh', html: 'html', css: 'css',
    };
    const lang = typeof d.language === 'string' ? d.language.toLowerCase() : '';
    return { text: d.code, name: `${slug}.${ext[lang] ?? 'txt'}` };
  }
  return null;
}

function savePanel(w: Widget) {
  const out = exportable(w);
  if (!out) return;
  const blob = new Blob([out.text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = out.name;
  a.click();
  // Revoke on the next tick so the click has definitely been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const GAP = 12;
const ROW_BANDS = 8;
const ROW_MIN = 60;
const ROW_MAX = 130;

/**
 * Preset footprints. Dragging is the precise tool; these are the fast one.
 */
const PRESETS: Array<{ label: string; cols: number; rows: number }> = [
  { label: 'Small',      cols: 3,  rows: 4 },
  { label: 'Square',     cols: 4,  rows: 5 },
  { label: 'Wide',       cols: 6,  rows: 4 },
  { label: 'Tall',       cols: 4,  rows: 8 },
  { label: 'Large',      cols: 6,  rows: 8 },
  { label: 'Full width', cols: 12, rows: 6 },
];

/** Panel contents never re-render because of layout. */
const PanelBody = memo(
  function PanelBody({ type, data }: { type: string; data: unknown }) {
    const def = getWidget(type);
    if (!def) {
      console.warn(`[Canvas] Unknown widget type: "${type}"`);
      return null;
    }
    const Comp = def.component;
    return <Comp data={data} />;
  },
  (a, b) => a.type === b.type && a.data === b.data,
);

export function Canvas() {
  const { widgets, focusedId, moveWidget, resizeWidget } = useCanvas();
  const gridRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef<HTMLDivElement>(null);
  const [interacting, setInteracting] = useState(false);
  const [presetFor, setPresetFor] = useState<string | null>(null);

  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;

  const cellEl = (id: string) =>
    gridRef.current?.querySelector(`[data-widget-id="${id}"]`) as HTMLElement | null;

  /** Cell geometry. Columns from the grid width, rows from --row-h, which we set. */
  const units = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return null;
    const rect = grid.getBoundingClientRect();
    const colW = (rect.width - GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS;
    const rowH = parseFloat(getComputedStyle(grid).getPropertyValue('--row-h')) || 73;
    return { rect, colW, rowH, colStep: colW + GAP, rowStep: rowH + GAP };
  }, []);

  const recomputeRowUnit = useCallback(() => {
    const grid = gridRef.current;
    const scroll = grid?.parentElement;
    if (!grid || !scroll || gesture.active) return;
    const usable = scroll.clientHeight - 14;
    const unit = (usable - GAP * (ROW_BANDS - 1)) / ROW_BANDS;
    grid.style.setProperty('--row-h', `${Math.round(Math.max(ROW_MIN, Math.min(ROW_MAX, unit)))}px`);
  }, []);

  useEffect(() => {
    recomputeRowUnit();
    const scroll = gridRef.current?.parentElement;
    if (!scroll || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => recomputeRowUnit());
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [recomputeRowUnit]);

  /**
   * FLIP.
   *
   * Grid position changes cannot be transitioned, so panels would teleport
   * whenever the layout repacked. Recording where each panel was, then
   * animating it from there to where it now is, makes the whole stage settle
   * the way home-screen widgets do — you can see what moved and why.
   */
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const nodes = grid.querySelectorAll<HTMLElement>('[data-widget-id]');
    for (const el of nodes) {
      const id = el.dataset.widgetId!;
      const next = el.getBoundingClientRect();
      const prev = prevRects.current.get(id);
      prevRects.current.set(id, next);
      // The panel under the pointer tracks it directly; animating it would
      // make it lag the finger.
      if (!prev || el.classList.contains('lifted') || el.classList.contains('resizing')) continue;
      const dx = prev.left - next.left;
      const dy = prev.top - next.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.style.transition = 'none';
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
      });
    }
  }, [widgets]);

  useEffect(() => {
    if (!presetFor) return;
    const close = (ev: PointerEvent) => {
      const el = ev.target as HTMLElement | null;
      if (!el?.closest('.cell-presets') && !el?.closest('.cell-resize')) setPresetFor(null);
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', close), 0);
    return () => { clearTimeout(t); window.removeEventListener('pointerdown', close); };
  }, [presetFor]);

  useEffect(() => {
    if (gesture.active) return;
    focusedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusedId, widgets.length]);

  // ── Drag ────────────────────────────────────────────────────────────
  const beginDrag = useCallback((e: React.PointerEvent, id: string) => {
    e.preventDefault();
    const u = units();
    const el = cellEl(id);
    if (!u || !el) return;

    const w = widgetsRef.current.find((x) => x.id === id);
    if (!w) return;

    // Where inside the panel the grab happened, so it does not snap its
    // corner to the cursor the moment you pick it up.
    const cell = el.getBoundingClientRect();
    const grabX = e.clientX - cell.left;
    const grabY = e.clientY - cell.top;

    gesture.active = true;
    setInteracting(true);
    el.classList.add('lifted');

    let lastX = w.x, lastY = w.y;

    const onMove = (ev: PointerEvent) => {
      const g = units();
      if (!g) return;
      // Target cell is read straight off the pointer. Positions are explicit
      // now, so there is nothing to infer and nothing to drift.
      const x = Math.round((ev.clientX - grabX - g.rect.left) / g.colStep);
      const y = Math.round((ev.clientY - grabY - g.rect.top) / g.rowStep);
      if (x !== lastX || y !== lastY) {
        lastX = x; lastY = y;
        // Committed live, so the other panels shuffle out of the way while
        // you are still holding it.
        moveWidget(id, x, y);
      }
    };

    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('resize', finish);
      el.classList.remove('lifted');
      el.style.transform = '';
      gesture.active = false;
      setInteracting(false);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', finish, { once: true });
    window.addEventListener('pointercancel', finish, { once: true });
    window.addEventListener('resize', finish, { once: true });
  }, [moveWidget, units]);

  // ── Resize ──────────────────────────────────────────────────────────
  const beginResize = useCallback(
    (e: React.PointerEvent, id: string, cols: number, rows: number) => {
      e.preventDefault();
      e.stopPropagation();
      const u = units();
      const el = cellEl(id);
      if (!u || !el) return;
      const w = widgetsRef.current.find((x) => x.id === id);
      if (!w) return;

      gesture.active = true;
      setInteracting(true);
      el.classList.add('resizing');

      const badge = document.createElement('span');
      badge.className = 'cell-size';
      badge.textContent = `${cols} x ${rows}`;
      el.appendChild(badge);

      let c = cols, r = rows, moved = false;

      const onMove = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - e.clientX) > 3 || Math.abs(ev.clientY - e.clientY) > 3) moved = true;
        const g = units();
        if (!g) return;
        // The panel's top-left is derived from its OWN coordinates rather
        // than measured, so nothing the browser does mid-gesture can move it.
        const left = g.rect.left + w.x * g.colStep;
        const top = g.rect.top + w.y * g.rowStep;
        const nc = clampCols(Math.round((ev.clientX - left + GAP) / g.colStep));
        const nr = clampRows(Math.round((ev.clientY - top + GAP) / g.rowStep));
        if (nc !== c || nr !== r) {
          c = nc; r = nr;
          badge.textContent = `${c} x ${r}`;
          resizeWidget(id, c, r);
        }
      };

      const finish = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('resize', finish);
        badge.remove();
        el.classList.remove('resizing');
        gesture.active = false;
        setInteracting(false);
        if (!moved) setPresetFor(id);
      };

      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
      window.addEventListener('resize', finish, { once: true });
    },
    [resizeWidget, units],
  );

  if (widgets.length === 0) {
    return (
      <div className="canvas-empty">
        <p>Canvas will appear here as the agent speaks</p>
      </div>
    );
  }

  return (
    <div className="canvas-scroll">
      <div
        ref={gridRef}
        className={`canvas-grid${interacting ? ' interacting' : ''}`}
        data-count={widgets.length}
      >
        {widgets.map((widget) => {
          const isFocused = widget.id === focusedId;
          return (
            <div
              key={widget.id}
              ref={isFocused ? focusedRef : undefined}
              data-widget-id={widget.id}
              style={{
                gridColumn: `${widget.x + 1} / span ${widget.cols}`,
                gridRow: `${widget.y + 1} / span ${widget.rows}`,
              }}
              className={
                'canvas-cell'
                + (isFocused ? ' focused' : widgets.length > 1 ? ' dimmed' : '')
              }
            >
              {exportable(widget) && (
                <button
                  type="button"
                  className="cell-save"
                  aria-label="Save panel to a file"
                  title="Save to a file"
                  onClick={() => savePanel(widget)}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <path d="M8 1v8M4.5 6.5L8 10l3.5-3.5M2 12v2h12v-2"
                      fill="none" stroke="currentColor" strokeWidth="1.6"
                      strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              )}

              <button
                type="button"
                className="cell-grip"
                aria-label="Move panel"
                onPointerDown={(e) => beginDrag(e, widget.id)}
              >
                <span /><span /><span />
              </button>

              {widget.source && <span className="cell-source">{widget.source}</span>}

              <div className="cell-body">
                <PanelBody type={widget.type} data={widget.data} />
              </div>

              {presetFor === widget.id && (
                <div className="cell-presets" role="menu">
                  {PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      role="menuitem"
                      className={
                        preset.cols === widget.cols && preset.rows === widget.rows ? 'is-current' : ''
                      }
                      onClick={() => {
                        resizeWidget(widget.id, preset.cols, preset.rows);
                        setPresetFor(null);
                      }}
                    >
                      <span className="preset-shape" style={{
                        width: 10 + preset.cols * 1.6,
                        height: 6 + preset.rows * 1.1,
                      }} />
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}

              <span
                className="cell-resize"
                role="separator"
                aria-label="Resize panel"
                onPointerDown={(e) => beginResize(e, widget.id, widget.cols, widget.rows)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
