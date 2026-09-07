import { Type, Behavior, type FunctionDeclaration } from '@google/genai';

/**
 * Widget SDK — the single source of truth for every canvas tool.
 *
 * To add a new widget you now touch exactly THREE places:
 *   1. Add a ToolSpec below (name, widgetType, description, params).
 *   2. Create the React component in frontend/src/widgets/.
 *   3. Register it in frontend/src/widgets/registry.ts.
 *
 * The Gemini tool declarations AND the validator spec are both GENERATED
 * from these specs — no more hand-maintaining three parallel lists.
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'object';

export interface ToolParam {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean; // default true
}

export interface ToolSpec {
  name: string;          // the tool function the model calls
  widgetType: string;    // the canvas widget this tool drives
  description: string;   // prompt to the model
  params: ToolParam[];   // [] for no-argument tools
}

const GEMINI_TYPE: Record<ParamType, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
  object: Type.OBJECT,
};

export const TOOL_SPECS: ToolSpec[] = [
  // ------------------------------------------------------------------
  // Code Viewer
  // ------------------------------------------------------------------
  {
    name: 'code_viewer_show',
    widgetType: 'code_viewer',
    description:
      'Display a code snippet on the visual canvas. ' +
      'You MUST call this every time you reference or show specific code — no exceptions. ' +
      'This applies even after an interruption. Call it without announcing it.',
    params: [
      { name: 'language', type: 'string', description: 'Programming language for syntax highlighting, e.g. "python", "javascript".' },
      { name: 'code', type: 'string', description: 'The full code snippet to display.' },
    ],
  },
  {
    name: 'code_viewer_next_highlight',
    widgetType: 'code_viewer',
    description:
      'Highlight a range of lines in the current code block. ' +
      'Call this once for each section of code you plan to explain, in the order you will explain them. ' +
      'Provide the exact line numbers for that section. ' +
      'The canvas handles visual timing automatically — just call them in the correct order.',
    params: [
      { name: 'start_line', type: 'number', description: 'First line of the section to highlight (1-indexed).' },
      { name: 'end_line', type: 'number', description: 'Last line of the section to highlight (1-indexed, inclusive).' },
    ],
  },

  // ------------------------------------------------------------------
  // Text
  // ------------------------------------------------------------------
  {
    name: 'text_show',
    widgetType: 'text',
    description:
      'Display a markdown text block on the visual canvas. ' +
      'Use for key points, step-by-step breakdowns, summaries, or any structured text that complements your speech. ' +
      'Supports **bold**, *italic*, headings, and nested lists.',
    params: [
      { name: 'content', type: 'string', description: 'Markdown-formatted text. Use **bold** for emphasis, ## for headings, - for lists.' },
    ],
  },

  // ------------------------------------------------------------------
  // Image
  // ------------------------------------------------------------------
  {
    name: 'image_show',
    widgetType: 'image',
    description:
      'Search for a relevant image or diagram and display it on the visual canvas. ' +
      'Call this when a visual illustration would complement the explanation. ' +
      'Pass a short subject noun phrase as the query.',
    params: [
      {
        name: 'query',
        type: 'string',
        description: 'Search query — a short subject noun phrase, e.g. "merge sort", "binary tree", "water cycle". Do not include filler like "a picture of".',
      },
    ],
  },

  // ------------------------------------------------------------------
  // Canvas management
  // ------------------------------------------------------------------
  {
    name: 'clear_canvas',
    widgetType: 'canvas',
    description:
      'Clear every widget from the visual canvas, returning it to the empty state with just the voice orb. ' +
      'Call this whenever the user switches topic, asks you to clear the screen, or when the ' +
      'currently displayed widgets are no longer relevant to the conversation. ' +
      'Fresh widgets for the new topic should be brought up afterwards if the new topic needs them.',
    params: [],
  },

  // ------------------------------------------------------------------
  // Execution Stream
  // ------------------------------------------------------------------
  {
    name: 'exec_python',
    widgetType: 'terminal',
    description:
      '[EXEC STREAM — Sandboxed] Run a Python snippet and display the output. ' +
      'The execution runs in a sandboxed environment separate from speech ' +
      'and canvas updates. The result appears in a terminal-like widget. ' +
      'Use for quick calculations, data analysis, or algorithm demonstrations. ' +
      'Works concurrently with speech — you can narrate while code executes.',
    params: [
      { name: 'code', type: 'string', description: 'Python code to execute. Keep it short and focused — this is for real-time demos.' },
      { name: 'description', type: 'string', description: 'Brief label for the execution block shown in the terminal widget.' },
    ],
  },
  {
    name: 'exec_clear',
    widgetType: 'terminal',
    description: '[EXEC STREAM] Clear the terminal output widget.',
    params: [],
  },
];

/**
 * Gemini function declarations, generated from TOOL_SPECS. All tools are
 * NON_BLOCKING — the model keeps speaking while widgets update.
 */
export const TOOL_DECLARATIONS: FunctionDeclaration[] = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  behavior: Behavior.NON_BLOCKING,
  parameters: {
    type: Type.OBJECT,
    properties: Object.fromEntries(
      spec.params.map((p) => [p.name, { type: GEMINI_TYPE[p.type], description: p.description }]),
    ),
    required: spec.params.filter((p) => p.required !== false).map((p) => p.name),
  },
}));
