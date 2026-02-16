/**
 * CLI output formatting utilities
 */

export interface TableColumn {
  header: string;
  key: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  format?: (value: unknown) => string;
}

export interface OutputOptions {
  json?: boolean;
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return value.toLocaleString();
    }
    return value.toFixed(4);
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(', ') : '-';
  }
  return String(value);
}

/**
 * Truncate or pad a string to a specific width
 */
function fitToWidth(str: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  if (str.length > width) {
    return str.slice(0, width - 1) + '…';
  }

  const padding = width - str.length;

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + str;
    case 'center': {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + str + ' '.repeat(right);
    }
    default:
      return str + ' '.repeat(padding);
  }
}

/**
 * Calculate column widths based on content
 */
function calculateWidths(
  columns: TableColumn[],
  rows: object[],
): number[] {
  const widths: number[] = [];

  for (const col of columns) {
    if (col.width) {
      widths.push(col.width);
      continue;
    }

    // Start with header width
    let maxWidth = col.header.length;

    // Check all row values
    for (const row of rows) {
      const rowRecord = row as Record<string, unknown>;
      const value = col.format
        ? col.format(rowRecord[col.key])
        : formatValue(rowRecord[col.key]);
      maxWidth = Math.max(maxWidth, value.length);
    }

    // Cap at reasonable maximum
    widths.push(Math.min(maxWidth, 40));
  }

  return widths;
}

/**
 * Format data as a table
 */
export function formatTable(
  columns: TableColumn[],
  rows: object[],
): string {
  if (rows.length === 0) {
    return 'No data';
  }

  const widths = calculateWidths(columns, rows);
  const lines: string[] = [];

  // Header row
  const headerParts: string[] = [];
  for (let i = 0; i < columns.length; i++) {
    headerParts.push(fitToWidth(columns[i].header, widths[i], 'left'));
  }
  lines.push(headerParts.join('  '));

  // Separator
  const separatorParts: string[] = [];
  for (const w of widths) {
    separatorParts.push('─'.repeat(w));
  }
  lines.push(separatorParts.join('──'));

  // Data rows
  for (const row of rows) {
    const rowRecord = row as Record<string, unknown>;
    const rowParts: string[] = [];
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const value = col.format
        ? col.format(rowRecord[col.key])
        : formatValue(rowRecord[col.key]);
      rowParts.push(fitToWidth(value, widths[i], col.align ?? 'left'));
    }
    lines.push(rowParts.join('  '));
  }

  return lines.join('\n');
}

/**
 * Format data as JSON
 */
export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format output based on options
 */
export function output(
  data: unknown,
  columns: TableColumn[] | null,
  options: OutputOptions,
): void {
  if (options.json) {
    console.log(formatJson(data));
    return;
  }

  if (columns && Array.isArray(data)) {
    console.log(formatTable(columns, data as Record<string, unknown>[]));
    return;
  }

  // Simple key-value output for objects
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const maxKeyLen = Math.max(...Object.keys(obj).map((k) => k.length));
    for (const [key, value] of Object.entries(obj)) {
      console.log(`${key.padEnd(maxKeyLen)}  ${formatValue(value)}`);
    }
    return;
  }

  // Fallback to simple string output
  console.log(String(data));
}

/**
 * Format a duration in milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format a timestamp to local time string
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * Format cost in dollars
 */
export function formatCost(value: unknown): string {
  const cost = typeof value === 'number' ? value : 0;
  if (cost < 0.01) {
    return `$${cost.toFixed(6)}`;
  }
  return `$${cost.toFixed(4)}`;
}

/**
 * Print a success message
 */
export function success(message: string): void {
  console.log(`✓ ${message}`);
}

/**
 * Print an error message
 */
export function error(message: string): void {
  console.error(`✗ ${message}`);
}

/**
 * Print a warning message
 */
export function warn(message: string): void {
  console.warn(`! ${message}`);
}

/**
 * Print an info message
 */
export function info(message: string): void {
  console.log(`→ ${message}`);
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
