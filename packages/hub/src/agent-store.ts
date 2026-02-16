/**
 * Filesystem-based persistence for hub agents.
 *
 * Storage layout:
 *   {storePath}/{hubAgentId}/
 *     session.json   — Full SerializedSession
 *     state.json     — { state, totalTokens, totalCost, savedAt }
 */

import { readFile, writeFile, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SerializedSession } from '@flo-monster/core';
import type { RunnerState } from './agent-runner.js';

export interface AgentStoreState {
  state: RunnerState;
  totalTokens: number;
  totalCost: number;
  savedAt: number;
}

export interface AgentStoreSummary {
  hubAgentId: string;
  agentName: string;
  model: string;
  provider: string;
  state: RunnerState;
  totalCost: number;
  createdAt: number;
  lastActivity: number;
}

// Only allow safe characters in hub agent IDs
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function sanitizeId(id: string): string {
  if (!SAFE_ID_REGEX.test(id)) {
    throw new Error(`Invalid hub agent ID: ${id}`);
  }
  return id;
}

export class AgentStore {
  constructor(private storePath: string) {}

  /**
   * Ensure the store directory exists
   */
  async init(): Promise<void> {
    await mkdir(this.storePath, { recursive: true });
  }

  /**
   * Save agent session and state to disk.
   * Uses atomic write (write to temp file, then rename) to prevent corruption.
   */
  async save(hubAgentId: string, session: SerializedSession, state: AgentStoreState): Promise<void> {
    const safeId = sanitizeId(hubAgentId);
    const agentDir = join(this.storePath, safeId);
    await mkdir(agentDir, { recursive: true });

    // Atomic write for session.json
    const sessionPath = join(agentDir, 'session.json');
    const sessionTmp = join(agentDir, `session.tmp.${Date.now()}`);
    await writeFile(sessionTmp, JSON.stringify(session), { encoding: 'utf-8', mode: 0o600 });
    await rename(sessionTmp, sessionPath);

    // Atomic write for state.json
    const statePath = join(agentDir, 'state.json');
    const stateTmp = join(agentDir, `state.tmp.${Date.now()}`);
    await writeFile(stateTmp, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
    await rename(stateTmp, statePath);
  }

  /**
   * Load agent session and state from disk.
   */
  async load(hubAgentId: string): Promise<{ session: SerializedSession; state: AgentStoreState } | null> {
    const safeId = sanitizeId(hubAgentId);
    const agentDir = join(this.storePath, safeId);

    try {
      const sessionData = await readFile(join(agentDir, 'session.json'), 'utf-8');
      const stateData = await readFile(join(agentDir, 'state.json'), 'utf-8');
      return {
        session: JSON.parse(sessionData) as SerializedSession,
        state: JSON.parse(stateData) as AgentStoreState,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Delete an agent's persisted data.
   */
  async delete(hubAgentId: string): Promise<void> {
    const safeId = sanitizeId(hubAgentId);
    const agentDir = join(this.storePath, safeId);
    try {
      await rm(agentDir, { recursive: true, force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * List all persisted agents with summary info.
   */
  async list(): Promise<AgentStoreSummary[]> {
    const summaries: AgentStoreSummary[] = [];

    let entries: string[];
    try {
      entries = await readdir(this.storePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    for (const entry of entries) {
      if (!SAFE_ID_REGEX.test(entry)) continue;

      try {
        const data = await this.load(entry);
        if (!data) continue;

        summaries.push({
          hubAgentId: entry,
          agentName: data.session.config.name,
          model: data.session.config.model,
          provider: data.session.config.provider || 'anthropic',
          state: data.state.state,
          totalCost: data.state.totalCost,
          createdAt: data.session.metadata.createdAt,
          lastActivity: data.state.savedAt,
        });
      } catch {
        // Skip corrupted entries
        console.warn(`[AgentStore] Skipping corrupted entry: ${entry}`);
      }
    }

    return summaries;
  }

  /**
   * Check if an agent exists in the store.
   */
  exists(hubAgentId: string): boolean {
    const safeId = sanitizeId(hubAgentId);
    return existsSync(join(this.storePath, safeId, 'session.json'));
  }
}
