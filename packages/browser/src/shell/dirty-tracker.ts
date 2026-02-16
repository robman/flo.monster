/**
 * Tracks per-agent dirty state for auto-save.
 * An agent is "dirty" when it has unsaved changes since the last persist/save.
 */

export type DirtyReason = 'message' | 'file' | 'dom' | 'storage' | 'config';

interface DirtyEntry {
  reasons: Set<DirtyReason>;
  dirtyAt: number;
  lastSaveAt: number;
}

export type DirtyChangeCallback = (agentId: string, isDirty: boolean) => void;

export class DirtyTracker {
  private entries = new Map<string, DirtyEntry>();
  private callbacks = new Set<DirtyChangeCallback>();

  markDirty(agentId: string, reason: DirtyReason): void {
    let entry = this.entries.get(agentId);
    const wasDirty = !!entry && entry.reasons.size > 0;
    if (!entry) {
      entry = { reasons: new Set(), dirtyAt: Date.now(), lastSaveAt: 0 };
      this.entries.set(agentId, entry);
    }
    entry.reasons.add(reason);
    if (!entry.dirtyAt) {
      entry.dirtyAt = Date.now();
    }
    if (!wasDirty) {
      this.notifyCallbacks(agentId, true);
    }
  }

  markClean(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry && entry.reasons.size > 0) {
      entry.reasons.clear();
      entry.dirtyAt = 0;
      entry.lastSaveAt = Date.now();
      this.notifyCallbacks(agentId, false);
    }
  }

  isDirty(agentId: string): boolean {
    const entry = this.entries.get(agentId);
    return !!entry && entry.reasons.size > 0;
  }

  hasAnyDirty(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.reasons.size > 0) return true;
    }
    return false;
  }

  getDirtyAgents(): string[] {
    const result: string[] = [];
    for (const [agentId, entry] of this.entries) {
      if (entry.reasons.size > 0) {
        result.push(agentId);
      }
    }
    return result;
  }

  getDirtyReasons(agentId: string): DirtyReason[] {
    const entry = this.entries.get(agentId);
    return entry ? [...entry.reasons] : [];
  }

  getTimeSinceLastSave(agentId: string): number {
    const entry = this.entries.get(agentId);
    if (!entry || entry.lastSaveAt === 0) return Infinity;
    return Date.now() - entry.lastSaveAt;
  }

  getTimeSinceDirty(agentId: string): number {
    const entry = this.entries.get(agentId);
    if (!entry || entry.dirtyAt === 0) return Infinity;
    return Date.now() - entry.dirtyAt;
  }

  onChange(callback: DirtyChangeCallback): () => void {
    this.callbacks.add(callback);
    return () => { this.callbacks.delete(callback); };
  }

  removeAgent(agentId: string): void {
    const wasDirty = this.isDirty(agentId);
    this.entries.delete(agentId);
    if (wasDirty) {
      this.notifyCallbacks(agentId, false);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private notifyCallbacks(agentId: string, isDirty: boolean): void {
    for (const cb of this.callbacks) {
      try { cb(agentId, isDirty); } catch { /* ignore */ }
    }
  }
}
