/**
 * Shared context search helpers for both browser and hub agents.
 * These functions perform message searching, range merging, and formatting.
 */

/**
 * Check if any text content in a message matches the query (case-insensitive).
 */
export function messageContains(msg: unknown, query: string): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;

  const content = m.content;
  if (typeof content === 'string') {
    return content.toLowerCase().includes(query);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      // text blocks
      if (b.type === 'text' && typeof b.text === 'string') {
        if ((b.text as string).toLowerCase().includes(query)) return true;
      }
      // tool_use blocks — check name and input
      if (b.type === 'tool_use') {
        if (typeof b.name === 'string' && (b.name as string).toLowerCase().includes(query)) return true;
        if (b.input) {
          const inputStr = JSON.stringify(b.input).toLowerCase();
          if (inputStr.includes(query)) return true;
        }
      }
      // tool_result blocks
      if (b.type === 'tool_result') {
        if (typeof b.content === 'string' && (b.content as string).toLowerCase().includes(query)) return true;
      }
    }
  }
  return false;
}

/**
 * Merge overlapping context windows into ranges.
 * Returns array of [start, end] inclusive pairs.
 */
export function mergeRanges(
  indices: number[],
  before: number,
  after: number,
  total: number,
): Array<[number, number]> {
  if (indices.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  let currentStart = Math.max(0, indices[0] - before);
  let currentEnd = Math.min(total - 1, indices[0] + after);

  for (let i = 1; i < indices.length; i++) {
    const newStart = Math.max(0, indices[i] - before);
    const newEnd = Math.min(total - 1, indices[i] + after);

    if (newStart <= currentEnd + 1) {
      // Overlapping or adjacent — merge
      currentEnd = Math.max(currentEnd, newEnd);
    } else {
      // Gap — push current and start new
      ranges.push([currentStart, currentEnd]);
      currentStart = newStart;
      currentEnd = newEnd;
    }
  }

  ranges.push([currentStart, currentEnd]);
  return ranges;
}

/**
 * Format messages as readable text.
 * Truncates very long tool results.
 */
export function formatMessages(messages: unknown[]): string {
  return messages.map((msg, i) => {
    if (!msg || typeof msg !== 'object') return `[${i}] (unknown)`;
    const m = msg as Record<string, unknown>;
    const role = (m.role as string) || 'unknown';
    const turnId = m.turnId as string | undefined;
    const prefix = turnId ? `[${role} ${turnId}]` : `[${role}]`;

    const content = m.content;
    if (typeof content === 'string') {
      return `${prefix} ${truncate(content, 500)}`;
    }
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') {
          parts.push(truncate(b.text as string, 500));
        } else if (b.type === 'tool_use') {
          parts.push(`[tool: ${b.name}(${truncate(JSON.stringify(b.input), 200)})]`);
        } else if (b.type === 'tool_result') {
          const resultContent = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
          parts.push(`[result: ${truncate(resultContent as string, 200)}]`);
        }
      }
      return `${prefix} ${parts.join(' ')}`;
    }
    return `${prefix} (no content)`;
  }).join('\n');
}

/**
 * Group messages by turnId and retrieve messages for specific turns.
 * Returns messages for the target turn plus optional before/after turns.
 */
export function getMessagesByTurn(
  messages: Array<Record<string, unknown>>,
  targetTurnId: string,
  before: number = 0,
  after: number = 0,
): Array<Record<string, unknown>> {
  // Collect ordered unique turnIds
  const turnOrder: string[] = [];
  const turnSet = new Set<string>();
  for (const msg of messages) {
    const tid = msg.turnId as string | undefined;
    if (tid && !turnSet.has(tid)) {
      turnSet.add(tid);
      turnOrder.push(tid);
    }
  }

  const targetIdx = turnOrder.indexOf(targetTurnId);
  if (targetIdx === -1) return [];

  const startIdx = Math.max(0, targetIdx - before);
  const endIdx = Math.min(turnOrder.length - 1, targetIdx + after);
  const includedTurns = new Set(turnOrder.slice(startIdx, endIdx + 1));

  return messages.filter(msg => {
    const tid = msg.turnId as string | undefined;
    return tid !== undefined && includedTurns.has(tid);
  });
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}
