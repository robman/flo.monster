/**
 * Tests for hub-side storage store and storage tool execution.
 */

import { describe, it, expect, vi } from 'vitest';
import { HubAgentStorageStore, executeHubStorage, hubStorageToolDef } from '../tools/hub-storage.js';

describe('HubAgentStorageStore', () => {
  it('creates with empty data by default', () => {
    const store = new HubAgentStorageStore();
    expect(store.getAll()).toEqual({});
    expect(store.list()).toEqual([]);
  });

  it('creates with initial data', () => {
    const store = new HubAgentStorageStore({ score: 42, name: 'alice' });
    expect(store.get('score')).toBe(42);
    expect(store.get('name')).toBe('alice');
    expect(store.list()).toEqual(['score', 'name']);
  });

  it('initial data is copied (not referenced)', () => {
    const initial = { a: 1, b: 2 };
    const store = new HubAgentStorageStore(initial);
    initial.a = 999;
    expect(store.get('a')).toBe(1);
  });

  it('get() returns value for existing key', () => {
    const store = new HubAgentStorageStore();
    store.set('color', 'blue');
    expect(store.get('color')).toBe('blue');
  });

  it('get() returns undefined for missing key', () => {
    const store = new HubAgentStorageStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('set() stores value and fires onChange', () => {
    const store = new HubAgentStorageStore();
    const cb = vi.fn();
    store.onChange(cb);
    store.set('x', 10);
    expect(store.get('x')).toBe(10);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('x', 10, 'set');
  });

  it('set() overwrites existing value', () => {
    const store = new HubAgentStorageStore();
    store.set('key', 'old');
    store.set('key', 'new');
    expect(store.get('key')).toBe('new');
  });

  it('set() stores complex values (arrays, objects)', () => {
    const store = new HubAgentStorageStore();
    store.set('list', [1, 2, 3]);
    store.set('obj', { nested: { deep: true } });
    expect(store.get('list')).toEqual([1, 2, 3]);
    expect(store.get('obj')).toEqual({ nested: { deep: true } });
  });

  it('delete() removes key and returns true', () => {
    const store = new HubAgentStorageStore();
    store.set('x', 10);
    const existed = store.delete('x');
    expect(existed).toBe(true);
    expect(store.get('x')).toBeUndefined();
  });

  it('delete() returns false for non-existent key', () => {
    const store = new HubAgentStorageStore();
    const existed = store.delete('missing');
    expect(existed).toBe(false);
  });

  it('delete() fires onChange with delete action', () => {
    const store = new HubAgentStorageStore();
    store.set('x', 10);
    const cb = vi.fn();
    store.onChange(cb);
    store.delete('x');
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('x', 10, 'delete');
  });

  it('delete() fires onChange even for non-existent key (value is undefined)', () => {
    const store = new HubAgentStorageStore();
    const cb = vi.fn();
    store.onChange(cb);
    store.delete('missing');
    expect(cb).toHaveBeenCalledWith('missing', undefined, 'delete');
  });

  it('list() returns all keys', () => {
    const store = new HubAgentStorageStore();
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);
    expect(store.list()).toEqual(['a', 'b', 'c']);
  });

  it('list() reflects deletions', () => {
    const store = new HubAgentStorageStore();
    store.set('a', 1);
    store.set('b', 2);
    store.delete('a');
    expect(store.list()).toEqual(['b']);
  });

  it('getAll() returns copy of all data', () => {
    const store = new HubAgentStorageStore();
    store.set('a', 1);
    store.set('b', 2);
    const all = store.getAll();
    expect(all).toEqual({ a: 1, b: 2 });
    // Verify it is a copy
    all.a = 999;
    expect(store.get('a')).toBe(1);
  });

  it('onChange callback receives key, value, action', () => {
    const store = new HubAgentStorageStore();
    const cb = vi.fn();
    store.onChange(cb);

    store.set('name', 'alice');
    expect(cb).toHaveBeenCalledWith('name', 'alice', 'set');

    store.delete('name');
    expect(cb).toHaveBeenCalledWith('name', 'alice', 'delete');
  });

  it('onChange returns unsubscribe function', () => {
    const store = new HubAgentStorageStore();
    const cb = vi.fn();
    const unsub = store.onChange(cb);

    store.set('a', 1);
    expect(cb).toHaveBeenCalledOnce();

    unsub();
    store.set('b', 2);
    // Should not have been called again after unsubscribe
    expect(cb).toHaveBeenCalledOnce();
  });

  it('multiple onChange callbacks all fire', () => {
    const store = new HubAgentStorageStore();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();
    store.onChange(cb1);
    store.onChange(cb2);
    store.onChange(cb3);

    store.set('key', 'value');
    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
    expect(cb3).toHaveBeenCalledOnce();
  });

  it('serialize() returns copy of data', () => {
    const store = new HubAgentStorageStore();
    store.set('a', 1);
    store.set('b', 'two');
    const serialized = store.serialize();
    expect(serialized).toEqual({ a: 1, b: 'two' });
    // Verify it is a copy
    serialized.a = 999;
    expect(store.get('a')).toBe(1);
  });

  it('roundtrip: serialize then construct new store from serialized data', () => {
    const store = new HubAgentStorageStore();
    store.set('counter', 42);
    store.set('items', ['apple', 'banana']);
    store.set('config', { theme: 'dark', fontSize: 14 });

    const serialized = store.serialize();
    const restored = new HubAgentStorageStore(serialized);

    expect(restored.get('counter')).toBe(42);
    expect(restored.get('items')).toEqual(['apple', 'banana']);
    expect(restored.get('config')).toEqual({ theme: 'dark', fontSize: 14 });
    expect(restored.getAll()).toEqual({
      counter: 42,
      items: ['apple', 'banana'],
      config: { theme: 'dark', fontSize: 14 },
    });
    expect(restored.list()).toEqual(['counter', 'items', 'config']);
  });
});

describe('executeHubStorage', () => {
  it('get action returns value', () => {
    const store = new HubAgentStorageStore();
    store.set('score', 42);
    const result = executeHubStorage({ action: 'get', key: 'score' }, store);
    expect(result.content).toBe('42');
    expect(result.is_error).toBeUndefined();
  });

  it('get action returns string values', () => {
    const store = new HubAgentStorageStore();
    store.set('name', 'Alice');
    const result = executeHubStorage({ action: 'get', key: 'name' }, store);
    expect(result.content).toBe('"Alice"');
  });

  it('get action returns complex values as JSON', () => {
    const store = new HubAgentStorageStore();
    store.set('data', { list: [1, 2, 3] });
    const result = executeHubStorage({ action: 'get', key: 'data' }, store);
    expect(JSON.parse(result.content)).toEqual({ list: [1, 2, 3] });
  });

  it('get action returns "Key not found" for missing key', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'get', key: 'missing' }, store);
    expect(result.content).toBe('Key not found');
    expect(result.is_error).toBeUndefined();
  });

  it('get action with missing key param returns error', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'get' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('set action stores value', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'set', key: 'color', value: 'red' }, store);
    expect(result.content).toBe('Value stored');
    expect(result.is_error).toBeUndefined();
    expect(store.get('color')).toBe('red');
  });

  it('set action with missing key returns error', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'set', value: 'orphan' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('set action stores undefined value when no value provided', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'set', key: 'empty' }, store);
    expect(result.content).toBe('Value stored');
    expect(store.get('empty')).toBeUndefined();
  });

  it('delete action removes key and returns "Key deleted"', () => {
    const store = new HubAgentStorageStore();
    store.set('temp', 'data');
    const result = executeHubStorage({ action: 'delete', key: 'temp' }, store);
    expect(result.content).toBe('Key deleted');
    expect(result.is_error).toBeUndefined();
    expect(store.get('temp')).toBeUndefined();
  });

  it('delete action returns "Key not found" for non-existent key', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'delete', key: 'missing' }, store);
    expect(result.content).toBe('Key not found');
    expect(result.is_error).toBeUndefined();
  });

  it('delete action with missing key param returns error', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'delete' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('list action returns all keys', () => {
    const store = new HubAgentStorageStore();
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);
    const result = executeHubStorage({ action: 'list' }, store);
    expect(JSON.parse(result.content)).toEqual(['a', 'b', 'c']);
    expect(result.is_error).toBeUndefined();
  });

  it('list action returns empty array when no keys', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'list' }, store);
    expect(JSON.parse(result.content)).toEqual([]);
  });

  it('unknown action returns error', () => {
    const store = new HubAgentStorageStore();
    const result = executeHubStorage({ action: 'explode' }, store);
    expect(result.content).toBe('Unknown storage action: explode');
    expect(result.is_error).toBe(true);
  });
});

describe('HubAgentStorageStore limits', () => {
  it('rejects set when max keys exceeded', () => {
    const store = new HubAgentStorageStore({}, { maxKeys: 3 });
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);
    const result = store.set('d', 4);
    expect(result.error).toContain('max 3 keys');
    // Verify the value was NOT stored
    expect(store.get('d')).toBeUndefined();
    expect(store.list()).toEqual(['a', 'b', 'c']);
  });

  it('allows overwriting existing key even at max keys', () => {
    const store = new HubAgentStorageStore({}, { maxKeys: 2 });
    store.set('a', 1);
    store.set('b', 2);
    // Overwriting 'a' should work — not a new key
    const result = store.set('a', 100);
    expect(result.error).toBeUndefined();
    expect(store.get('a')).toBe(100);
  });

  it('rejects set when value size exceeds max', () => {
    const store = new HubAgentStorageStore({}, { maxValueSize: 10 });
    const result = store.set('big', 'a'.repeat(100));
    expect(result.error).toContain('value size');
    expect(result.error).toContain('exceeds max 10');
    expect(store.get('big')).toBeUndefined();
  });

  it('allows value within size limit', () => {
    const store = new HubAgentStorageStore({}, { maxValueSize: 100 });
    const result = store.set('small', 'hi');
    expect(result.error).toBeUndefined();
    expect(store.get('small')).toBe('hi');
  });

  it('rejects set when total size would exceed max', () => {
    const store = new HubAgentStorageStore({}, { maxTotalSize: 50 });
    store.set('a', 'x'.repeat(20)); // ~22 bytes with quotes
    store.set('b', 'y'.repeat(20)); // ~22 bytes with quotes
    // Now total is ~44 bytes. Adding another 20-char string should exceed 50
    const result = store.set('c', 'z'.repeat(20));
    expect(result.error).toContain('total size');
    expect(store.get('c')).toBeUndefined();
  });

  it('allows replacing value even if total is near limit', () => {
    const store = new HubAgentStorageStore({}, { maxTotalSize: 50 });
    store.set('a', 'x'.repeat(20)); // ~22 bytes
    // Replacing 'a' with same-size value should work (old value subtracted)
    const result = store.set('a', 'y'.repeat(20));
    expect(result.error).toBeUndefined();
    expect(store.get('a')).toBe('y'.repeat(20));
  });

  it('uses default limits when none provided', () => {
    const store = new HubAgentStorageStore();
    // Should work fine with default limits (1000 keys, 1MB value, 10MB total)
    const result = store.set('key', 'value');
    expect(result.error).toBeUndefined();
  });

  it('executeHubStorage returns error for exceeded limits', () => {
    const store = new HubAgentStorageStore({}, { maxKeys: 1 });
    store.set('only', 'one');
    const result = executeHubStorage({ action: 'set', key: 'second', value: 'two' }, store);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('max 1 keys');
  });
});

describe('hubStorageToolDef', () => {
  it('has correct name and description', () => {
    expect(hubStorageToolDef.name).toBe('storage');
    expect(hubStorageToolDef.description).toBeTruthy();
    expect(typeof hubStorageToolDef.description).toBe('string');
  });

  it('has all 4 actions in the enum', () => {
    const actionProp = hubStorageToolDef.input_schema.properties.action as {
      type: string;
      enum: string[];
    };
    expect(actionProp.type).toBe('string');
    expect(actionProp.enum).toEqual(['get', 'set', 'delete', 'list']);
  });

  it('requires only action parameter', () => {
    expect(hubStorageToolDef.input_schema.required).toEqual(['action']);
  });

  it('has expected properties in schema', () => {
    const props = Object.keys(hubStorageToolDef.input_schema.properties);
    expect(props).toContain('action');
    expect(props).toContain('key');
    expect(props).toContain('value');
  });
});
