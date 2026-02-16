/**
 * Shared context building for both browser and hub agents.
 * Pure data transforms — no I/O.
 */

export interface TerseEntry {
  ts: number;
  turnId: string;    // "t1", "t2", etc.
  role: 'assistant' | 'subagent';
  summary: string;
}

export interface ContextBuildOptions {
  contextMode: 'slim' | 'full';
  maxTerseEntries: number;    // default 50
  fullContextTurns: number;   // default 3
}

/**
 * Extract terse summary from an assistant message.
 * Looks for <terse>...</terse> tags in text content blocks.
 * If multiple matches, uses the last one.
 */
export function extractTerseSummary(message: Record<string, unknown>): string | null {
  const regex = /<terse>([\s\S]*?)<\/terse>/g;
  let lastMatch: string | null = null;

  const content = message.content;
  if (typeof content === 'string') {
    let match;
    while ((match = regex.exec(content)) !== null) {
      lastMatch = match[1];
    }
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null && (block as any).type === 'text' && typeof (block as any).text === 'string') {
        let match;
        while ((match = regex.exec((block as any).text)) !== null) {
          lastMatch = match[1];
        }
      }
    }
  }

  return lastMatch;
}

/**
 * Build context messages for LLM from terse log + full history.
 * Pure data transform — no I/O. Caller provides the data.
 *
 * In 'slim' mode:
 *   1. Identify last K turn IDs from fullHistory
 *   2. Filter terse entries to exclude those K turn IDs
 *   3. Format remaining terse as activity log with turn IDs
 *   4. Build: [terse_user_msg, terse_assistant_ack, ...full_recent_messages]
 *
 * In 'full' mode:
 *   Return all fullHistory messages (no terse injection).
 */
export function buildContextMessages(
  terseEntries: TerseEntry[],
  fullHistory: Array<Record<string, unknown>>,
  options: ContextBuildOptions,
): Array<Record<string, unknown>> {
  if (options.contextMode === 'full') {
    return [...fullHistory];
  }

  // Slim mode: terse log + last K full turns + current turn messages

  // Find distinct turnIds in fullHistory, preserving order of first appearance
  const seenTurnIds: string[] = [];
  const seenSet = new Set<string>();
  for (const msg of fullHistory) {
    const turnId = msg.turnId as string | undefined;
    if (turnId && !seenSet.has(turnId)) {
      seenSet.add(turnId);
      seenTurnIds.push(turnId);
    }
  }

  // Last K turn IDs to include as full messages
  const K = options.fullContextTurns;
  const recentTurnIds = new Set(seenTurnIds.slice(-K));

  // Filter terse entries: exclude recent turn IDs, take last maxTerseEntries
  const filteredTerse = terseEntries
    .filter(e => !recentTurnIds.has(e.turnId))
    .slice(-options.maxTerseEntries);

  const result: Array<Record<string, unknown>> = [];

  // Add terse log as user/assistant pair
  if (filteredTerse.length > 0) {
    const terseText = filteredTerse.map(e => {
      const time = new Date(e.ts).toISOString().slice(0, 16);
      return `[${e.turnId} ${time}] ${e.role}: ${e.summary}`;
    }).join('\n');
    result.push({
      role: 'user',
      content: `[Context — Activity Log]\n${terseText}`,
    });
    result.push({
      role: 'assistant',
      content: 'Understood, I have the activity log context.',
    });
  }

  // Add full messages from recent turns
  for (const msg of fullHistory) {
    const turnId = msg.turnId as string | undefined;
    if (turnId && recentTurnIds.has(turnId)) {
      result.push(msg);
    }
  }

  return result;
}
