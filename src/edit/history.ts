/**
 * Undo/redo journal.
 *
 * Every editor operation is wrapped in a transaction that captures a compact
 * list of `BlockChange` deltas (not world snapshots), so undoing a 2-million
 * block terraform costs the same memory as the blocks it actually altered.
 *
 * The journal enforces a memory budget: when the total recorded change count
 * exceeds `maxChanges`, the oldest entries are dropped.
 */

import { EventBus } from '../core/events';
import type { BlockChange } from '../core/types';
import type { World } from '../world/world';

export interface HistoryEntry {
  id: number;
  label: string;
  changes: BlockChange[];
  timestamp: number;
}

export interface HistoryEvents {
  changed: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string };
  applied: { entry: HistoryEntry; direction: 'undo' | 'redo' | 'do' };
}

export class EditHistory {
  readonly events = new EventBus<HistoryEvents>();
  maxEntries = 256;
  maxChanges = 12_000_000;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private world: World;
  private depth = 0;
  private label = '';
  private seq = 0;
  private recorded = 0;

  constructor(world: World) {
    this.world = world;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get entries(): readonly HistoryEntry[] {
    return this.undoStack;
  }

  /** Runs `fn` as a single undoable transaction. Nesting is supported. */
  transaction<T>(label: string, fn: () => T): T {
    if (this.depth++ === 0) {
      this.label = label;
      this.world.beginBatch();
    }
    let result: T;
    try {
      result = fn();
    } catch (err) {
      if (--this.depth === 0) {
        this.world.endBatch();
        this.emit();
      }
      throw err;
    }
    if (--this.depth === 0) this.commit();
    return result;
  }

  private commit(): void {
    const changes = this.world.endBatch();
    if (changes.length === 0) {
      this.emit();
      return;
    }
    const entry: HistoryEntry = {
      id: ++this.seq,
      label: this.label,
      changes,
      timestamp: Date.now(),
    };
    this.undoStack.push(entry);
    this.recorded += changes.length;
    this.redoStack.length = 0;
    this.trim();
    this.events.emit('applied', { entry, direction: 'do' });
    this.emit();
  }

  private trim(): void {
    while (this.undoStack.length > this.maxEntries || this.recorded > this.maxChanges) {
      const dropped = this.undoStack.shift();
      if (!dropped) break;
      this.recorded -= dropped.changes.length;
    }
  }

  undo(): HistoryEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.world.applyChanges(entry.changes, 'backward');
    this.redoStack.push(entry);
    this.recorded -= entry.changes.length;
    this.events.emit('applied', { entry, direction: 'undo' });
    this.emit();
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.world.applyChanges(entry.changes, 'forward');
    this.undoStack.push(entry);
    this.recorded += entry.changes.length;
    this.events.emit('applied', { entry, direction: 'redo' });
    this.emit();
    return entry;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.recorded = 0;
    this.emit();
  }

  private emit(): void {
    this.events.emit('changed', {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLabel: this.undoStack.at(-1)?.label,
      redoLabel: this.redoStack.at(-1)?.label,
    });
  }
}
