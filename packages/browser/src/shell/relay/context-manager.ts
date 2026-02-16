import type { AgentStorageProvider } from '../../storage/agent-storage.js';
import {
  extractTerseSummary,
  buildContextMessages,
  type TerseEntry,
  type ContextBuildOptions,
} from '@flo-monster/core';

// Re-export from core for backwards compatibility
export { extractTerseSummary, type TerseEntry };

const TERSE_FILE = 'context.terse.json';

interface TerseFileData {
  entries: TerseEntry[];
  nextTurnId: number;
}

/**
 * Load terse file data, handling migration from old array format.
 */
async function loadTerseFileData(
  agentId: string,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<TerseFileData> {
  try {
    const provider = await getProvider();
    const content = await provider.readFile(agentId, TERSE_FILE);
    const parsed = JSON.parse(content);

    // Migration: old format was a plain array of entries (without turnId)
    if (Array.isArray(parsed)) {
      const entries: TerseEntry[] = parsed.map((e: any, i: number) => ({
        ts: e.ts,
        turnId: `t${i + 1}`,
        role: e.role,
        summary: e.summary,
      }));
      return { entries, nextTurnId: entries.length + 1 };
    }

    // New format: { entries, nextTurnId }
    return parsed as TerseFileData;
  } catch {
    return { entries: [], nextTurnId: 1 };
  }
}

/**
 * Save terse file data.
 */
async function saveTerseFileData(
  agentId: string,
  data: TerseFileData,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<void> {
  const provider = await getProvider();
  await provider.writeFile(agentId, TERSE_FILE, JSON.stringify(data));
}

/**
 * Generate the next turn ID for an agent. Returns "t1", "t2", etc.
 * Increments the counter in the terse file.
 */
export async function generateTurnId(
  agentId: string,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<string> {
  const data = await loadTerseFileData(agentId, getProvider);
  const turnId = `t${data.nextTurnId}`;
  data.nextTurnId++;
  await saveTerseFileData(agentId, data, getProvider);
  return turnId;
}

/**
 * Append a terse summary entry to context.terse.json.
 * Creates the file if it doesn't exist. Catches errors internally.
 */
export async function appendTerseSummary(
  agentId: string,
  summary: string,
  role: 'assistant' | 'subagent',
  turnId: string,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<void> {
  try {
    const data = await loadTerseFileData(agentId, getProvider);
    data.entries.push({ ts: Date.now(), turnId, role, summary });
    await saveTerseFileData(agentId, data, getProvider);
  } catch (err) {
    console.error('[ContextManager] Failed to append terse summary:', err);
  }
}

/**
 * Load terse context entries from context.terse.json.
 * Returns [] on any error.
 */
export async function loadTerseContext(
  agentId: string,
  getProvider: () => Promise<AgentStorageProvider>,
): Promise<TerseEntry[]> {
  try {
    const data = await loadTerseFileData(agentId, getProvider);
    return data.entries;
  } catch {
    return [];
  }
}

export interface SlimContextOptions {
  maxTerseEntries: number;  // default 50
}

/**
 * Build slim context for API calls.
 * @deprecated Use buildContextMessages from @flo-monster/core instead.
 */
export async function buildSlimContext(
  agentId: string,
  getProvider: () => Promise<AgentStorageProvider>,
  options?: Partial<SlimContextOptions>,
): Promise<unknown[]> {
  const opts: SlimContextOptions = { maxTerseEntries: 50, ...options };
  const messages: unknown[] = [];

  const terseEntries = await loadTerseContext(agentId, getProvider);
  if (terseEntries.length > 0) {
    const recent = terseEntries.slice(-opts.maxTerseEntries);
    const terseText = recent.map(e => {
      const time = new Date(e.ts).toISOString().slice(0, 16);
      const turnPrefix = e.turnId ? `${e.turnId} ` : '';
      return `[${turnPrefix}${time}] ${e.role}: ${e.summary}`;
    }).join('\n');
    messages.push({
      role: 'user',
      content: `[Context — Activity Log]\n${terseText}`,
    });
    messages.push({
      role: 'assistant',
      content: 'Understood, I have the activity log context.',
    });
  }

  return messages;
}
