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
import type { ActivityEntry, ActivityWidgetData } from './widgets/ActivityWidget';
import { HoloFace } from './holo/HoloFace';
import { VoiceWave } from './components/VoiceWave';
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
  const { addWidget, removeWidget, updateWidget, focusWidget, resizeWidget, clearWidgets, getInventoryString, widgets, focusedId } = useCanvas();
  // Live audio levels — mic drives "listening" liveliness; TTS playback
  // drives the face's mouth (lip sync).
  const micPeakRef = useRef<number>(0);
  /**
   * Mic level for the waveform. Separate from micPeakRef because HoloFace
   * consumes that one destructively (peak-and-clear each frame), so a second
   * reader would mostly see zeroes.
   */
  const micLevelRef = useRef<number>(0);
  const ttsPeakRef = useRef<number>(0);

  // The face is mounted once, outside the layout branches, and flies to
  // whichever anchor is currently on screen. Keeping one WebGL context alive
  // for the whole session is what makes the hero/dock move continuous.
  const holoAnchorRef = useRef<HTMLElement | null>(null);
  // The panel the face should be looking at. Mirrored into a ref because the
  // render loop reads it every frame and must not re-subscribe to do so.
  const attentionIdRef = useRef<string | null>(null);
  const sendContextRef = useRef<((text: string) => void) | null>(null);
  // Current widget list, readable from the tool handler without making it a
  // dependency and tearing down the callback on every canvas change.
  const widgetsRef = useRef(widgets);
  useEffect(() => { widgetsRef.current = widgets; }, [widgets]);
  useEffect(() => { attentionIdRef.current = focusedId; }, [focusedId]);
  const [interruptSignal, setInterruptSignal] = useState(0);

  // Persona is chosen before connecting. The list comes from the server so it
  // cannot drift out of sync with personas.ts.
  const [personas, setPersonas] = useState<Array<{ id: string; label: string }>>([]);
  const [personaId, setPersonaId] = useState<string>('companion');
  useEffect(() => {
    fetch('/api/personas')
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { if (Array.isArray(list) && list.length) setPersonas(list); })
      .catch(() => { /* selector just stays hidden */ });
  }, []);

  const { playChunk, flush, stop, prime, visemeTrackRef, audioCtxRef } = useAudioPlayback(
    useCallback((level: number) => {
      ttsPeakRef.current = Math.max(ttsPeakRef.current, level);
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
  /**
   * Panel registry — the canvas holds many panels, addressed by slug.
   *
   * Each widget type used to keep ONE id in a ref, so a second image_show
   * overwrote the first and the canvas could never hold more than one picture,
   * one text block and one code block. Panels are now keyed by
   * `${type}:${slug}`: a new slug opens a panel, a repeated slug replaces that
   * panel in place, and the model decides which it means by what it names.
   */
  const panelsRef = useRef<Map<string, { id: string; type: string; slug: string }>>(new Map());
  const codeDataRef = useRef<Map<string, CodeViewerData>>(new Map());
  /** Append-only activity feeds, keyed by panel slug. */
  const activityRef = useRef<Map<string, ActivityEntry[]>>(new Map());
  const activityCounterRef = useRef(1);

  const panelKey = (type: string, slug: unknown) =>
    `${type}:${(typeof slug === 'string' && slug.trim()) || 'main'}`;

  // Staggered highlight state
  const pendingTimersRef        = useRef<ReturnType<typeof setTimeout>[]>([]);
  const pendingHighlightCountRef = useRef<Map<string, number>>(new Map());
  const highlightsClearedRef = useRef(false);

  // Always-current canvas inventory for turn_complete injection
  const inventoryRef = useRef(getInventoryString);
  useEffect(() => { inventoryRef.current = getInventoryString; }, [getInventoryString]);

  // Track the active text widget ID so we replace rather than stack


  // Track the active image widget ID so we replace rather than stack


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

  /** Open the panel if its slug is new; otherwise replace it in place. */
  function upsertPanel(
    type: string, slug: string, data: unknown, cols: number, rows: number, source?: string,
  ): string {
    const key = panelKey(type, slug);
    const existing = panelsRef.current.get(key);
    if (existing) {
      updateWidget(existing.id, data);
      return existing.id;
    }
    const id = addWidget(type, data, cols, rows, source);
    panelsRef.current.set(key, { id, type, slug });
    return id;
  }

  /**
   * What the model is told is on screen. Reporting slugs rather than bare
   * types is what lets it reuse a panel deliberately, close the right one,
   * and know how many are already open.
   */
  function panelInventory(): string {
    const entries = [...panelsRef.current.values()].map((e) => `${e.type}:${e.slug}`);
    return entries.length ? entries.join(', ') : 'empty';
  }

  // Cancel all pending highlight timers and reset the counters.
  function clearPendingHighlights() {
    for (const t of pendingTimersRef.current) clearTimeout(t);
    pendingTimersRef.current = [];
    pendingHighlightCountRef.current.clear();
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
          const { panel, language, code, agent } = call.args as
            { panel?: string; language: string; code: string; agent?: string };
          const slug = (panel && panel.trim()) || 'main';
          clearPendingHighlights();
          highlightsClearedRef.current = false;
          const normalizedCode = code.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
          const data: CodeViewerData = { language, code: normalizedCode };
          codeDataRef.current.set(slug, data);
          focusWidget(upsertPanel('code_viewer', slug, data, 6, 6, agent));
          break;
        }

        case 'code_viewer_next_highlight': {
          const { panel, start_line, end_line } = call.args as
            { panel?: string; start_line: number; end_line: number };
          const slug = (panel && panel.trim()) || 'main';
          const entry = panelsRef.current.get(panelKey('code_viewer', slug));
          if (!entry) break;
          focusWidget(entry.id);
          if (!start_line || !end_line || start_line <= 0 || end_line <= 0) break;
          highlightsClearedRef.current = false;

          // Each code panel walks through its own sections on its own clock,
          // so the counter is per-panel rather than global.
          const seen = pendingHighlightCountRef.current.get(slug) ?? 0;
          pendingHighlightCountRef.current.set(slug, seen + 1);
          const delay = HIGHLIGHT_INITIAL_DELAY + seen * HIGHLIGHT_INTERVAL;

          const timerId = setTimeout(() => {
            pendingTimersRef.current = pendingTimersRef.current.filter((t) => t !== timerId);
            const live = panelsRef.current.get(panelKey('code_viewer', slug));
            if (!live) return;
            const updated: CodeViewerData = {
              ...(codeDataRef.current.get(slug) ?? { language: '', code: '' }),
              highlight: { start: start_line, end: end_line },
            };
            codeDataRef.current.set(slug, updated);
            updateWidget(live.id, updated);
          }, delay);

          pendingTimersRef.current.push(timerId);
          break;
        }

        // ── Image ────────────────────────────────────────────────────
        case 'image_show': {
          const { panel, query, urls, agent } = call.args as
            { panel?: string; query: string; urls?: string[]; agent?: string };
          const slug = (panel && panel.trim()) || 'main';
          // A failed lookup still gets a tile, so the user never stares at a
          // stale picture the agent believes it replaced.
          const data: ImageWidgetData = { query, urls: urls ?? [] };
          focusWidget(upsertPanel('image', slug, data, 4, 4, agent));
          break;
        }

        // ── Text ─────────────────────────────────────────────────────
        case 'text_show': {
          const { panel, title, content, agent } = call.args as
            { panel?: string; title?: string; content: string; agent?: string };
          const slug = (panel && panel.trim()) || 'main';
          const data: TextWidgetData = { content, title, panel: slug };
          focusWidget(upsertPanel('text', slug, data, 4, 4, agent));
          break;
        }

        case 'activity_log': {
          const { panel, label, detail, url, status, agent } = call.args as {
            panel?: string; label: string; detail?: string; url?: string;
            status?: string; agent?: string;
          };
          const slug = (panel && panel.trim()) || 'activity';
          const key = panelKey('activity', slug);
          const prev = activityRef.current.get(slug) ?? [];
          const state = (status === 'running' || status === 'error') ? status : 'done';

          // A step that reports back with the same label updates in place, so
          // "running" becomes "done" rather than appearing twice.
          const existing = prev.findIndex((e) => e.label === label && e.status === 'running');
          const entry = {
            id: existing >= 0 ? prev[existing].id : `act_${activityCounterRef.current++}`,
            label, detail, url, status: state as 'running' | 'done' | 'error', at: Date.now(),
          };
          const next = existing >= 0
            ? prev.map((e, i) => (i === existing ? entry : e))
            : [...prev, entry].slice(-60);

          activityRef.current.set(slug, next);
          const data: ActivityWidgetData = { title: agent ?? 'Activity', entries: next };
          const live = panelsRef.current.get(key);
          if (live) updateWidget(live.id, data);
          else upsertPanel('activity', slug, data, 3, 6, agent);
          break;
        }

        // ── Panel management ─────────────────────────────────────────
        case 'close_panel': {
          const { panel } = call.args as { panel?: string };
          const slug = (panel && panel.trim()) || 'main';
          for (const [key, entry] of [...panelsRef.current.entries()]) {
            if (entry.slug !== slug) continue;
            removeWidget(entry.id);
            panelsRef.current.delete(key);
            codeDataRef.current.delete(slug);
            activityRef.current.delete(slug);
          }
          break;
        }

        case 'arrange_panel': {
          const { panel, cols, rows } = call.args as
            { panel?: string; cols?: number; rows?: number };
          const slug = (panel && panel.trim()) || 'main';
          for (const entry of panelsRef.current.values()) {
            if (entry.slug !== slug) continue;
            const w = widgetsRef.current.find((x) => x.id === entry.id);
            resizeWidget(entry.id, cols ?? w?.cols ?? 4, rows ?? w?.rows ?? 2);
            break;
          }
          break;
        }

        case 'focus_panel': {
          const { panel } = call.args as { panel?: string };
          const slug = (panel && panel.trim()) || 'main';
          for (const entry of panelsRef.current.values()) {
            if (entry.slug === slug) { focusWidget(entry.id); break; }
          }
          break;
        }

        // ── Call Stack ───────────────────────────────────────────────
        case 'call_stack_show': {
          const initial: CallStackData = { frames: [], overflow: false };
          callStackDataRef.current = initial;
          const id = addWidget('call_stack', initial, 3, 6);
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
            const id = addWidget('terminal', data, 6, 4);
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
          panelsRef.current.clear();
          codeDataRef.current.clear();
          activityRef.current.clear();
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
    [addWidget, removeWidget, updateWidget, focusWidget, resizeWidget, clearWidgets, addLog]
  );

  // The user editing a panel is new information the agent needs. It arrives
  // as silent context, so it informs the next answer without provoking one.
  useEffect(() => {
    const onEdit = (e: Event) => {
      const { panel, content } = (e as CustomEvent).detail as { panel: string; content: string };
      addLog(`panel edited by user → ${panel}`);

      // Persist it. Without this the panel snaps back to whatever the agent
      // last wrote the moment anything re-renders.
      const entry = panelsRef.current.get(`text:${panel}`);
      if (entry) {
        const prev = widgetsRef.current.find((w) => w.id === entry.id)?.data as
          | { title?: string } | undefined;
        updateWidget(entry.id, { content, title: prev?.title, panel });
      }

      sendContextRef.current?.(
        `[user edited panel "${panel}". Its contents are now:\n${content}\nTreat this as the current truth for that panel.]`
      );
    };
    window.addEventListener('synapse:panel-edit', onEdit);
    return () => window.removeEventListener('synapse:panel-edit', onEdit);
  }, [addLog, updateWidget]);

  const { connect, disconnect, sendAudio, sendContext, status } = useLiveSession({
    onAudioChunk: (base64) => playChunk(base64),
    onInterrupted: () => {
      addLog('interrupted → SPPE rollback, flush audio, cancel highlights');
      flush();
      clearPendingHighlights();
      setInterruptSignal((n) => n + 1);

      // SPPE rollback: notify runtime, revert widgets to last committed state
      const sppe = sppeRef.current;
      if (sppe) {
        sppe.handleInterrupt();
        // Drop highlights on every open code panel — an interruption
        // invalidates the walkthrough wherever it was running.
        for (const entry of panelsRef.current.values()) {
          if (entry.type !== 'code_viewer') continue;
          const prev = codeDataRef.current.get(entry.slug);
          if (!prev) continue;
          const cleared: CodeViewerData = { language: prev.language, code: prev.code };
          codeDataRef.current.set(entry.slug, cleared);
          updateWidget(entry.id, cleared);
          highlightsClearedRef.current = true;
        }
      }
    },
    onToolCall: handleToolCall,
    onTurnComplete: () => {
      const inv = panelInventory();
      const sppe = sppeRef.current;
      const depInfo = sppe ? ` | sppe:${sppe.getStatus()}` : '';
      const hasCode = [...panelsRef.current.values()].some((e) => e.type === 'code_viewer');
      const note = highlightsClearedRef.current && hasCode
        ? ' | highlights cleared by interruption'
        : '';
      if (note) highlightsClearedRef.current = false;
      addLog(`turn_complete → canvas:${inv || 'empty'}${note}${depInfo}`);
      sendContext(`[canvas: ${inv}${note}]`);
    },
  });

  const { start: startMic, stop: stopMic, isRecording } = useAudioIO(
    useCallback((chunk: string) => sendAudio(chunk), [sendAudio]),
    useCallback((level: number) => {
      micPeakRef.current = Math.max(micPeakRef.current, level);
      micLevelRef.current = level;
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

  useEffect(() => { sendContextRef.current = sendContext; }, [sendContext]);

  async function handleStart() {
    try {
      await prime();
      await connect(personaId);
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
    panelsRef.current.clear();
    codeDataRef.current.clear();
    activityRef.current.clear();
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
    <div className="hero-status">
      <VoiceWave
        levelRef={micLevelRef}
        active={isRecording && status === 'connected'}
        connected={status === 'connected'}
      />
    </div>
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
          {personas.length > 1 && (
            <label className="persona-select" title="Identity, voice and teaching style">
              <span className="sr-only">Persona</span>
              <select
                value={personaId}
                disabled={status !== 'disconnected'}
                onChange={(e) => setPersonaId(e.target.value)}
              >
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </label>
          )}
          <button className="toolbar-btn" type="button" onClick={toggleTheme}>{darkMode ? 'Light' : 'Dark'}</button>
        </div>
      </header>

      <main className={`app-main${hasWidgets ? ' has-widgets' : ''}`}>
        {!hasWidgets ? (
          <>
            <section className="hero">
              <div
                className="holo-anchor holo-anchor--hero"
                ref={(el) => { holoAnchorRef.current = el; }}
              />
              {statusEl}
            </section>
            <div className="controls-bar">{sessionControls}</div>
          </>
        ) : (
          <>
            <Canvas />
            <div className="session-bar">
              <div className="session-voice">
                <div
                  className="holo-anchor holo-anchor--dock"
                  ref={(el) => { holoAnchorRef.current = el; }}
                />
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

      <HoloFace
        status={status}
        listening={isRecording}
        layout={hasWidgets ? 'docked' : 'hero'}
        anchorRef={holoAnchorRef}
        attentionIdRef={attentionIdRef}
        theme={darkMode ? 'dark' : 'light'}
        visemeTrackRef={visemeTrackRef}
        audioCtxRef={audioCtxRef}
        micPeakRef={micPeakRef}
        interruptSignal={interruptSignal}
      />

      <DebugPanel logs={logs} events={events} frontiers={frontiers} conflicts={conflicts} />
    </div>
  );
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

  // Collapsed, this is a small pill in the corner. It only takes real estate
  // once someone actually opens it — the face is the product, the SPPE log is
  // a developer tool that happens to live in the same window.
  const panelStyle: React.CSSProperties = {
    position: 'fixed', bottom: 12, right: 12,
    width: open ? 440 : 'auto', zIndex: 9999,
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
        gap: 10,
        padding: open ? '6px 10px' : '5px 11px',
        borderBottom: open ? '1px solid var(--border)' : 'none',
        opacity: open ? 1 : 0.55,
        transition: 'opacity 0.2s ease',
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
