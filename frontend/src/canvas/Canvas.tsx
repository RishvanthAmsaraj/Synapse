import { useEffect, useRef } from 'react';
import { useCanvas } from './CanvasProvider';
import { CodeViewer, type CodeViewerData } from '../widgets/CodeViewer';
import { CallStack, type CallStackData } from '../widgets/CallStack';
import { ImageWidget, type ImageWidgetData } from '../widgets/ImageWidget';
import { TextWidget, type TextWidgetData } from '../widgets/TextWidget';
import { TerminalWidget, type TerminalWidgetData } from '../widgets/TerminalWidget';
import './Canvas.css';

/**
 * Canvas — The visual stage where all widgets are rendered.
 * 
 * Widgets are laid out in a responsive grid. Each widget specifies
 * its column/row span via the cols/rows properties.
 * 
 * To add a new widget type:
 * 1. Create the component in ../widgets/
 * 2. Add its data type export
 * 3. Register it in renderWidget() below
 * 4. Add the tool declaration in backend/src/tools.ts
 */

export function Canvas() {
  const { widgets } = useCanvas();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom whenever a new widget is added
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [widgets.length]);

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
        {widgets.map((widget) => (
          <div
            key={widget.id}
            className="canvas-cell"
            style={{
              gridColumn: `span ${widget.cols}`,
              gridRow: `span ${widget.rows}`,
            }}
          >
            {renderWidget(widget.type, widget.data)}
          </div>
        ))}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}

/**
 * Widget renderer — maps widget types to their components.
 * Add new widget types here.
 */
function renderWidget(type: string, data: unknown) {
  switch (type) {
    case 'code_viewer':
      return <CodeViewer data={data as CodeViewerData} />;
    case 'call_stack':
      return <CallStack data={data as CallStackData} />;
    case 'image':
      return <ImageWidget data={data as ImageWidgetData} />;
    case 'text':
      return <TextWidget data={data as TextWidgetData} />;
    case 'terminal':
      return <TerminalWidget data={data as TerminalWidgetData} />;
    default:
      console.warn(`[Canvas] Unknown widget type: "${type}"`);
      return null;
  }
}
