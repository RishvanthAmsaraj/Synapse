import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
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
  const { addWidget, removeWidget, updateWidget, focusWidget, clearWidgets, getInventoryString, widgets } = useCanvas();
  // Live audio level (mic + TTS playback) — drives the orb's pulse.
  const audioPeakRef = useRef<number>(0);

  const { playChunk, flush, stop } = useAudioPlayback(
    useCallback((level: number) => {
      audioPeakRef.current = Math.max(audioPeakRef.current, level);
    }, [])
  );
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

  // Track the active text widget ID so we replace rather than stack
  const textWidgetIdRef = useRef<string | null>(null);

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
          if (codeViewerIdRef.current) focusWidget(codeViewerIdRef.current);
          break;
        }

        case 'code_viewer_next_highlight': {
          if (!codeViewerIdRef.current) break;
          focusWidget(codeViewerIdRef.current);
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
          const { query, urls } = call.args as { query: string; urls: string[] };
          // Always reflect the latest request — even a failed lookup gets
          // shown as a "not found" tile so the user never stares at a stale
          // picture the agent claims to have replaced.
          const data: ImageWidgetData = { query, urls: urls ?? [] };
          if (imageWidgetIdRef.current) {
            updateWidget(imageWidgetIdRef.current, data);
          } else {
            const id = addWidget('image', data, 1, 1);
            imageWidgetIdRef.current = id;
          }
          if (imageWidgetIdRef.current) focusWidget(imageWidgetIdRef.current);
          break;
        }

        // ── Text ─────────────────────────────────────────────────────
        case 'text_show': {
          const { content } = call.args as { content: string };
          const data: TextWidgetData = { content };
          // Replace in place: one text panel that always shows the latest
          // key points — the canvas never accumulates stale text tiles.
          if (textWidgetIdRef.current) {
            updateWidget(textWidgetIdRef.current, data);
          } else {
            const id = addWidget('text', data, 2, 2);
            textWidgetIdRef.current = id;
          }
          if (textWidgetIdRef.current) focusWidget(textWidgetIdRef.current);
          break;
        }

        // ── Call Stack ───────────────────────────────────────────────
        case 'call_stack_show': {
          const initial: CallStackData = { frames: [], overflow: false };
          callStackDataRef.current = initial;
          const id = addWidget('call_stack', initial, 1, 2);
          callStackIdRef.current = id;
          focusWidget(id);
          break;
        }

        case 'call_stack_push': {
          if (!callStackIdRef.current) break;
          focusWidget(callStackIdRef.current);
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
          const { code, description, status, output, error } = call.args as {
            code: string;
            description: string;
            status: 'done' | 'error';
            output?: string;
            error?: string;
          };
          const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');

          // Real execution happened on the backend — show its actual result.
          execBlockCounterRef.current += 1;
          const blockId = `exec_${execBlockCounterRef.current}`;
          const newBlock: ExecBlock = {
            id: blockId,
            code: normalizedCode,
            description,
            status,
            output,
            error,
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
            focusWidget(id);
          }
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

        // ── Canvas management ────────────────────────────────────────
        case 'clear_canvas': {
          clearPendingHighlights();
          clearWidgets();
          codeViewerIdRef.current = null;
          codeViewerDataRef.current = { language: '', code: '' };
          textWidgetIdRef.current = null;
          imageWidgetIdRef.current = null;
          callStackIdRef.current = null;
          callStackDataRef.current = { frames: [], overflow: false };
          frameCounterRef.current = 0;
          execTerminalIdRef.current = null;
          execTerminalDataRef.current = { blocks: [] };
          execBlockCounterRef.current = 0;
          break;
        }
      }
    },
    [addWidget, removeWidget, updateWidget, focusWidget, clearWidgets, addLog]
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
    useCallback((chunk: string) => sendAudio(chunk), [sendAudio]),
    useCallback((level: number) => {
      audioPeakRef.current = Math.max(audioPeakRef.current, level);
    }, [])
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
    clearCanvasNow();
  }

  function clearCanvasNow() {
    clearWidgets();
    clearPendingHighlights();
    highlightsClearedRef.current = false;
    codeViewerIdRef.current = null;
    codeViewerDataRef.current = { language: '', code: '' };
    textWidgetIdRef.current = null;
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

  const hasWidgets = widgets.length > 0;
  const statusEl = (
    <p className="hero-status">
      <span className={`live-dot live-${status}${isRecording && status === 'connected' ? ' live-recording' : ''}`} />
      {statusLabel(status, isRecording)}
    </p>
  );
  const sessionControls = (
    <>
      <button onClick={handleStart} disabled={!canStart} className="btn btn-start">Start session</button>
      <button onClick={handleStop} disabled={!canStop} className="btn btn-stop">Stop</button>
    </>
  );

  return (
    <div className="app">
      <div className="aurora" aria-hidden="true" />

      <header className="app-header">
        <span className="brand-name">Synapse</span>
        <div className="app-toolbar">
          <button className="toolbar-btn" type="button" onClick={toggleTheme}>{darkMode ? 'Light' : 'Dark'}</button>
        </div>
      </header>

      <main className={`app-main${hasWidgets ? ' has-widgets' : ''}`}>
        {!hasWidgets ? (
          <>
            <section className="hero">
              <Orb status={status} listening={isRecording} peakRef={audioPeakRef} />
              {statusEl}
            </section>
            <div className="controls-bar">{sessionControls}</div>
          </>
        ) : (
          <>
            <Canvas />
            <div className="session-bar">
              <div className="session-voice">
                <Orb status={status} listening={isRecording} mini peakRef={audioPeakRef} />
                {statusEl}
              </div>
              <div className="session-controls">
                <button className="btn btn-clear" onClick={clearCanvasNow} disabled={!hasWidgets}>Clear canvas</button>
                {sessionControls}
              </div>
            </div>
          </>
        )}
      </main>

      <DebugPanel logs={logs} events={events} frontiers={frontiers} conflicts={conflicts} />
    </div>
  );
}

/** The luminous voice orb — the speech stream made visible. Reacts to live
 *  audio level (mic + TTS playback) via the shared peak ref. */
function Orb({ status, listening, mini = false, peakRef }: {
  status: string; listening: boolean; mini?: boolean; peakRef: MutableRefObject<number>;
}) {
  const coreRef = useRef<HTMLDivElement>(null);
  const auraRef = useRef<HTMLDivElement>(null);
  const smoothedRef = useRef(0);

  // Peak-hold with decay: read the highest level seen since the last frame,
  // then ease toward it. Gives smooth, organic motion from chunked updates.
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const tick = () => {
      const target = peakRef.current;
      peakRef.current = 0;
      smoothedRef.current += (target - smoothedRef.current) * 0.28;
      const s = smoothedRef.current;
      if (!reduced) {
        // Asymmetric liquid squash-stretch driven by live audio: the orb
        // stretches more on the axis of the sound, then eases back.
        if (coreRef.current) {
          coreRef.current.style.transform = `scale(${(1 + s * 0.26).toFixed(4)}, ${(1 + s * 0.15).toFixed(4)}) rotate(${(s * 2.5).toFixed(2)}deg)`;
        }
        if (auraRef.current) auraRef.current.style.opacity = String(0.28 + s * 0.72);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [peakRef]);

  let state: string;
  if (status === 'connected' && listening) state = 'listening';
  else if (status === 'connected') state = 'idle';
  else if (status === 'connecting') state = 'connecting';
  else state = 'disconnected';

  return (
    <div className={`orb-wrap orb--${state}${mini ? ' mini' : ''}`}>
      <div className="orb-aura" ref={auraRef} />
      <div className="orb-core" ref={coreRef} />
      <div className="orb-sheen" />
      <div className="orb-ring r1" />
      <div className="orb-ring r2" />
      <div className="orb-ring r3" />
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
  const [open, setOpen] = useState(false);
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
      if (log.includes('ROLLBACK')) base.color = 'var(--danger)';
      else if (log.includes('CONFLICT')) base.color = 'var(--warning)';
      else if (log.includes('commit')) { base.color = 'var(--success)'; base.opacity = 0.85; }
      else base.color = 'var(--accent)';
    } else if (log.includes('turn_complete')) {
      base.color = 'var(--text-muted)';
    }
    return base;
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed', bottom: 12, right: 12, width: 480, zIndex: 9999,
    background: 'var(--surface)',
    border: '1px solid var(--border-strong)',
    borderRadius: 12,
    color: 'var(--text)',
    boxShadow: 'var(--shadow-lg)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    fontFamily: "var(--font-mono)",
    fontSize: 11,
  };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 10px',
        borderBottom: open ? '1px solid var(--border)' : 'none',
        cursor: 'pointer', userSelect: 'none',
        color: 'var(--text-muted)',
        fontWeight: 600,
        fontSize: 11,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }} onClick={() => setOpen(o => !o)}>
        <span>{tab === 'log' ? `log (${logs.length})` : `sppe | ${tab}`}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {conflicts.length > 0 && (
            <span style={{ color: 'var(--warning)' }}>{conflicts.length}</span>
          )}
          <span>{open ? '▾' : '▸'}</span>
        </div>
      </div>

      {/* Tabs */}
      {open && (
        <div style={{
          display: 'flex', gap: 2, padding: '4px 8px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }} onClick={e => e.stopPropagation()}>
          {(['log', 'dag', 'waterfall', 'frontiers'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                fontSize: 10, padding: '3px 10px',
                border: tab === t ? '1px solid var(--accent-border)' : '1px solid transparent',
                borderRadius: 6,
                background: tab === t ? 'var(--accent-soft)' : 'transparent',
                color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
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
              ? <div style={{ color: 'var(--text-muted)', opacity: 0.5 }}>no events yet</div>
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
