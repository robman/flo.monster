/**
 * Tests for CLI output formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatTable,
  formatJson,
  formatDuration,
  formatTimestamp,
  formatBytes,
  formatCost,
  success,
  error,
  warn,
  info,
  type TableColumn,
} from '../output.js';

describe('output formatting', () => {
  describe('formatTable', () => {
    const columns: TableColumn[] = [
      { header: 'Name', key: 'name', width: 10 },
      { header: 'Value', key: 'value', align: 'right' },
    ];

    it('should format empty array', () => {
      const result = formatTable(columns, []);
      expect(result).toBe('No data');
    });

    it('should format simple table', () => {
      const rows = [
        { name: 'Alice', value: 100 },
        { name: 'Bob', value: 200 },
      ];

      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      expect(lines.length).toBe(4); // Header, separator, 2 data rows
      expect(lines[0]).toContain('Name');
      expect(lines[0]).toContain('Value');
      expect(lines[1]).toContain('─');
      expect(lines[2]).toContain('Alice');
      expect(lines[3]).toContain('Bob');
    });

    it('should respect column alignment', () => {
      const rows = [{ name: 'Test', value: 1 }];
      const result = formatTable(columns, rows);
      const lines = result.split('\n');

      // Right-aligned value should have padding on the left
      const dataLine = lines[2];
      expect(dataLine).toMatch(/Test.*\s+1/);
    });

    it('should use custom format function', () => {
      const columnsWithFormat: TableColumn[] = [
        { header: 'Name', key: 'name' },
        { header: 'Cost', key: 'cost', format: (v) => `$${v}` },
      ];

      const rows = [{ name: 'Item', cost: 100 }];
      const result = formatTable(columnsWithFormat, rows);

      expect(result).toContain('$100');
    });

    it('should truncate long values', () => {
      const narrowColumns: TableColumn[] = [
        { header: 'Name', key: 'name', width: 5 },
      ];

      const rows = [{ name: 'VeryLongName' }];
      const result = formatTable(narrowColumns, rows);

      expect(result).toContain('Very…');
    });

    it('should handle null/undefined values', () => {
      const rows = [
        { name: null, value: undefined },
      ];

      const result = formatTable(columns, rows);
      expect(result).toContain('-');
    });

    it('should handle array values', () => {
      const columnsWithArray: TableColumn[] = [
        { header: 'Items', key: 'items' },
      ];

      const rows = [
        { items: ['a', 'b', 'c'] },
        { items: [] },
      ];

      const result = formatTable(columnsWithArray, rows);
      expect(result).toContain('a, b, c');
      expect(result).toContain('-');
    });

    it('should handle boolean values', () => {
      const columnsWithBool: TableColumn[] = [
        { header: 'Active', key: 'active' },
      ];

      const rows = [
        { active: true },
        { active: false },
      ];

      const result = formatTable(columnsWithBool, rows);
      expect(result).toContain('Yes');
      expect(result).toContain('No');
    });
  });

  describe('formatJson', () => {
    it('should format object as indented JSON', () => {
      const result = formatJson({ name: 'test', value: 123 });
      expect(result).toContain('"name": "test"');
      expect(result).toContain('"value": 123');
      expect(result.split('\n').length).toBeGreaterThan(1);
    });

    it('should format array as JSON', () => {
      const result = formatJson([1, 2, 3]);
      expect(result).toBe('[\n  1,\n  2,\n  3\n]');
    });
  });

  describe('formatDuration', () => {
    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5s');
      expect(formatDuration(30000)).toBe('30s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(300000)).toBe('5m 0s');
    });

    it('should format hours and minutes', () => {
      expect(formatDuration(3600000)).toBe('1h 0m');
      expect(formatDuration(5400000)).toBe('1h 30m');
    });

    it('should format days and hours', () => {
      expect(formatDuration(86400000)).toBe('1d 0h');
      expect(formatDuration(90000000)).toBe('1d 1h');
    });
  });

  describe('formatTimestamp', () => {
    it('should format timestamp as locale string', () => {
      const timestamp = new Date('2024-01-15T10:30:00').getTime();
      const result = formatTimestamp(timestamp);
      expect(result).toContain('2024');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(2048)).toBe('2.0 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1.0 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1.0 GB');
    });
  });

  describe('formatCost', () => {
    it('should format small costs with more precision', () => {
      expect(formatCost(0.001234)).toBe('$0.001234');
    });

    it('should format larger costs with less precision', () => {
      expect(formatCost(1.2345)).toBe('$1.2345');
    });

    it('should handle zero', () => {
      expect(formatCost(0)).toBe('$0.000000');
    });

    it('should handle unknown values', () => {
      expect(formatCost('not a number' as unknown)).toBe('$0.000000');
    });
  });

  describe('message helpers', () => {
    let consoleSpy: {
      log: ReturnType<typeof vi.spyOn>;
      error: ReturnType<typeof vi.spyOn>;
      warn: ReturnType<typeof vi.spyOn>;
    };

    beforeEach(() => {
      consoleSpy = {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should print success message with checkmark', () => {
      success('Operation completed');
      expect(consoleSpy.log).toHaveBeenCalledWith('✓ Operation completed');
    });

    it('should print error message with X', () => {
      error('Something went wrong');
      expect(consoleSpy.error).toHaveBeenCalledWith('✗ Something went wrong');
    });

    it('should print warning message', () => {
      warn('Be careful');
      expect(consoleSpy.warn).toHaveBeenCalledWith('! Be careful');
    });

    it('should print info message', () => {
      info('FYI');
      expect(consoleSpy.log).toHaveBeenCalledWith('→ FYI');
    });
  });
});
