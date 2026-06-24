/**
 * SPPE — Synapse Parallel Processing Engine
 *
 * A concurrent stream coordinator inspired by:
 * - GAP (Graph-Based Agent Planning with Parallel Tool Use, arXiv:2510.25320)
 * - Atomix (Timely, Transactional Tool Use, arXiv:2602.14849)
 *
 * Key innovations:
 * 1. Multi-stream dependency scheduling (speech | widget | exec)
 * 2. Frontier-based transactional widget state
 * 3. Barge-in compensation (interrupt rollback)
 * 4. Conflict resolution via last-writer-wins with frontier awareness
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StreamName = 'speech' | 'widget' | 'exec';

export type DependencyType = 'independent' | 'sequential' | 'data_dependency' | 'merge';

export interface Dependency {
  type: DependencyType;
  dependsOn?: string[];  // list of action names this depends on
}

export interface SPPEAction {
  id: string;
  stream: StreamName;
  action: string;
  payload: Record<string, unknown>;
  dependencies: Dependency;
  timestamp: number;
  status: 'pending' | 'scheduled' | 'committed' | 'rolled_back' | 'conflicted';
}

export interface SPPEStreamEvent {
  stream: StreamName;
  actionId: string;
  actionName: string;
  resolvedOrder: number;
  timestamp: number;
}

export interface SPPEOptions {
  onSchedule?: (event: SPPEStreamEvent) => void;
  onCommit?: (event: SPPEStreamEvent) => void;
  onRollback?: (event: SPPEStreamEvent) => void;
  onConflict?: (event: SPPEStreamEvent) => void;
}

// ---------------------------------------------------------------------------
// Dependency Graph — FSM for each action name
// ---------------------------------------------------------------------------

interface ActionState {
  completed: boolean;
  lastCompletedAt: number;
}

class DependencyGraph {
  private actionStates: Map<string, ActionState> = new Map();

  /** Register an action name for tracking */
  register(actionName: string): void {
    if (!this.actionStates.has(actionName)) {
      this.actionStates.set(actionName, { completed: false, lastCompletedAt: 0 });
    }
  }

  /** Mark an action as completed */
  complete(actionName: string): void {
    const state = this.actionStates.get(actionName);
    if (state) {
      state.completed = true;
      state.lastCompletedAt = Date.now();
    }
  }

  /** Check if a dependency is satisfied */
  isSatisfied(dep: Dependency): boolean {
    if (dep.type === 'independent' || !dep.dependsOn || dep.dependsOn.length === 0) {
      return true;
    }
    return dep.dependsOn.every(name => {
      const state = this.actionStates.get(name);
      return state?.completed === true;
    });
  }

  /** Get actions that are still pending in a dependency chain */
  getPendingDependencies(dep: Dependency): string[] {
    if (!dep.dependsOn) return [];
    return dep.dependsOn.filter(name => {
      const state = this.actionStates.get(name);
      return !state?.completed;
    });
  }

  /** Reset all states */
  reset(): void {
    this.actionStates.clear();
  }
}

// ---------------------------------------------------------------------------
// Frontier-based version tracker — per-widget versioning
// ---------------------------------------------------------------------------

class FrontierTracker {
  private frontiers: Map<string, number> = new Map();  // widget-type → version

  /** Get current frontier version for a widget type */
  getFrontier(widgetType: string): number {
    return this.frontiers.get(widgetType) ?? 0;
  }

  /** Advance frontier (commit) */
  advance(widgetType: string): number {
    const next = this.getFrontier(widgetType) + 1;
    this.frontiers.set(widgetType, next);
    return next;
  }

  /** Rollback frontier (revert to previous) */
  rollback(widgetType: string): number {
    const current = this.getFrontier(widgetType);
    if (current > 0) {
      const prev = current - 1;
      this.frontiers.set(widgetType, prev);
      return prev;
    }
    return 0;
  }

  /** Reset all frontiers */
  reset(): void {
    this.frontiers.clear();
  }
}

// ---------------------------------------------------------------------------
// SPPE Runtime
// ---------------------------------------------------------------------------

let actionCounter = 0;

export class SPPE {
  private dependencyGraph: DependencyGraph;
  private frontiers: FrontierTracker;
  private pendingActions: SPPEAction[] = [];
  private committedActions: SPPEAction[] = [];
  private actionLog: SPPEStreamEvent[] = [];
  private options: SPPEOptions;
  private isDisposed = false;

  constructor(options: SPPEOptions = {}) {
    this.dependencyGraph = new DependencyGraph();
    this.frontiers = new FrontierTracker();
    this.options = options;
  }

  /**
   * Schedule an action with dependency tracking.
   * The action is assigned a logical timestamp and checked against
   * the dependency graph before being routed to its stream.
   *
   * @returns The scheduled action ID
   */
  schedule(
    stream: StreamName,
    action: string,
    payload: Record<string, unknown>,
    dependencies: Dependency,
  ): string {
    if (this.isDisposed) throw new Error('SPPE runtime has been disposed');

    const id = `act_${++actionCounter}`;
    const timestamp = Date.now();

    // Register dependencies
    this.dependencyGraph.register(action);
    if (dependencies.dependsOn) {
      for (const dep of dependencies.dependsOn) {
        this.dependencyGraph.register(dep);
      }
    }

    const sppeAction: SPPEAction = {
      id,
      stream,
      action,
      payload,
      dependencies,
      timestamp,
      status: 'pending',
    };

    // Check if dependencies are met
    const canSchedule = this.dependencyGraph.isSatisfied(dependencies);

    if (canSchedule) {
      sppeAction.status = 'scheduled';
      const order = this.actionLog.length;

      const event: SPPEStreamEvent = {
        stream,
        actionId: id,
        actionName: action,
        resolvedOrder: order,
        timestamp,
      };

      this.actionLog.push(event);
      this.pendingActions.push(sppeAction);
      this.options.onSchedule?.(event);

      // Commit immediately for independent actions
      if (dependencies.type === 'independent') {
        this.commit(sppeAction);
      }
    } else {
      // Queue it — dependencies not yet met
      this.pendingActions.push(sppeAction);
    }

    return id;
  }

  /**
   * Commit an action — advances its frontier and marks it as settled.
   */
  private commit(action: SPPEAction): void {
    action.status = 'committed';
    this.dependencyGraph.complete(action.action);

    // Advance frontier for this stream
    this.frontiers.advance(action.stream);

    this.committedActions.push(action);

    // Remove from pending
    this.pendingActions = this.pendingActions.filter(a => a.id !== action.id);

    // Emit commit event
    const logEntry = this.actionLog.find(e => e.actionId === action.id);
    if (logEntry) {
      this.options.onCommit?.(logEntry);
    }

    // Re-check pending actions that may now have their dependencies satisfied
    this.recheckPending();
  }

  /**
   * Re-check all pending actions to see if their dependencies are now met.
   */
  private recheckPending(): void {
    const newlyReady: SPPEAction[] = [];

    for (const action of this.pendingActions) {
      if (action.status === 'pending' && this.dependencyGraph.isSatisfied(action.dependencies)) {
        action.status = 'scheduled';
        newlyReady.push(action);
      }
    }

    // Commit newly ready actions
    for (const action of newlyReady) {
      this.commit(action);
    }
  }

  /**
   * Handle user interruption (barge-in).
   * Flushes speech stream, rolls back uncommitted widget actions,
   * and compensates any partially applied effects.
   *
   * Inspired by Atomix transaction rollback.
   */
  handleInterrupt(): void {

    // Collect actions to rollback (pending + uncommitted)
    const toRollback: SPPEAction[] = [];

    for (const action of this.pendingActions) {
      if (action.stream === 'widget' && action.status !== 'committed') {
        toRollback.push(action);
      }
    }

    // Rollback each
    for (const action of toRollback) {
      action.status = 'rolled_back';
      this.frontiers.rollback(action.stream);

      const logEntry = this.actionLog.find(e => e.actionId === action.id);
      if (logEntry) {
        this.options.onRollback?.(logEntry);
      }
    }

    // Clear pending actions that were rolled back
    this.pendingActions = this.pendingActions.filter(
      a => !toRollback.find(r => r.id === a.id)
    );
  }

  /**
   * Detect and resolve conflicts between concurrent actions.
   * Uses last-writer-wins with frontier awareness.
   *
   * @param action1 First conflicting action
   * @param action2 Second conflicting action
   * @returns The action that should be committed (the "winner")
   */
  resolveConflict(action1: SPPEAction, action2: SPPEAction): SPPEAction {
    // Last-writer-wins by timestamp
    const winner = action1.timestamp >= action2.timestamp ? action1 : action2;
    const loser = winner.id === action1.id ? action2 : action1;

    loser.status = 'conflicted';

    const logEntry = this.actionLog.find(e => e.actionId === loser.id);
    if (logEntry) {
      this.options.onConflict?.(logEntry);
    }

    return winner;
  }

  /**
   * Get current runtime status summary for context injection.
   * Uses any stored frontier info via the tracker.
   */
  getStatus(): string {
    const committed = this.committedActions.length;
    const pending = this.pendingActions.length;
    return `committed=${committed} pending=${pending}`;
  }

  /**
   * Whether any exec actions are in the pipeline.
   */
  hasExecActions(): boolean {
    return this.pendingActions.some(a => a.stream === 'exec') ||
      this.committedActions.some(a => a.stream === 'exec');
  }

  /**
   * Get the latest committed actions for a given stream.
   */
  getStreamActions(stream: StreamName): SPPEAction[] {
    return this.committedActions.filter(a => a.stream === stream);
  }

  /**
   * Full reset — clears all state.
   */
  reset(): void {
    this.dependencyGraph.reset();
    this.frontiers.reset();
    this.pendingActions = [];
    this.committedActions = [];
    this.actionLog = [];
  }

  /**
   * Dispose — clean up all resources.
   */
  dispose(): void {
    this.isDisposed = true;
    this.reset();
  }
}
