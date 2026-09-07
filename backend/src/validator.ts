/**
 * Validation layer — sits between the model and the canvas.
 * The model is treated as an untrusted external service.
 * Every tool call is checked before it touches state.
 *
 * The argument spec is DERIVED from TOOL_SPECS in tools.ts, so there is a
 * single source of truth for tool signatures — no separate hand-maintained
 * registry to drift out of sync.
 */

import { TOOL_SPECS } from './tools.js';

type ArgType = 'string' | 'number' | 'boolean' | 'object';

interface ToolSpec {
  args: Record<string, { type: ArgType; required: boolean }>;
}

const REGISTRY: Record<string, ToolSpec> = Object.fromEntries(
  TOOL_SPECS.map((spec) => [
    spec.name,
    {
      args: Object.fromEntries(
        spec.params.map((p) => [p.name, { type: p.type, required: p.required !== false }]),
      ),
    },
  ]),
);

export interface ValidatedCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ValidationError {
  reason: string;
}

/**
 * Validate a tool call against the registry.
 * Returns the validated call or an error reason.
 */
export function validate(
  name: string,
  args: Record<string, unknown>
): ValidatedCall | ValidationError {
  const spec = REGISTRY[name];

  if (!spec) {
    return { reason: `Unknown tool: "${name}"` };
  }

  for (const [key, argSpec] of Object.entries(spec.args)) {
    if (argSpec.required && !(key in args)) {
      return { reason: `Missing required argument "${key}" for tool "${name}"` };
    }
    if (key in args && typeof args[key] !== argSpec.type) {
      return {
        reason: `Argument "${key}" for tool "${name}" must be ${argSpec.type}, got ${typeof args[key]}`,
      };
    }
  }

  return { name, args };
}

export function isError(result: ValidatedCall | ValidationError): result is ValidationError {
  return 'reason' in result;
}
