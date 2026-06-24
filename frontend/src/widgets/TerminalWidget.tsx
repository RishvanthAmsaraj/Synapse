/**
 * TerminalWidget — Displays output from the exec stream (sandboxed code execution).
 *
 * Shows a terminal-like view with:
 * - Code block with syntax-highlighted input
 * - Output display (stdout / stderr)
 * - Status indicator (running / done / error)
 */

import { useRef, useEffect } from 'react';

export interface ExecBlock {
  id: string;
  code: string;
  description: string;
  output?: string;
  error?: string;
  status: 'running' | 'done' | 'error';
}

export interface TerminalWidgetData {
  blocks: ExecBlock[];
}

export interface TerminalWidgetProps {
  data: TerminalWidgetData;
}

export function TerminalWidget({ data }: TerminalWidgetProps) {
  const { blocks } = data;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [blocks.length]);

  return (
    <div className="terminal-widget">
      <div className="terminal-header">
        <span className="terminal-title">exec stream</span>
        <span className="terminal-count">{blocks.length} block{blocks.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="terminal-body">
        {blocks.length === 0 ? (
          <div className="terminal-empty">awaiting execution…</div>
        ) : (
          blocks.map((block) => (
            <div key={block.id} className="terminal-block">
              <div className="terminal-block-header">
                <span className="terminal-block-desc">{block.description}</span>
                <span className={`terminal-status terminal-status-${block.status}`}>
                  {block.status === 'running' && '⏳'}
                  {block.status === 'done' && '✅'}
                  {block.status === 'error' && '❌'}
                </span>
              </div>
              <pre className="terminal-code">{truncateCode(block.code)}</pre>
              {block.output && block.output.length > 0 && (
                <pre className="terminal-output">{block.output}</pre>
              )}
              {block.error && (
                <pre className="terminal-error">{block.error}</pre>
              )}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function truncateCode(code: string, maxLines = 10): string {
  const lines = code.split('\n');
  if (lines.length <= maxLines) return code;
  return lines.slice(0, maxLines).join('\n') + `\n// … (${lines.length - maxLines} more lines)`;
}
