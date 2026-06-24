/**
 * SPPEDebug — Debug visualization panel for the Synapse Parallel Processing Engine
 *
 * Renders three views:
 * 1. DAG Visualization — live dependency graph as an SVG node/edge tree
 * 2. Stream Waterfall — timeline of events across speech | widget | exec
 * 3. Frontier Dashboard — real-time version counters per stream
 */

import { useState, useCallback, createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { SPPEStreamEvent } from './SPPE';
import './SPPEDebug.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriorityInfo {
  committed: number;
  pending: number;
  frontiers: Record<string, number>;
}

export interface DebugContextValue {
  events: SPPEStreamEvent[];
  pushEvent: (event: SPPEStreamEvent) => void;
  conflicts: Array<{ actionId: string; won: boolean; timestamp: number }>;
  pushConflict: (actionId: string, won: boolean) => void;
  frontiers: Record<string, number>;
  setFrontier: (stream: string, version: number) => void;
  clear: () => void;
}

const DebugContext = createContext<DebugContextValue | null>(null);

export function useSPPEDebug() {
  const ctx = useContext(DebugContext);
  if (!ctx) throw new Error('useSPPEDebug must be used within SPPEDebugProvider');
  return ctx;
}

export function SPPEDebugProvider({ children }: { children: ReactNode }) {
  const [events, setEvents] = useState<SPPEStreamEvent[]>([]);
  const [conflicts, setConflicts] = useState<Array<{ actionId: string; won: boolean; timestamp: number }>>([]);
  const [frontiers, setFrontiers] = useState<Record<string, number>>({});

  const pushEvent = useCallback((event: SPPEStreamEvent) => {
    setEvents(prev => [...prev.slice(-199), event]); // keep last 200
  }, []);

  const pushConflict = useCallback((actionId: string, won: boolean) => {
    setConflicts(prev => [...prev.slice(-29), { actionId, won, timestamp: Date.now() }]); // keep last 30
  }, []);

  const setFrontier = useCallback((stream: string, version: number) => {
    setFrontiers(prev => ({ ...prev, [stream]: version }));
  }, []);

  const clear = useCallback(() => {
    setEvents([]);
    setConflicts([]);
    setFrontiers({});
  }, []);

  return (
    <DebugContext.Provider value={{ events, pushEvent, conflicts, pushConflict, frontiers, setFrontier, clear }}>
      {children}
    </DebugContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// DAG Visualization
// ---------------------------------------------------------------------------

/** A single node in the dependency graph */
interface DAGNode {
  id: string;
  label: string;
  stream: string;
  status: string;
  children: string[]; // node ids that depend on this
}

const STREAM_COLORS: Record<string, string> = {
  speech: '#6366f1', // indigo
  widget: '#f59e0b', // amber
  exec:   '#10b981', // emerald
};

export function DAGVis({ events }: { events: SPPEStreamEvent[] }) {
  // Build a simple graph from events
  const nodes = buildDAG(events);
  if (nodes.length === 0) {
    return (
      <div className="sppe-dag-empty">
        <span>No actions scheduled yet</span>
      </div>
    );
  }

  return (
    <div className="sppe-dag">
      {nodes.map(node => (
        <div key={node.id} className="sppe-dag-node" style={{
          borderLeftColor: STREAM_COLORS[node.stream] || '#666',
        }}>
          <div className="sppe-dag-node-header">
            <span className="sppe-dag-stream" style={{ color: STREAM_COLORS[node.stream] || '#666' }}>
              {node.stream}
            </span>
            <span className="sppe-dag-status">{node.status}</span>
          </div>
          <div className="sppe-dag-label">{node.label}</div>
          {node.children.length > 0 && (
            <div className="sppe-dag-children">
              → {node.children.join(', ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function buildDAG(events: SPPEStreamEvent[]): DAGNode[] {
  const nodes: DAGNode[] = [];
  const seen = new Set<string>();

  for (const ev of events) {
    if (seen.has(ev.actionId)) continue;
    seen.add(ev.actionId);

    const stream = ev.stream;
    const prevSameStream = events
      .filter(e => e.stream === stream && e.resolvedOrder < ev.resolvedOrder)
      .slice(-1);

    nodes.push({
      id: ev.actionId,
      label: ev.actionName,
      stream: ev.stream,
      status: resolvedStatus(ev),
      children: prevSameStream.map(e => e.actionId),
    });
  }

  return nodes;
}

function resolvedStatus(ev: SPPEStreamEvent): string {
  // Heuristic based on event presence
  if (ev.resolvedOrder >= 0) return 'committed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// Stream Waterfall
// ---------------------------------------------------------------------------

export function StreamWaterfall({ events }: { events: SPPEStreamEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="sppe-waterfall-empty">
        <span>No stream activity yet</span>
      </div>
    );
  }

  const streams: string[] = ['speech', 'widget', 'exec'];
  const latestTime = events[events.length - 1]?.timestamp || Date.now();

  return (
    <div className="sppe-waterfall">
      {streams.map(stream => {
        const streamEvents = events.filter(e => e.stream === stream);
        if (streamEvents.length === 0) return null;

        return (
          <div key={stream} className="sppe-waterfall-row">
            <div className="sppe-waterfall-label" style={{ color: STREAM_COLORS[stream] || '#666' }}>
              {stream}
            </div>
            <div className="sppe-waterfall-track">
              {streamEvents.map(ev => {
                const age = latestTime - ev.timestamp;
                const maxAge = Math.max(10000, age + 2000);
                const leftPct = Math.max(0, 100 - (age / maxAge) * 100);
                return (
                  <div
                    key={ev.actionId}
                    className="sppe-waterfall-event"
                    style={{
                      left: `${Math.max(0, leftPct - 2)}%`,
                      background: STREAM_COLORS[ev.stream] || '#666',
                    }}
                    title={`${ev.actionName} (#${ev.resolvedOrder})`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frontier Dashboard
// ---------------------------------------------------------------------------

export function FrontierDashboard({ frontiers }: { frontiers: Record<string, number> }) {
  const entries = Object.entries(frontiers);

  if (entries.length === 0) {
    return (
      <div className="sppe-frontier-empty">
        <span>No frontiers yet</span>
      </div>
    );
  }

  return (
    <div className="sppe-frontier">
      {entries.map(([stream, version]) => (
        <div key={stream} className="sppe-frontier-item">
          <span className="sppe-frontier-label" style={{ color: STREAM_COLORS[stream] || '#666' }}>
            {stream}
          </span>
          <span className="sppe-frontier-value">v{version}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combined Debug Panel
// ---------------------------------------------------------------------------

interface SPPEDebugPanelProps {
  events: SPPEStreamEvent[];
  frontiers: Record<string, number>;
  conflicts?: Array<{ actionId: string; won: boolean; timestamp: number }>;
}

export function SPPEDebugPanel({ events, frontiers, conflicts = [] }: SPPEDebugPanelProps) {
  const [tab, setTab] = useState<'dag' | 'waterfall' | 'frontiers'>('dag');

  return (
    <div className="sppe-debug-panel">
      <div className="sppe-debug-tabs">
        <button
          className={`sppe-debug-tab ${tab === 'dag' ? 'active' : ''}`}
          onClick={() => setTab('dag')}
        >
          DAG
        </button>
        <button
          className={`sppe-debug-tab ${tab === 'waterfall' ? 'active' : ''}`}
          onClick={() => setTab('waterfall')}
        >
          Waterfall
        </button>
        <button
          className={`sppe-debug-tab ${tab === 'frontiers' ? 'active' : ''}`}
          onClick={() => setTab('frontiers')}
        >
          Frontiers
        </button>
        {conflicts.length > 0 && (
          <span className="sppe-debug-conflict-badge">{conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''}</span>
        )}
      </div>

      <div className="sppe-debug-content">
        {tab === 'dag' && <DAGVis events={events} />}
        {tab === 'waterfall' && <StreamWaterfall events={events} />}
        {tab === 'frontiers' && <FrontierDashboard frontiers={frontiers} />}
      </div>
    </div>
  );
}
