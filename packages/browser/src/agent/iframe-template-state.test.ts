import { describe, it, expect } from 'vitest';
import { generateBootstrapScript } from './iframe-template.js';

describe('iframe-template state API', () => {
  const script = generateBootstrapScript('test-agent');

  describe('flo.state object', () => {
    it('includes flo.state on window.flo', () => {
      expect(script).toContain('state: {');
      expect(script).toContain('flo.state');
    });

    it('has get method that reads from stateCache', () => {
      expect(script).toContain('get: function(key)');
      expect(script).toContain('return stateCache[key]');
    });

    it('has set method that updates cache, fires onChange, checks escalation, persists', () => {
      expect(script).toContain('set: function(key, value)');
      expect(script).toContain('stateCache[key] = value');
      expect(script).toContain('fireOnChange(key, value, oldVal)');
      expect(script).toContain('checkEscalation(key, value)');
      expect(script).toContain('scheduleStatePersist()');
    });

    it('has getAll method', () => {
      expect(script).toContain('getAll: function()');
      expect(script).toContain('return shallowCopy(stateCache)');
    });

    it('has onChange method returning unsubscribe function', () => {
      expect(script).toContain('onChange: function(keyOrPattern, callback)');
      expect(script).toContain('return function() { delete stateChangeHandlers[hid]; }');
    });

    it('has escalate method supporting true, function, and string conditions', () => {
      expect(script).toContain('escalate: function(key, conditionOrTrue, message)');
      expect(script).toContain("conditionOrTrue === true || conditionOrTrue === 'always'");
      expect(script).toContain("typeof conditionOrTrue === 'function'");
      expect(script).toContain("typeof conditionOrTrue === 'string'");
    });

    it('has clearEscalation method', () => {
      expect(script).toContain('clearEscalation: function(key)');
      expect(script).toContain('delete stateEscalationRules[key]');
    });
  });

  describe('state variables', () => {
    it('declares stateCache', () => {
      expect(script).toContain('var stateCache = {}');
    });

    it('declares stateChangeHandlers', () => {
      expect(script).toContain('var stateChangeHandlers = {}');
    });

    it('declares stateEscalationRules', () => {
      expect(script).toContain('var stateEscalationRules = {}');
    });

    it('declares stateLoaded flag', () => {
      expect(script).toContain('var stateLoaded = false');
    });
  });

  describe('state helpers', () => {
    it('has fireOnChange function with pattern matching', () => {
      expect(script).toContain('function fireOnChange(key, newVal, oldVal)');
      // Wildcard support
      expect(script).toContain("h.keyOrPattern.charAt(h.keyOrPattern.length - 1) === '*'");
    });

    it('has checkEscalation function that sends to all workers', () => {
      expect(script).toContain('function checkEscalation(key, value)');
      expect(script).toContain("event: 'state_escalation'");
    });

    it('has scheduleStatePersist with debounce', () => {
      expect(script).toContain('function scheduleStatePersist()');
      expect(script).toContain('setTimeout(flushState, 500)');
    });

    it('has flushState that persists to __flo_state via storage_request', () => {
      expect(script).toContain('function flushState()');
      expect(script).toContain("key: '__flo_state'");
    });

    it('has handleStateRequest for worker state actions', () => {
      expect(script).toContain('function handleStateRequest(data, workerId)');
    });
  });

  describe('state loading on init', () => {
    it('sends storage_request for __flo_state on init', () => {
      expect(script).toContain("relayToShell({ type: 'storage_request', id: stateLoadPendingId, action: 'get', key: '__flo_state' })");
    });

    it('intercepts storage_result for state loading', () => {
      expect(script).toContain('data.id === stateLoadPendingId');
    });

    it('restores escalation rules from persisted data', () => {
      expect(script).toContain('parsed.escalationRules');
    });

    it('processes queued state requests after loading', () => {
      expect(script).toContain('stateLoadQueue');
    });
  });

  describe('state_request handling in worker handler', () => {
    it('handles state_request from workers', () => {
      expect(script).toContain("msg.type === 'state_request'");
    });

    it('queues requests if state not loaded yet', () => {
      expect(script).toContain('if (!stateLoaded)');
      expect(script).toContain('stateLoadQueue.push');
    });
  });

  describe('visibility change handler', () => {
    it('flushes state on visibility hidden', () => {
      expect(script).toContain("document.addEventListener('visibilitychange'");
      expect(script).toContain("document.visibilityState === 'hidden'");
      expect(script).toContain('flushState()');
    });
  });
});
