import { Type, Behavior, type FunctionDeclaration } from '@google/genai';

/**
 * All canvas tool declarations sent to Gemini at session setup.
 * All tools are NON_BLOCKING — model does not pause speech while waiting for responses.
 * 
 * To add a new widget:
 * 1. Create the React component in frontend/src/widgets/
 * 2. Add the tool declaration here
 * 3. Add validation in validator.ts
 * 4. Register in Canvas.tsx renderWidget()
 */

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  // ------------------------------------------------------------------
  // Code Viewer
  // ------------------------------------------------------------------
  {
    name: 'code_viewer_show',
    description:
      'Display a code snippet on the visual canvas. ' +
      'You MUST call this every time you reference or show specific code — no exceptions. ' +
      'This applies even after an interruption. Call it without announcing it.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        language: {
          type: Type.STRING,
          description: 'Programming language for syntax highlighting, e.g. "python", "javascript".',
        },
        code: {
          type: Type.STRING,
          description: 'The full code snippet to display.',
        },
      },
      required: ['language', 'code'],
    },
  },

  {
    name: 'code_viewer_next_highlight',
    description:
      'Highlight a range of lines in the current code block. ' +
      'Call this once for each section of code you plan to explain, in the order you will explain them. ' +
      'Provide the exact line numbers for that section. ' +
      'The canvas handles visual timing automatically — just call them in the correct order.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_line: {
          type: Type.NUMBER,
          description: 'First line of the section to highlight (1-indexed).',
        },
        end_line: {
          type: Type.NUMBER,
          description: 'Last line of the section to highlight (1-indexed, inclusive).',
        },
      },
      required: ['start_line', 'end_line'],
    },
  },

  // ------------------------------------------------------------------
  // Text
  // ------------------------------------------------------------------
  {
    name: 'text_show',
    description:
      'Display a markdown text block on the visual canvas. ' +
      'Use for key points, step-by-step breakdowns, summaries, or any structured text that complements your speech. ' +
      'Supports **bold**, *italic*, headings, and nested lists.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        content: {
          type: Type.STRING,
          description: 'Markdown-formatted text. Use **bold** for emphasis, ## for headings, - for lists.',
        },
      },
      required: ['content'],
    },
  },

  // ------------------------------------------------------------------
  // Image
  // ------------------------------------------------------------------
  {
    name: 'image_show',
    description:
      'Search for a relevant image or diagram and display it on the visual canvas. ' +
      'Call this when a visual illustration would complement the explanation. ' +
      'Pass a concise, descriptive search query.',
    behavior: Behavior.NON_BLOCKING,
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Search query for the image, e.g. "merge sort diagram", "binary tree visualization".',
        },
      },
      required: ['query'],
    },
  },

  // ------------------------------------------------------------------
  // Call Stack — BOXED (disabled, component preserved)
  // ------------------------------------------------------------------
];
