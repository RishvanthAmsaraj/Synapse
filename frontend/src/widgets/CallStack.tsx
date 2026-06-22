import { useEffect, useRef } from 'react';
import './CallStack.css';

export interface CallStackFrame {
  id: string;
  function_name: string;
  args: string;
}

export interface CallStackData {
  frames: CallStackFrame[];
  overflow: boolean;
}

/**
 * CallStack — Visualizes function call stack for algorithm walkthroughs.
 * 
 * Used by the agent to show recursion, function calls, and stack overflow
 * scenarios during code explanations.
 */
export function CallStack({ data }: { data: CallStackData }) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom (top of stack) whenever frames change
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data.frames.length]);

  return (
    <div className={`call-stack ${data.overflow ? 'call-stack--overflow' : ''}`}>
      <div className="call-stack-header">
        <span className="call-stack-title">Call Stack</span>
        {data.overflow && (
          <span className="call-stack-overflow-badge">STACK OVERFLOW</span>
        )}
      </div>

      <div className="call-stack-frames" ref={listRef}>
        {data.frames.length === 0 ? (
          <p className="call-stack-empty">No frames</p>
        ) : (
          [...data.frames].reverse().map((frame, i) => (
            <div
              key={frame.id}
              className={`call-stack-frame ${i === 0 ? 'call-stack-frame--active' : ''}`}
              style={{ animationDelay: `${i * 20}ms` }}
            >
              <span className="frame-name">{frame.function_name}</span>
              {frame.args && (
                <span className="frame-args">{frame.args}</span>
              )}
            </div>
          ))
        )}

        {data.overflow && (
          <div className="call-stack-frame call-stack-frame--phantom" />
        )}
      </div>
    </div>
  );
}
