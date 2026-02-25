/**
 * Compress stale browse accessibility trees in context messages.
 *
 * After browse/intervene interactions, the API context contains multiple
 * accessibility trees (2-10KB each). Only the LAST tree is actionable —
 * element refs (e1, e2, ...) change with every page interaction.
 *
 * This module replaces all older browse results and intervention snapshots
 * with one-line summaries, keeping only the latest tree intact.
 */

/**
 * Extract URL and title from a browse result string.
 * Returns null if the content doesn't match the browse result pattern.
 */
function extractBrowseMetadata(content: string): { url: string; title: string } | null {
  const lines = content.split('\n');
  // Browse results start with "URL: ..." then "Title: ..."
  // May have bot protection prefix before URL line
  let urlIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith('URL: ')) { urlIdx = i; break; }
  }
  if (urlIdx < 0) return null;
  const titleLine = lines[urlIdx + 1];
  if (!titleLine?.startsWith('Title: ')) return null;
  return {
    url: lines[urlIdx].slice(5).trim(),
    title: titleLine.slice(7).trim(),
  };
}

/**
 * Check if a tool_result content string is a browse result with an a11y tree.
 * Must have URL + Title + blank line + tree (line starting with "- ").
 */
function isBrowseResult(content: string): boolean {
  const meta = extractBrowseMetadata(content);
  if (!meta) return false;
  // Must have a tree after the metadata (blank line + "- " prefix)
  return /\n\n- /.test(content);
}

/**
 * Compress a browse tool_result to just metadata.
 */
function compressBrowseToolResult(content: string): string {
  const meta = extractBrowseMetadata(content);
  if (!meta) return content;
  return `Browsed: ${meta.title} (${meta.url})`;
}

/**
 * Truncate an intervention notification's "Current page state:" section
 * to just URL + Title, removing the accessibility tree.
 */
function compressInterventionTree(text: string): string {
  const marker = '\nCurrent page state:\n';
  const idx = text.indexOf(marker);
  if (idx < 0) return text;
  const afterMarker = text.slice(idx + marker.length);
  const meta = extractBrowseMetadata(afterMarker);
  if (!meta) return text;
  // Keep everything up to and including Title line
  return text.slice(0, idx) + marker + `URL: ${meta.url}\nTitle: ${meta.title}`;
}

/**
 * Compress stale browse accessibility trees in context messages.
 * Only the LAST tree is kept intact; earlier ones become one-line summaries.
 * Does not mutate input — returns a new array.
 */
export function compressBrowseResults(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  // Phase 1: Find all browse result locations (tool_result and intervention text)
  type TreeLocation = { msgIdx: number; blockIdx: number; kind: 'tool_result' | 'intervention' };
  const locations: TreeLocation[] = [];

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j] as Record<string, unknown>;
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        if (isBrowseResult(block.content as string)) {
          locations.push({ msgIdx: i, blockIdx: j, kind: 'tool_result' });
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        if ((block.text as string).includes('\nCurrent page state:\nURL: ')) {
          locations.push({ msgIdx: i, blockIdx: j, kind: 'intervention' });
        }
      }
    }
  }

  if (locations.length <= 1) return messages; // 0 or 1 tree — nothing to compress

  // Phase 2: Keep the LAST location intact, compress all earlier ones
  const stale = new Set(locations.slice(0, -1).map(l => `${l.msgIdx}:${l.blockIdx}`));

  // Deep-copy only messages that need modification
  const result = messages.map((msg, i) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;
    let modified = false;
    const newContent = (content as Array<Record<string, unknown>>).map((block, j) => {
      const key = `${i}:${j}`;
      if (!stale.has(key)) return block;
      modified = true;
      if (block.type === 'tool_result') {
        return { ...block, content: compressBrowseToolResult(block.content as string) };
      } else if (block.type === 'text') {
        return { ...block, text: compressInterventionTree(block.text as string) };
      }
      return block;
    });
    return modified ? { ...msg, content: newContent } : msg;
  });

  return result;
}
