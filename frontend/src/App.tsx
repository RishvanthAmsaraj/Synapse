import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasProvider, useCanvas } from './canvas/CanvasProvider';
import { Canvas } from './canvas/Canvas';
import { useLiveSession, type ToolCall } from './hooks/useLiveSession';
import { useAudioIO } from './hooks/useAudioIO';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import type { CodeViewerData } from './widgets/CodeViewer';
import type { CallStackData } from './widgets/CallStack';
import type { ImageWidgetData } from './widgets/ImageWidget';
import type { TextWidgetData } from './widgets/TextWidget';
import './App.css';

// Staggered highlight timing: first fires after a short pause,
// subsequent ones at fixed intervals. This makes batched tool calls
// cascade visually across the code while the agent speaks.
const HIGHLIGHT_INITIAL_DELAY = 500;   // ms before first highlight
const HIGHLIGHT_INTERVAL      = 3500;  // ms between subsequent highlights

export default function App() {
  return (
    <CanvasProvider>
      <AppInner />
    </CanvasProvider>
  );
}

function AppInner() {
  const { addWidget, removeWidget, updateWidget, clearWidgets, getInventoryString } = useCanvas();
  const { playChunk, flush, stop } = useAudioPlayback();

  // Debug log panel
  const [logs, setLogs] = useState<string[]>([]);
  const addLog = useCallback((entry: string) => {
    const ts = new Date().toTimeString().slice(0, 8);
    setLogs(prev => [...prev.slice(-149), `[${ts}] ${entry}`]);
  }, []);

  // Track the active code viewer widget so highlight can update it
  const codeViewerIdRef   = useRef<string | null>(null);
  const codeViewerDataRef = useRef<CodeViewerData>({ language: '', code: '' });

  // Staggered highlight state
  const pendingTimersRef        = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pendingHighlightCountRef = useRef(0);
  // Set true when interrupt clears highlights — injected into canvas state so model re-issues them
  const highlightsClearedRef = useRef(false);

  // Always-current canvas inventory for turn_complete injection
  const inventoryRef = useRef(getInventoryString);
  useEffect(() => { inventoryRef.current = getInventoryString; }, [getInventoryString]);

  // Track the active image widget ID so we replace rather than stack
  const imageWidgetIdRef = useRef<string | null>(null);

  // Track the active call stack widget ID so push/pop/overflow can mutate it
  const callStackIdRef   = useRef<string | null>(null);
  const callStackDataRef = useRef<CallStackData>({ frames: [], overflow: false });
  const frameCounterRef  = useRef(0);

  // Cancel all pending highlight timers and reset the counter.
  // Called on new code_viewer_show, interrupt, and stop.
  function clearPendingHighlights() {
    for (const t of pendingTimersRef.current) clearTimeout(t);
    pendingTimersRef.current = [];
    pendingHighlightCountRef.current = 0;
  }

  const handleToolCall = useCallback(
    (call: ToolCall) => {
      addLog(`tool:${call.name} ${JSON.stringify(call.name === 'code_viewer_show'
        ? { language: (call.args as {language:string}).language, code: String((call.args as {code:string}).code).slice(0,40).replace(/\n/g,'↵') + '…' }
        : call.args
      )}`);

      switch (call.name) {

        // ── Code Viewer ──────────────────────────────────────────────
        case 'code_viewer_show': {
          const { language, code } = call.args as { language: string; code: string };
          clearPendingHighlights();
          highlightsClearedRef.current = false;
          // Normalize literal escape sequences the model sometimes sends instead of real characters
          const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          const data: CodeViewerData = { language, code: normalizedCode };
          codeViewerDataRef.current = data;
          if (codeViewerIdRef.current) {
            // Replace existing code viewer in place — don't create a second widget
            updateWidget(codeViewerIdRef.current, data);
          } else {
            const id = addWidget('code_viewer', data, 2, 2);
            codeViewerIdRef.current = id;
          }
          break;
        }

        case 'code_viewer_next_highlight': {
          if (!codeViewerIdRef.current) break;
          const { start_line, end_line } = call.args as { start_line: number; end_line: number };
          if (!start_line || !end_line || start_line <= 0 || end_line <= 0) break;
          highlightsClearedRef.current = false;

          // Schedule this highlight with increasing delay so batched calls
          // cascade one-at-a-time while the agent speaks.
          const delay = HIGHLIGHT_INITIAL_DELAY + pendingHighlightCountRef.current * HIGHLIGHT_INTERVAL;
          pendingHighlightCountRef.current += 1;

          const timerId = setTimeout(() => {
            // Remove this timer from the list
            pendingTimersRef.current = pendingTimersRef.current.filter((t) => t !== timerId);
            if (!codeViewerIdRef.current) return; // widget was cleared (e.g. interrupt)
            const updated: CodeViewerData = {
              ...codeViewerDataRef.current,
              highlight: { start: start_line, end: end_line },
            };
            codeViewerDataRef.current = updated;
            updateWidget(codeViewerIdRef.current, updated);
          }, delay);

          pendingTimersRef.current.push(timerId);
          break;
        }

        // ── Image ────────────────────────────────────────────────────
        case 'image_show': {
          const { query, url } = call.args as { query: string; url: string | null };
          if (!url) break; // backend fetch failed — skip widget silently
          const data: ImageWidgetData = { query, url };
          if (imageWidgetIdRef.current) {
            updateWidget(imageWidgetIdRef.current, data);
          } else {
            const id = addWidget('image', data, 1, 1);
            imageWidgetIdRef.current = id;
          }
          break;
        }

        // ── Text ─────────────────────────────────────────────────────
        case 'text_show': {
          const { content } = call.args as { content: string };
          const data: TextWidgetData = { content };
          addWidget('text', data, 2, 2);
          break;
        }

        // ── Call Stack ───────────────────────────────────────────────
        case 'call_stack_show': {
          const initial: CallStackData = { frames: [], overflow: false };
          callStackDataRef.current = initial;
          const id = addWidget('call_stack', initial, 1, 2);
          callStackIdRef.current = id;
          break;
        }

        case 'call_stack_push': {
          if (!callStackIdRef.current) break;
          const { function_name, args: frameArgs } = call.args as {
            function_name: string;
            args: string;
          };
          const newFrame = {
            id: `frame_${frameCounterRef.current++}`,
            function_name,
            args: frameArgs,
          };
          const next: CallStackData = {
            frames: [...callStackDataRef.current.frames, newFrame],
            overflow: callStackDataRef.current.overflow,
          };
          callStackDataRef.current = next;
          updateWidget(callStackIdRef.current, next);
          break;
        }

        case 'call_stack_pop': {
          if (!callStackIdRef.current) break;
          const popped: CallStackData = {
            frames: callStackDataRef.current.frames.slice(0, -1),
            overflow: false,
          };
          callStackDataRef.current = popped;
          updateWidget(callStackIdRef.current, popped);
          break;
        }

        case 'call_stack_overflow': {
          if (!callStackIdRef.current) break;
          const overflowed: CallStackData = {
            frames: callStackDataRef.current.frames,
            overflow: true,
          };
          callStackDataRef.current = overflowed;
          updateWidget(callStackIdRef.current, overflowed);
          break;
        }

        case 'call_stack_remove': {
          if (!callStackIdRef.current) break;
          removeWidget(callStackIdRef.current);
          callStackIdRef.current = null;
          callStackDataRef.current = { frames: [], overflow: false };
          break;
        }
      }
    },
    [addWidget, removeWidget, updateWidget, addLog]
  );

  const { connect, disconnect, sendAudio, sendContext, status } = useLiveSession({
    onAudioChunk: (base64) => playChunk(base64),
    onInterrupted: () => {
      addLog('interrupted → flush audio, cancel highlights (canvas kept)');
      flush();
      clearPendingHighlights();
      // Clear the active highlight band so stale highlights don't linger after a barge-in
      if (codeViewerIdRef.current) {
        const cleared: CodeViewerData = { language: codeViewerDataRef.current.language, code: codeViewerDataRef.current.code };
        codeViewerDataRef.current = cleared;
        updateWidget(codeViewerIdRef.current, cleared);
        // Signal to the model (via next turn_complete injection) that it must re-issue highlights
        highlightsClearedRef.current = true;
      }
    },
    onToolCall: handleToolCall,
    onTurnComplete: () => {
      const inv = inventoryRef.current();
      // Fire the highlights-cleared note once, then reset — no need to repeat every turn
      const note = highlightsClearedRef.current && codeViewerIdRef.current
        ? ' | highlights cleared — re-call code_viewer_next_highlight for each section on your next turn'
        : '';
      if (note) highlightsClearedRef.current = false;
      addLog(`turn_complete → canvas:${inv || 'empty'}${note}`);
      sendContext(`[canvas: ${inv}${note}]`);
    },
  });

  const { start: startMic, stop: stopMic, isRecording } = useAudioIO(
    useCallback((chunk: string) => sendAudio(chunk), [sendAudio])
  );

  // Log session status changes
  const prevStatusRef = useRef(status);
  useEffect(() => {
    if (status !== prevStatusRef.current) {
      addLog(`session:${status}`);
      prevStatusRef.current = status;
    }
  }, [status, addLog]);

  async function handleStart() {
    try {
      await connect();
      await startMic();
    } catch (err) {
      console.error('Failed to start session:', err);
    }
  }

  function handleStop() {
    stopMic();
    disconnect();
    stop();
    clearWidgets();
    clearPendingHighlights();
    highlightsClearedRef.current = false;
    codeViewerIdRef.current = null;
    codeViewerDataRef.current = { language: '', code: '' };
    imageWidgetIdRef.current = null;
    callStackIdRef.current = null;
    callStackDataRef.current = { frames: [], overflow: false };
    frameCounterRef.current = 0;
  }

  const canStart = status === 'disconnected' && !isRecording;
  const canStop = isRecording || status === 'connected';

  return (
    <div className="app">
      <header className="app-header">
        <h1>Synapse</h1>
        <div className={`status-dot status-${status}`} title={status} />
      </header>

      <main className="app-main">
        <div className="controls-bar">
          <p className="status-label">{statusLabel(status, isRecording)}</p>
          <div className="controls">
            <button onClick={handleStart} disabled={!canStart} className="btn btn-start">
              Start
            </button>
            <button onClick={handleStop} disabled={!canStop} className="btn btn-stop">
              Stop
            </button>
          </div>
        </div>

        <Canvas />
      </main>

      <LogPanel logs={logs} />
    </div>
  );
}

function statusLabel(status: string, isRecording: boolean): string {
  if (status === 'connecting') return 'Connecting…';
  if (status === 'connected' && isRecording) return 'Listening';
  if (status === 'connected') return 'Connected';
  return 'Disconnected';
}

function LogPanel({ logs }: { logs: string[] }) {
  const [open, setOpen] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open]);

  return (
    <div style={{
      position: 'fixed', bottom: 12, right: 12, width: 420, zIndex: 9999,
      background: '#0d0d0d', border: '1px solid #333', borderRadius: 6,
      fontFamily: 'monospace', fontSize: 11, color: '#a0ffa0',
      boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '4px 8px', borderBottom: open ? '1px solid #333' : 'none',
        cursor: 'pointer', userSelect: 'none', color: '#888',
      }} onClick={() => setOpen(o => !o)}>
        <span>debug log ({logs.length})</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(logs.join('\n')); }}
            style={{ fontSize: 10, background: '#222', color: '#ccc', border: '1px solid #444', cursor: 'pointer', borderRadius: 3, padding: '1px 6px' }}
          >copy</button>
          <span>{open ? '▼' : '▲'}</span>
        </div>
      </div>
      {open && (
        <div ref={bodyRef} style={{ maxHeight: 200, overflowY: 'auto', padding: '4px 8px' }}>
          {logs.length === 0
            ? <div style={{ color: '#555' }}>no events yet</div>
            : logs.map((l, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{l}</div>)
          }
        </div>
      )}
    </div>
  );
}
