import { describe, it, expect } from 'vitest';
import { generateRequestId } from '../ids.js';

describe('generateRequestId', () => {
  it('starts with the given prefix', () => {
    const id = generateRequestId('dom');
    expect(id.startsWith('dom-')).toBe(true);
  });

  it('contains a timestamp segment', () => {
    const before = Date.now();
    const id = generateRequestId('test');
    const after = Date.now();

    const parts = id.split('-');
    // prefix is parts[0], timestamp is parts[1]
    const timestamp = parseInt(parts[1], 10);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('contains a random suffix', () => {
    const id = generateRequestId('fetch');
    const parts = id.split('-');
    // Random suffix is parts[2]
    expect(parts.length).toBe(3);
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it('generates unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId('test'));
    }
    // All IDs should be unique
    expect(ids.size).toBe(100);
  });

  it('works with different prefixes', () => {
    const domId = generateRequestId('dom');
    const fetchId = generateRequestId('fetch');
    const storageId = generateRequestId('storage');

    expect(domId.startsWith('dom-')).toBe(true);
    expect(fetchId.startsWith('fetch-')).toBe(true);
    expect(storageId.startsWith('storage-')).toBe(true);
  });

  it('works with hyphenated prefixes', () => {
    const id = generateRequestId('capture-dom');
    expect(id.startsWith('capture-dom-')).toBe(true);
  });
});
