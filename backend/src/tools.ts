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
      {
        name: 'panel',
        type: 'string',
        description:
          'Short slug naming this panel, e.g. "v8-engine", "firing-order", "merge-code". ' +
          'Each distinct slug is its own panel on the canvas, so use a DIFFERENT slug for every ' +
          'panel you want visible at the same time. Re-using a slug replaces that panel in place. ' +
          'Lowercase, hyphenated, no spaces.',
      },
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
      { name: 'panel', type: 'string', description: 'Slug of the code panel to highlight in — the same slug you passed to code_viewer_show.' },
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
      'Several text panels can be open at once — give each one its own panel slug. ' +
      'Use for key points, step-by-step breakdowns, summaries, or any structured text that complements your speech. ' +
      'Supports **bold**, *italic*, headings, and nested lists.',
    params: [
      {
        name: 'panel',
        type: 'string',
        description:
          'Short slug naming this panel, e.g. "v8-engine", "firing-order", "merge-code". ' +
          'Each distinct slug is its own panel on the canvas, so use a DIFFERENT slug for every ' +
          'panel you want visible at the same time. Re-using a slug replaces that panel in place. ' +
          'Lowercase, hyphenated, no spaces.',
      },
      { name: 'title', type: 'string', description: 'Short heading for the panel, e.g. "How it works". Under five words.', required: false },
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
      'Several images can be shown side by side — give each one its own panel slug. ' +
      'Call this when a visual illustration would complement the explanation. ' +
      'Pass a short subject noun phrase as the query.',
    params: [
      {
        name: 'panel',
        type: 'string',
        description:
          'Short slug naming this panel, e.g. "v8-engine", "firing-order", "merge-code". ' +
          'Each distinct slug is its own panel on the canvas, so use a DIFFERENT slug for every ' +
          'panel you want visible at the same time. Re-using a slug replaces that panel in place. ' +
          'Lowercase, hyphenated, no spaces.',
      },
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

  {
    name: 'activity_log',
    widgetType: 'activity',
    description:
      'Append a step to a live activity feed — what is being done right now, which tool ran, ' +
      'which page was opened, what came back. Intended above all for external agents driving ' +
      'the canvas: reusing one panel slug builds a running log of the work rather than a pile ' +
      'of panels. Send status "running" when a step starts and send the same label again with ' +
      '"done" or "error" when it finishes.',
    params: [
      { name: 'panel', type: 'string', description: 'Slug of the activity panel. Reuse it to append to the same feed.' },
      { name: 'label', type: 'string', description: 'Short name of the step, usually the tool that ran.' },
      { name: 'detail', type: 'string', description: 'One line of detail: arguments, a result, an error.', required: false },
      { name: 'url', type: 'string', description: 'A page that was opened, shown as a link.', required: false },
      { name: 'status', type: 'string', description: 'One of "running", "done", "error". Defaults to "done".', required: false },
    ],
  },
  {
    name: 'close_panel',
    widgetType: 'canvas',
    description:
      'Close one panel by its slug, leaving the rest of the canvas untouched. ' +
      'Use this to retire a panel that is no longer relevant instead of clearing everything.',
    params: [{ name: 'panel', type: 'string', description: 'Slug of the panel to close.' }],
  },
  {
    name: 'arrange_panel',
    widgetType: 'canvas',
    description:
      'Resize a panel on the canvas grid. The stage is 12 columns wide; rows are 1-4. ' +
      'Use it to give a panel the room its content needs — a code walkthrough wants 6-8 columns ' +
      'and 3 rows, a single image is fine at 3-4 columns. The user can also drag and resize ' +
      'panels themselves, so treat the layout as shared rather than yours to enforce.',
    params: [
      { name: 'panel', type: 'string', description: 'Slug of the panel to resize.' },
      { name: 'cols', type: 'number', description: 'Column span, 2-12.' },
      { name: 'rows', type: 'number', description: 'Row span, 2-14. Eight rows is the full height of the stage.' },
    ],
  },
  {
    name: 'focus_panel',
    widgetType: 'canvas',
    description:
      'Spotlight one panel — it expands to own the stage while the others compact aside. ' +
      'Call it as you move between panels so the canvas follows what you are talking about. ' +
      'This is presentation only; it never changes what a panel contains.',
    params: [{ name: 'panel', type: 'string', description: 'Slug of the panel to bring forward.' }],
  },

  // ------------------------------------------------------------------
  // Execution Stream
  // ------------------------------------------------------------------
  {
    name: 'exec_python',
    widgetType: 'terminal',
    description:
      '[EXEC STREAM] Run a Python snippet locally and display its real output. ' +
      'The result appears in a terminal-like widget. ' +
      'Use for quick calculations, data analysis, or algorithm demonstrations. ' +
      'Execution has an 8-second limit — keep snippets short. ' +
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
