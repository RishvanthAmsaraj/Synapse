import type { ComponentType } from 'react';
import { CodeViewer } from './CodeViewer';
import { CallStack } from './CallStack';
import { ImageWidget } from './ImageWidget';
import { TextWidget } from './TextWidget';
import { TerminalWidget } from './TerminalWidget';

/**
 * Widget registry — the frontend half of the widget SDK.
 *
 * To add a new canvas widget:
 *   1. Create the component in this folder (takes `{ data }`).
 *   2. Register it here with its type + default grid span.
 *   3. Add the matching ToolSpec in backend/src/tools.ts.
 *
 * Canvas.tsx renders purely from this registry — no switch to edit.
 */

export interface WidgetDefinition {
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: ComponentType<any>;
  defaultCols: number;
  defaultRows: number;
}

export const WIDGET_REGISTRY: Record<string, WidgetDefinition> = {
  code_viewer: { type: 'code_viewer', component: CodeViewer, defaultCols: 2, defaultRows: 2 },
  call_stack: { type: 'call_stack', component: CallStack, defaultCols: 1, defaultRows: 2 },
  image: { type: 'image', component: ImageWidget, defaultCols: 1, defaultRows: 1 },
  text: { type: 'text', component: TextWidget, defaultCols: 2, defaultRows: 2 },
  terminal: { type: 'terminal', component: TerminalWidget, defaultCols: 2, defaultRows: 2 },
};

export function getWidget(type: string): WidgetDefinition | undefined {
  return WIDGET_REGISTRY[type];
}
