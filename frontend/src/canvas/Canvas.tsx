import { useEffect, useRef } from 'react';
import { useCanvas } from './CanvasProvider';
import { getWidget } from '../widgets/registry';
import './Canvas.css';

/**
 * Canvas — The visual stage where all widgets are rendered.
 *
 * Widgets are laid out in a responsive grid. Each widget specifies
 * its column/row span via the cols/rows properties.
 *
 * Rendering is driven by the widget registry (../widgets/registry.ts) —
 * add a component + a registry entry, and it renders here with no switch to edit.
 */

export function Canvas() {
  const { widgets, focusedId } = useCanvas();
  const focusedRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to keep the focused widget front and center; when nothing is
  // focused yet, fall back to the newest widget (horizontal filmstrip).
  useEffect(() => {
    focusedRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [focusedId, widgets.length]);

  if (widgets.length === 0) {
    return (
      <div className="canvas-empty">
        <p>Canvas will appear here as the agent speaks</p>
      </div>
    );
  }

  return (
    <div className="canvas-scroll">
      <div className="canvas-grid">
        {widgets.map((widget) => {
          const isFocused = widget.id === focusedId;
          return (
            <div
              key={widget.id}
              ref={isFocused ? focusedRef : undefined}
              className={`canvas-cell${isFocused ? ' focused' : widgets.length > 1 ? ' dimmed' : ''}${widget.cols >= 2 ? ' wide' : ''}`}
            >
              {renderWidget(widget.type, widget.data)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Widget renderer — looks up the component in the registry and renders it.
 */
function renderWidget(type: string, data: unknown) {
  const def = getWidget(type);
  if (!def) {
    console.warn(`[Canvas] Unknown widget type: "${type}"`);
    return null;
  }
  const Comp = def.component;
  return <Comp data={data} />;
}
