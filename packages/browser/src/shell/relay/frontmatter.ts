/**
 * Extract YAML frontmatter from content between --- delimiters.
 * Supports flat key-value pairs: strings, numbers, booleans, quoted strings, inline arrays.
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  if (!content) return null;
  const match = content.match(/^---[ \t]*[\r\n]+([\s\S]*?)[\r\n]+---/);
  if (!match) return null;

  const result: Record<string, unknown> = {};
  const lines = match[1].split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(':')) continue;
    const colonIdx = trimmed.indexOf(':');
    const key = trimmed.slice(0, colonIdx).trim();
    const raw = trimmed.slice(colonIdx + 1).trim();

    if (raw === 'true') { result[key] = true; continue; }
    if (raw === 'false') { result[key] = false; continue; }

    // Quoted string
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      result[key] = raw.slice(1, -1);
      continue;
    }

    // Inline array
    if (raw.startsWith('[') && raw.endsWith(']')) {
      result[key] = raw.slice(1, -1).split(',').map(s => s.trim());
      continue;
    }

    // Number
    const num = Number(raw);
    if (!isNaN(num) && raw !== '') { result[key] = num; continue; }

    // Plain string
    result[key] = raw;
  }

  return result;
}

/**
 * Simple glob matching for filenames. Supports * wildcard.
 * Flat only — no ** or directory traversal.
 */
export function simpleGlobMatch(pattern: string, filename: string): boolean {
  if (!pattern.includes('*')) return pattern === filename;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filename);
}
