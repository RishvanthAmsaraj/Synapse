import { useCallback, useEffect, useRef, useState } from 'react';
import { CanvasProvider, useCanvas } from './canvas/CanvasProvider';
import { Canvas } from './canvas/Canvas';
import { SPPE, type SPPEStreamEvent } from './sppe/SPPE';
import { SPPEDebugProvider, DAGVis, StreamWaterfall, FrontierDashboard, useSPPEDebug } from './sppe/SPPEDebug';

import { useLiveSession, type ToolCall } from './hooks/useLiveSession';
import { useAudioIO } from './hooks/useAudioIO';
import { useAudioPlayback } from './hooks/useAudioPlayback';
import type { CodeViewerData } from './widgets/CodeViewer';
import type { CallStackData } from './widgets/CallStack';
import type { ImageWidgetData } from './widgets/ImageWidget';
import type { TextWidgetData } from './widgets/TextWidget';
import type { TerminalWidgetData, ExecBlock } from './widgets/TerminalWidget';
import './App.css';

// Staggered highlight timing: first fires after a short pause,
// subsequent ones at fixed intervals. This makes batched tool calls
// cascade visually across the code while the agent speaks.
const HIGHLIGHT_INITIAL_DELAY = 500;   // ms before first highlight
const HIGHLIGHT_INTERVAL      = 3500;  // ms between subsequent highlights

export default function App() {
  return (
    <CanvasProvider>
      <SPPEDebugProvider>
        <AppInner />
      </SPPEDebugProvider>
    </CanvasProvider>
  );
}

function AppInner() {
  const { addWidget, removeWidget, updateWidget, clearWidgets, getInventoryString } = useCanvas();
  const { playChunk, flush, stop } = useAudioPlayback();
  const { pushEvent, pushConflict, setFrontier, events, frontiers, conflicts } = useSPPEDebug();

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

  // Exec stream refs
  const execTerminalIdRef = useRef<string | null>(null);
  const execTerminalDataRef = useRef<TerminalWidgetData>({ blocks: [] });
  const execBlockCounterRef = useRef(0);

  // ── SPPE Runtime ──────────────────────────────────────────────
  const sppeRef = useRef<SPPE | null>(null);

  useEffect(() => {
    const sppe = new SPPE({
      onSchedule: (event: SPPEStreamEvent) => {
        addLog(`sppe:stream=${event.stream} action=${event.actionId} resolved=${event.resolvedOrder}`);
        pushEvent(event);
        setFrontier(event.stream, event.resolvedOrder);
      },
      onCommit: (event: SPPEStreamEvent) => {
        addLog(`sppe:commit stream=${event.stream} action=${event.actionId}`);
        pushEvent({ ...event });
        setFrontier(event.stream, event.resolvedOrder);
      },
      onRollback: (event: SPPEStreamEvent) => {
        addLog(`sppe:ROLLBACK stream=${event.stream} action=${event.actionId}`);
        pushConflict(event.actionId, false);
      },
      onConflict: (event: SPPEStreamEvent) => {
        addLog(`sppe:CONFLICT stream=${event.stream} action=${event.actionId} → last-writer-wins`);
        pushConflict(event.actionId, true);
      },
    });
    sppeRef.current = sppe;
    return () => { sppe.dispose(); };
  }, [addLog]);

  // Cancel all pending highlight timers and reset the counter.
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

      // Route through SPPE for dependency tracking
      const sppe = sppeRef.current;
      if (sppe) {
        switch (call.name) {
          case 'code_viewer_show':
            sppe.schedule('widget', call.name, call.args, { type: 'independent' });
            break;
          case 'code_viewer_next_highlight':
            sppe.schedule('widget', call.name, call.args, {
              type: 'sequential',
              dependsOn: ['code_viewer_show'],
            });
            break;
          case 'image_show':
            sppe.schedule('widget', call.name, call.args, { type: 'independent' });
            break;
          case 'text_show':
            sppe.schedule('widget', call.name, call.args, { type: 'independent' });
            break;
          case 'call_stack_show':
          case 'call_stack_push':
          case 'call_stack_pop':
          case 'call_stack_overflow':
          case 'call_stack_remove':
            sppe.schedule('widget', call.name, call.args, { type: 'sequential', dependsOn: ['call_stack_show'] });
            break;
          case 'exec_python':
          case 'exec_clear':
            sppe.schedule('exec', call.name, call.args, { type: 'independent' });
            break;
        }
      }

      switch (call.name) {

        // ── Code Viewer ──────────────────────────────────────────────
        case 'code_viewer_show': {
          const { language, code } = call.args as { language: string; code: string };
          clearPendingHighlights();
          highlightsClearedRef.current = false;
          const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          const data: CodeViewerData = { language, code: normalizedCode };
          codeViewerDataRef.current = data;
          if (codeViewerIdRef.current) {
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

          const delay = HIGHLIGHT_INITIAL_DELAY + pendingHighlightCountRef.current * HIGHLIGHT_INTERVAL;
          pendingHighlightCountRef.current += 1;

          const timerId = setTimeout(() => {
            pendingTimersRef.current = pendingTimersRef.current.filter((t) => t !== timerId);
            if (!codeViewerIdRef.current) return;
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
          if (!url) break;
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

        // ── Exec Stream ──────────────────────────────────────────────
        case 'exec_python': {
          const { code, description } = call.args as { code: string; description: string };
          const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

          // Create or update terminal widget
          execBlockCounterRef.current += 1;
          const blockId = `exec_${execBlockCounterRef.current}`;
          const newBlock: ExecBlock = {
            id: blockId,
            code: normalizedCode,
            description,
            status: 'running',
          };

          const currentData = execTerminalDataRef.current;
          const updatedBlocks = [...currentData.blocks, newBlock];
          const data: TerminalWidgetData = { blocks: updatedBlocks };
          execTerminalDataRef.current = data;

          if (execTerminalIdRef.current) {
            updateWidget(execTerminalIdRef.current, data);
          } else {
            const id = addWidget('terminal', data, 2, 2);
            execTerminalIdRef.current = id;
          }

          // Simulate async execution — in production this calls the backend
          // For now, show the code and mark as done after a brief delay
          setTimeout(() => {
            const current = execTerminalDataRef.current;
            const updated = {
              blocks: current.blocks.map(b =>
                b.id === blockId
                  ? { ...b, status: 'done' as const, output: 'Execution simulation — sandboxed Python executor pending' }
                  : b
              ),
            };
            execTerminalDataRef.current = updated;
            if (execTerminalIdRef.current) {
              updateWidget(execTerminalIdRef.current, updated);
            }
          }, 1500);
          break;
        }

        case 'exec_clear': {
          execTerminalDataRef.current = { blocks: [] };
          execBlockCounterRef.current = 0;
          if (execTerminalIdRef.current) {
            removeWidget(execTerminalIdRef.current);
            execTerminalIdRef.current = null;
          }
          break;
        }
      }
    },
    [addWidget, removeWidget, updateWidget, addLog, addLog]
  );

  const { connect, disconnect, sendAudio, sendContext, status } = useLiveSession({
    onAudioChunk: (base64) => playChunk(base64),
    onInterrupted: () => {
      addLog('interrupted → SPPE rollback, flush audio, cancel highlights');
      flush();
      clearPendingHighlights();

      // SPPE rollback: notify runtime, revert widgets to last committed state
      const sppe = sppeRef.current;
      if (sppe) {
        sppe.handleInterrupt();
        // Check if code viewer needs rollback
        if (codeViewerIdRef.current) {
          const cleared: CodeViewerData = {
            language: codeViewerDataRef.current.language,
            code: codeViewerDataRef.current.code,
          };
          codeViewerDataRef.current = cleared;
          updateWidget(codeViewerIdRef.current, cleared);
          highlightsClearedRef.current = true;
        }
      }
    },
    onToolCall: handleToolCall,
    onTurnComplete: () => {
      const inv = inventoryRef.current();
      const sppe = sppeRef.current;
      const depInfo = sppe ? ` | sppe:${sppe.getStatus()}` : '';
      const note = highlightsClearedRef.current && codeViewerIdRef.current
        ? ' | highlights cleared — re-call code_viewer_next_highlight for each section on your next turn'
        : '';
      if (note) highlightsClearedRef.current = false;
      addLog(`turn_complete → canvas:${inv || 'empty'}${note}${depInfo}`);
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
    execTerminalIdRef.current = null;
    execTerminalDataRef.current = { blocks: [] };
    execBlockCounterRef.current = 0;
  }

  const canStart = status === 'disconnected' && !isRecording;
  const canStop = isRecording || status === 'connected';

  // Theme toggle
  const [darkMode, setDarkMode] = useState(true);
  const toggleTheme = useCallback(() => {
    const html = document.documentElement;
    const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    setDarkMode(next === 'dark');
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">S</div>
          <span>Synapse</span>
          <div className={`status-dot status-${status}`} title={status} />
        </div>
        <div className="app-toolbar">
          <button className="toolbar-btn" type="button" onClick={toggleTheme}>{darkMode ? 'Light' : 'Dark'}</button>
        </div>
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

      <DebugPanel logs={logs} events={events} frontiers={frontiers} conflicts={conflicts} />
    </div>
  );
}

function statusLabel(status: string, isRecording: boolean): string {
  if (status === 'connecting') return 'Connecting…';
  if (status === 'connected' && isRecording) return 'Listening';
  if (status === 'connected') return 'Connected';
  return 'Disconnected';
}

function DebugPanel({ logs, events, frontiers, conflicts }:
  { logs: string[]; events: SPPEStreamEvent[]; frontiers: Record<string, number>; conflicts: Array<{ actionId: string; won: boolean; timestamp: number }>; }) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'log' | 'dag' | 'waterfall' | 'frontiers'>('log');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && tab === 'log' && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs, open, tab]);

  function getLogColor(log: string): React.CSSProperties {
    const base: React.CSSProperties = { whiteSpace: 'pre-wrap', lineHeight: 1.6 };
    if (log.includes('sppe:')) {
      if (log.includes('ROLLBACK')) base.color = '#f87171';
      else if (log.includes('CONFLICT')) base.color = '#fbbf24';
      else if (log.includes('commit')) { base.color = '#34d399'; base.opacity = 0.8; }
      else base.color = '#93c5fd';
    } else if (log.includes('turn_complete')) {
      base.color = '#a78bfa';
    }
    return base;
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed', bottom: 12, right: 12, width: 480, zIndex: 9999,
    background: 'var(--color-surface, #181b22)',
    border: '1px solid var(--color-border, #2a2f3a)',
    borderRadius: 10,
    color: 'var(--color-text, #f3f4f6)',
    boxShadow: 'var(--color-shadow-lg, 0 16px 40px rgba(0,0,0,0.5))',
    fontFamily: "'SF Mono', 'Menlo', 'Consolas', monospace",
    fontSize: 11,
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: open ? '1px solid var(--color-border, #2a2f3a)' : 'none',
        cursor: 'pointer', userSelect: 'none',
        color: 'var(--color-text-muted, #9ca3af)',
        fontWeight: 600,
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }} onClick={() => setOpen(o => !o)}>
        <span>{tab === 'log' ? `log (${logs.length})` : `sppe | ${tab}`}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {conflicts.length > 0 && (
            <span style={{ color: '#fbbf24' }}>⚡{conflicts.length}</span>
          )}
          <span>{open ? '▼' : '▲'}</span>
        </div>
      </div>

      {/* Tabs */}
      {open && (
        <div style={{
          display: 'flex', gap: 2, padding: '4px 8px',
          borderBottom: '1px solid var(--color-border, #2a2f3a)',
          background: 'var(--color-surface-2, #1f232b)',
        }} onClick={e => e.stopPropagation()}>
          {(['log', 'dag', 'waterfall', 'frontiers'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                fontSize: 10, padding: '3px 10px',
                border: tab === t ? '1px solid var(--color-accent, #ff6200)' : '1px solid transparent',
                borderRadius: 6,
                background: tab === t ? 'var(--color-accent-soft, rgba(255,98,0,0.12))' : 'transparent',
                color: tab === t ? 'var(--color-accent, #ff6200)' : 'var(--color-text-muted, #9ca3af)',
                cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600,
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}
            >{t}</button>
          ))}
        </div>
      )}

      {/* Content */}
      {open && (
        <div style={{ maxHeight: 280, overflowY: 'auto', padding: '4px 10px' }}
          ref={tab === 'log' ? bodyRef : undefined}>
          {tab === 'log' && (
            logs.length === 0
              ? <div style={{ color: 'var(--color-text-muted, #9ca3af)', opacity: 0.5 }}>no events yet</div>
              : logs.map((log, i) => (
                  <div key={i} style={getLogColor(log)}>{log}</div>
                ))
          )}
          {tab === 'dag' && <DAGVis events={events} />}
          {tab === 'waterfall' && <StreamWaterfall events={events} />}
          {tab === 'frontiers' && <FrontierDashboard frontiers={frontiers} />}
        </div>
      )}
    </div>
  );
}
