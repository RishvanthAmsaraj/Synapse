# Synapse Parallel Processing Engine (SPPE)

## Research Foundation

### Key Papers

#### 1. GAP: Graph-Based Agent Planning with Parallel Tool Use (+ RL)
**arXiv: 2510.25320** — Oct 2025

**Core idea:** Models inter-task dependencies as a directed acyclic graph (DAG). Independent sub-tasks execute in parallel; dependent ones wait. Trained via SFT on curated traces, then RL with correctness rewards.

**Lessons for Synapse:**
- DAG-based scheduling for widget actions
- Dependency-aware: `text_show` and `image_show` can fire together; `code_viewer_next_highlight` depends on `code_viewer_show`
- RL could optimize widget orchestration policies

#### 2. Atomix: Timely, Transactional Tool Use for Reliable Agentic Workflows
**arXiv: 2602.14849** — Feb 2026

**Core idea:** Treats tool effects as transactions with read/write frontiers. Commits only after confirming no earlier conflicting work can still arrive. Aborts suppress unreleased effects.

**Lessons for Synapse:**
- "Progress-aware transactions" for canvas state — a widget update should commit only after its dependency frontier is satisfied
- Frontier tracking: each widget version carries a logical timestamp; concurrent updates resolve via frontier ordering
- Rollback on barge-in: when the user interrupts, partial canvas effects get compensated gracefully

#### 3. Adaptive Multi-Agent Orchestration (MetaAgent / AgentVerse ecosystems)
**Key insight:** Multiple specialized agents can operate on shared state through a coordinator that respects access patterns.

**Lessons for Synapse:**
- Idea: multiple "canvas agents" — a speech agent, a widget agent, a code executor agent — all operating on the same canvas
- The coordinator (SPPE runtime) ensures no two agents write to the same widget simultaneously

---

## The Synapse Innovation: Concurrent Multimodal Stream Architecture (CMSA)

What makes this different from anything in the literature:

### Status Quo Problem
| System | Speech | Visuals | Code | Parallel? |
|--------|--------|---------|------|-----------|
| ChatGPT Voice | ✅ | ❌ | ❌ | N/A |
| Claude Artifacts | ❌ | ✅ | ✅ | Sequential |
| Gemini Live | ✅ | ✅ widgets | ❌ | NON_BLOCKING = fire-and-forget |
| Cursor | ❌ | ✅ editor | ✅ | Sequential |
| Copilot Chat | ❌ | ✅ editor | ✅ | Sequential |
| ReAct agents | ❌ | ❌ | ✅ | Sequential |
| GAP | ❌ | ❌ | ✅ | Parallel tool calls |
| Atomix | ❌ | ❌ | ✅ | Parallel + transactional |

**No existing system combines:**
1. ✅ Real-time speech I/O
2. ✅ Visual canvas updates (widgets)
3. ✅ Background code execution
4. ✅ ALL THREE SIMULTANEOUSLY, with transactional guarantees

### The SPPE Architecture

```
                    ┌─────────────────────────────────────┐
                    │          SPPE Runtime                 │
                    │  (Concurrent Stream Coordinator)      │
                    └─────────────────────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
     ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
     │  Speech      │  │  Widget      │  │  Code Exec   │
     │  Stream      │  │  Stream      │  │  Stream      │
     │  (real-time  │  │  (canvas     │  │  (sandboxed  │
     │   audio I/O) │  │   updates)   │  │   runtimes)  │
     └──────────────┘  └──────────────┘  └──────────────┘
                              │                  │
                              ▼                  ▼
                     ┌──────────────┐  ┌──────────────┐
                     │  Widget      │  │  Result      │
                     │  Scheduler   │  │  Consumer    │
                     │  (DAG-based) │  │  (streams    │
                     │              │  │   back to    │
                     │              │  │   speech)    │
                     └──────────────┘  └──────────────┘
```

### Key Innovation: Multi-Stream Dependency Scheduling

Instead of a single LLM call chain, SPPE maintains **N concurrent streams**:

```
Stream A (Speech): ───⌇──────⌇──────⌇──────→  (the model speaking)
                    │      │      │
Stream B (Widget):  ──text─┘      │
                    ───image───────┘
                    ──────code──────⌇────→
                                    │
Stream C (Exec):    ──execute───────┘─────→
                    │                      │
Results:            ──────────────────────→  (exec results feed back into speech)
```

### Dependency Graph Types

```
1. INDEPENDENT (can be PARALLEL)
   ┌─── text_show("overview") ──┐
   ├─── image_show("merge sort") ├──→ ALL AT ONCE
   └─── speech("let me explain") ┘

2. SEQUENTIAL (must be SERIAL)
   code_viewer_show → code_viewer_next_highlight_1 → code_viewer_next_highlight_2

3. DATA-DEPENDENT
   exec_code → (wait for result) → speech("the output is...")

4. MERGE (streams converge)
   exec_code ──┐
                ├──→ text_show("results")
   speech ─────┘
```

### Transactional Widget State

Each widget action carries a logical timestamp. The SPPE runtime ensures:

1. **Write monotonicity**: Widget state can only move forward (version-based)
2. **Conflict resolution**: Two concurrent writes to the same widget merge via last-writer-wins with frontier awareness
3. **Barge-in compensation**: On user interruption:
   - Audio stream flushes immediately
   - Widget updates that were "in-flight" revert to last committed state
   - Model receives `[canvas state: <rollback_summary>]` on next turn
4. **Frontier tracking**: Each widget action records what it depends on; runtime checks frontiers before committing

### New Widget Types Enabled by SPPE

| Widget | Purpose | Stream |
|--------|---------|--------|
| `exec_code` | Run Python/JS in sandbox | Async exec |
| `terminal_widget` | Interactive shell session | Async exec |
| `chart_widget` | Live-updating charts | Widget stream |
| `diff_widget` | Side-by-side code diff | Widget stream |
| `whiteboard` | Drawing canvas | Widget stream |
| `file_widget` | File explorer/preview | Widget stream |

### Comparison to Existing Work

| Feature | GAP | Atomix | ReAct | Synapse SPPE |
|---------|-----|--------|-------|-------------|
| Parallel tool calls | ✅ DAG-based | ✅ Transactional | ❌ Sequential | ✅ Multi-stream |
| Speech + visuals | ❌ | ❌ | ❌ | ✅ Native |
| Transactional rollback | ❌ | ✅ | ❌ | ✅ Barge-in aware |
| Code execution | ❌ | ❌ | ✅ | ✅ Sandboxed |
| Runtime scheduling | ✅ RL-optimized | ✅ Frontier-based | ❌ | ✅ DAG + frontiers |
| User interruption | ❌ | ❌ | ❌ | ✅ Compensates |
| Stream merge | ❌ | ❌ | ❌ | ✅ |

## Implementation Sketch

### Runtime Core (TypeScript)

```typescript
// Conceptual SPPE runtime

interface Dependency {
  type: 'independent' | 'sequential' | 'data_dependency' | 'merge';
  dependsOn?: string[];  // list of action IDs this depends on
}

interface WidgetAction {
  id: string;
  stream: 'speech' | 'widget' | 'exec';
  action: string;
  payload: unknown;
  dependencies: Dependency;
  timestamp: number;
  frontier: Map<string, number>;  // per-widget version frontier
}

class SPPERuntime {
  private dags: Map<string, DependencyGraph>;
  private frontiers: Map<string, number>;  // per-widget version
  private streams: SpeechStream | WidgetStream | ExecStream;
  
  async schedule(action: WidgetAction): Promise<void> {
    // 1. Resolve dependencies
    // 2. Check frontiers
    // 3. Route to appropriate stream
    // 4. Track for rollback
  }
  
  onInterrupt(): void {
    // 1. Flush speech
    // 2. Rollback uncommitted widget actions
    // 3. Rebuild frontier state
    // 4. Notify model
  }
}
```

### Integration with Current Synapse

The current `handleToolCall` reducer in `App.tsx` processes tool calls sequentially (even though Gemini fires them NON_BLOCKING). SPPE replaces the reducer with:

1. **Widget Scheduler** — receives tool calls, checks dependency + frontier, routes to stream
2. **Stream Executors** — each stream runs independently with its own timing
3. **State Manager** — transactional commits with rollback capability
4. **Inventory Provider** — generates accurate canvas state for model context

---

## Next Steps

1. Implement SPPE runtime class
2. Refactor `App.tsx` tool call handling to use SPPE
3. Add `exec_code` widget + sandbox
4. Add barge-in compensation (Atomix-inspired)
5. Add dependency graph visualization in debug panel
6. Evaluate against GAP-style benchmarks
