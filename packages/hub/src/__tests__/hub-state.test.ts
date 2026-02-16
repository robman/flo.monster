/**
 * Tests for hub-side state store and state tool execution.
 */

import { describe, it, expect, vi } from 'vitest';
import { HubAgentStateStore, executeHubState, hubStateToolDef } from '../tools/hub-state.js';

describe('HubAgentStateStore', () => {
  it('creates with empty state by default', () => {
    const store = new HubAgentStateStore();
    expect(store.getAll()).toEqual({});
    expect(store.getEscalationRules()).toEqual([]);
  });

  it('creates with initial data', () => {
    const store = new HubAgentStateStore({
      state: { score: 42, name: 'alice' },
      escalationRules: { score: { condition: 'val > 100', message: 'High score' } },
    });
    expect(store.get('score')).toBe(42);
    expect(store.get('name')).toBe('alice');
    expect(store.getEscalationRules()).toHaveLength(1);
    expect(store.getEscalationRules()[0]).toEqual({
      key: 'score',
      condition: 'val > 100',
      message: 'High score',
    });
  });

  it('get() returns value for existing key', () => {
    const store = new HubAgentStateStore();
    store.set('color', 'blue');
    expect(store.get('color')).toBe('blue');
  });

  it('get() returns undefined for missing key', () => {
    const store = new HubAgentStateStore();
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('getAll() returns copy of all state', () => {
    const store = new HubAgentStateStore();
    store.set('a', 1);
    store.set('b', 2);
    const all = store.getAll();
    expect(all).toEqual({ a: 1, b: 2 });
    // Verify it is a copy - modifying returned object should not affect store
    all.a = 999;
    expect(store.get('a')).toBe(1);
  });

  it('set() stores value and fires onChange', () => {
    const store = new HubAgentStateStore();
    const cb = vi.fn();
    store.onChange(cb);
    store.set('x', 10);
    expect(store.get('x')).toBe(10);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('x', 10, 'set');
  });

  it('delete() removes key and fires onChange', () => {
    const store = new HubAgentStateStore();
    store.set('x', 10);
    const cb = vi.fn();
    store.onChange(cb);
    store.delete('x');
    expect(store.get('x')).toBeUndefined();
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('x', 10, 'delete');
  });

  it('delete() on non-existent key does not error', () => {
    const store = new HubAgentStateStore();
    const cb = vi.fn();
    store.onChange(cb);
    expect(() => store.delete('missing')).not.toThrow();
    // Still fires onChange even for non-existent key (value is undefined)
    expect(cb).toHaveBeenCalledWith('missing', undefined, 'delete');
  });

  it('onChange callback receives key, value, action', () => {
    const store = new HubAgentStateStore();
    const cb = vi.fn();
    store.onChange(cb);

    store.set('name', 'alice');
    expect(cb).toHaveBeenCalledWith('name', 'alice', 'set');

    store.delete('name');
    expect(cb).toHaveBeenCalledWith('name', 'alice', 'delete');
  });

  it('onChange returns unsubscribe function', () => {
    const store = new HubAgentStateStore();
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
    const store = new HubAgentStateStore();
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

  it('setEscalation() stores escalation rule', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'val > 100');
    const rules = store.getEscalationRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ key: 'score', condition: 'val > 100', message: null });
  });

  it('setEscalation() with message stores message', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'val > 100', 'Score is too high');
    const rules = store.getEscalationRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({
      key: 'score',
      condition: 'val > 100',
      message: 'Score is too high',
    });
  });

  it('clearEscalation() removes rule', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'val > 100');
    expect(store.getEscalationRules()).toHaveLength(1);
    store.clearEscalation('score');
    expect(store.getEscalationRules()).toHaveLength(0);
  });

  it('clearEscalation() on non-existent key does not error', () => {
    const store = new HubAgentStateStore();
    expect(() => store.clearEscalation('nonexistent')).not.toThrow();
  });

  it('getEscalationRules() returns all rules', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'val > 100', 'High score');
    store.setEscalation('status', "val === 'done'", 'Task complete');
    store.setEscalation('health', 'always');
    const rules = store.getEscalationRules();
    expect(rules).toHaveLength(3);
    const keys = rules.map((r) => r.key);
    expect(keys).toContain('score');
    expect(keys).toContain('status');
    expect(keys).toContain('health');
  });

  it('evaluateEscalation() with "always" condition returns triggered=true', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('health', 'always', 'Health changed');
    const result = store.evaluateEscalation('health', 50);
    expect(result.triggered).toBe(true);
    expect(result.message).toBe('Health changed');
  });

  it('evaluateEscalation() with numeric comparison', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', '> 100');
    expect(store.evaluateEscalation('score', 150).triggered).toBe(true);
    expect(store.evaluateEscalation('score', 50).triggered).toBe(false);
    expect(store.evaluateEscalation('score', 100).triggered).toBe(false);
  });

  it('evaluateEscalation() with equality', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('status', '== done', 'Finished');
    const triggered = store.evaluateEscalation('status', 'done');
    expect(triggered.triggered).toBe(true);
    expect(triggered.message).toBe('Finished');

    const notTriggered = store.evaluateEscalation('status', 'running');
    expect(notTriggered.triggered).toBe(false);
  });

  it('evaluateEscalation() for non-existent key returns triggered=false', () => {
    const store = new HubAgentStateStore();
    const result = store.evaluateEscalation('no-rule', 42);
    expect(result.triggered).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('evaluateEscalation() with invalid condition returns triggered=false', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('buggy', '!!!invalid js syntax(((');
    const result = store.evaluateEscalation('buggy', 42);
    expect(result.triggered).toBe(false);
  });

  it('serialize() returns current state and escalation rules', () => {
    const store = new HubAgentStateStore();
    store.set('a', 1);
    store.set('b', 'two');
    store.setEscalation('a', 'val > 10', 'Too high');
    const serialized = store.serialize();
    expect(serialized).toEqual({
      state: { a: 1, b: 'two' },
      escalationRules: { a: { condition: 'val > 10', message: 'Too high' } },
    });
  });

  it('roundtrip: serialize then construct new store from serialized data', () => {
    const store = new HubAgentStateStore();
    store.set('counter', 42);
    store.set('items', ['apple', 'banana']);
    store.setEscalation('counter', '> 100', 'Counter exceeded');
    store.setEscalation('status', 'always');

    const serialized = store.serialize();
    const restored = new HubAgentStateStore(serialized);

    expect(restored.get('counter')).toBe(42);
    expect(restored.get('items')).toEqual(['apple', 'banana']);
    expect(restored.getAll()).toEqual({ counter: 42, items: ['apple', 'banana'] });
    expect(restored.getEscalationRules()).toHaveLength(2);
    expect(restored.evaluateEscalation('counter', 200).triggered).toBe(true);
    expect(restored.evaluateEscalation('status', 'anything').triggered).toBe(true);
  });
});

describe('HubAgentStateStore limits', () => {
  it('rejects set when max keys exceeded', () => {
    const store = new HubAgentStateStore(undefined, { maxKeys: 3 });
    store.set('a', 1);
    store.set('b', 2);
    store.set('c', 3);
    const result = store.set('d', 4);
    expect(result.error).toContain('max 3 keys');
    expect(store.get('d')).toBeUndefined();
  });

  it('allows overwriting existing key even at max keys', () => {
    const store = new HubAgentStateStore(undefined, { maxKeys: 2 });
    store.set('a', 1);
    store.set('b', 2);
    const result = store.set('a', 100);
    expect(result.error).toBeUndefined();
    expect(store.get('a')).toBe(100);
  });

  it('rejects set when value size exceeds max', () => {
    const store = new HubAgentStateStore(undefined, { maxValueSize: 10 });
    const result = store.set('big', 'a'.repeat(100));
    expect(result.error).toContain('value size');
    expect(result.error).toContain('exceeds max 10');
    expect(store.get('big')).toBeUndefined();
  });

  it('allows value within size limit', () => {
    const store = new HubAgentStateStore(undefined, { maxValueSize: 100 });
    const result = store.set('small', 'hi');
    expect(result.error).toBeUndefined();
    expect(store.get('small')).toBe('hi');
  });

  it('rejects set when total size would exceed max', () => {
    const store = new HubAgentStateStore(undefined, { maxTotalSize: 50 });
    store.set('a', 'x'.repeat(20));
    store.set('b', 'y'.repeat(20));
    const result = store.set('c', 'z'.repeat(20));
    expect(result.error).toContain('total size');
    expect(store.get('c')).toBeUndefined();
  });

  it('allows replacing value even if total is near limit', () => {
    const store = new HubAgentStateStore(undefined, { maxTotalSize: 50 });
    store.set('a', 'x'.repeat(20));
    const result = store.set('a', 'y'.repeat(20));
    expect(result.error).toBeUndefined();
    expect(store.get('a')).toBe('y'.repeat(20));
  });

  it('uses default limits when none provided', () => {
    const store = new HubAgentStateStore();
    const result = store.set('key', 'value');
    expect(result.error).toBeUndefined();
  });

  it('executeHubState returns error for exceeded limits', () => {
    const store = new HubAgentStateStore(undefined, { maxKeys: 1 });
    store.set('only', 'one');
    const result = executeHubState({ action: 'set', key: 'second', value: 'two' }, store);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('max 1 keys');
  });
});

describe('executeHubState', () => {
  it('get action returns value', () => {
    const store = new HubAgentStateStore();
    store.set('score', 42);
    const result = executeHubState({ action: 'get', key: 'score' }, store);
    expect(result.content).toBe('42');
    expect(result.is_error).toBeUndefined();
  });

  it('get action returns "Key not found" for missing key', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'get', key: 'missing' }, store);
    expect(result.content).toBe('Key not found');
    expect(result.is_error).toBeUndefined();
  });

  it('get action with missing key param returns error', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'get' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('get_all action returns all state', () => {
    const store = new HubAgentStateStore();
    store.set('a', 1);
    store.set('b', 'hello');
    const result = executeHubState({ action: 'get_all' }, store);
    expect(JSON.parse(result.content)).toEqual({ a: 1, b: 'hello' });
    expect(result.is_error).toBeUndefined();
  });

  it('set action updates state', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'set', key: 'color', value: 'red' }, store);
    expect(result.content).toBe('State updated');
    expect(result.is_error).toBeUndefined();
    expect(store.get('color')).toBe('red');
  });

  it('set action with missing key returns error', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'set', value: 'orphan' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('delete action removes key', () => {
    const store = new HubAgentStateStore();
    store.set('temp', 'data');
    const result = executeHubState({ action: 'delete', key: 'temp' }, store);
    expect(result.content).toBe('State key deleted');
    expect(result.is_error).toBeUndefined();
    expect(store.get('temp')).toBeUndefined();
  });

  it('escalation_rules action returns rules', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'val > 100', 'High');
    const result = executeHubState({ action: 'escalation_rules' }, store);
    const rules = JSON.parse(result.content);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ key: 'score', condition: 'val > 100', message: 'High' });
  });

  it('escalate action sets rule', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState(
      { action: 'escalate', key: 'score', condition: 'val > 100', message: 'Too high' },
      store,
    );
    expect(result.content).toBe('Escalation rule set');
    expect(result.is_error).toBeUndefined();
    expect(store.getEscalationRules()).toHaveLength(1);
    expect(store.getEscalationRules()[0].condition).toBe('val > 100');
  });

  it('escalate action with missing key returns error', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'escalate', condition: 'always' }, store);
    expect(result.content).toBe('Missing required parameter: key');
    expect(result.is_error).toBe(true);
  });

  it('escalate action with missing condition returns error', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'escalate', key: 'score' }, store);
    expect(result.content).toBe('Missing required parameter: condition');
    expect(result.is_error).toBe(true);
  });

  it('clear_escalation action clears rule', () => {
    const store = new HubAgentStateStore();
    store.setEscalation('score', 'always');
    const result = executeHubState({ action: 'clear_escalation', key: 'score' }, store);
    expect(result.content).toBe('Escalation rule cleared');
    expect(result.is_error).toBeUndefined();
    expect(store.getEscalationRules()).toHaveLength(0);
  });

  it('unknown action returns error', () => {
    const store = new HubAgentStateStore();
    const result = executeHubState({ action: 'explode' }, store);
    expect(result.content).toBe('Unknown state action: explode');
    expect(result.is_error).toBe(true);
  });
});

describe('hubStateToolDef', () => {
  it('has correct name and description', () => {
    expect(hubStateToolDef.name).toBe('state');
    expect(hubStateToolDef.description).toBeTruthy();
    expect(typeof hubStateToolDef.description).toBe('string');
  });

  it('has all 7 actions in the enum', () => {
    const actionProp = hubStateToolDef.input_schema.properties.action as {
      type: string;
      enum: string[];
    };
    expect(actionProp.type).toBe('string');
    expect(actionProp.enum).toEqual([
      'get',
      'get_all',
      'set',
      'delete',
      'escalation_rules',
      'escalate',
      'clear_escalation',
    ]);
  });

  it('requires only action parameter', () => {
    expect(hubStateToolDef.input_schema.required).toEqual(['action']);
  });

  it('has expected properties in schema', () => {
    const props = Object.keys(hubStateToolDef.input_schema.properties);
    expect(props).toContain('action');
    expect(props).toContain('key');
    expect(props).toContain('value');
    expect(props).toContain('condition');
    expect(props).toContain('message');
  });
});
