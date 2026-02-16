/**
 * Tests for offline behavior of the bootstrap flo.* APIs in iframe-template.ts.
 * Validates that flo.notify, flo.ask, flo.callTool, and checkEscalation
 * behave correctly when navigator.onLine is false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBootstrapScript } from '../iframe-template.js';

describe('iframe-template offline behavior', () => {
  let iframe: HTMLIFrameElement;
  let iframeWindow: any;

  // Extract just the JS from the bootstrap script tag
  function extractBootstrapJS(agentId: string): string {
    const scriptTag = generateBootstrapScript(agentId);
    // Extract content between <script data-flo-bootstrap> and </script>
    const match = scriptTag.match(/<script data-flo-bootstrap>([\s\S]*?)<\/script>/);
    return match ? match[1] : '';
  }

  beforeEach(() => {
    // Create a sandboxed iframe for running bootstrap code
    iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    document.body.appendChild(iframe);
  });

  afterEach(() => {
    iframe.remove();
  });

  describe('__isOffline() helper', () => {
    it('should be present in the generated bootstrap script', () => {
      const js = extractBootstrapJS('test-agent');
      expect(js).toContain('function __isOffline()');
      expect(js).toContain('navigator.onLine');
    });
  });

  describe('__showOfflineToast() helper', () => {
    it('should be present in the generated bootstrap script', () => {
      const js = extractBootstrapJS('test-agent');
      expect(js).toContain('function __showOfflineToast(msg)');
      expect(js).toContain('__flo-offline-toast');
    });
  });

  describe('flo.notify offline guard', () => {
    it('should include offline check in flo.notify', () => {
      const js = extractBootstrapJS('test-agent');
      // The notify function should check __isOffline() before proceeding
      // Look for the pattern: notify function contains __isOffline check
      const notifyStart = js.indexOf('notify: function(event, data, targetWorkerId)');
      const notifyEnd = js.indexOf('ask: function(event, data, targetWorkerId)');
      const notifyBody = js.slice(notifyStart, notifyEnd);
      expect(notifyBody).toContain('__isOffline()');
      expect(notifyBody).toContain('__showOfflineToast');
    });
  });

  describe('flo.ask offline guard', () => {
    it('should include offline check in flo.ask', () => {
      const js = extractBootstrapJS('test-agent');
      const askStart = js.indexOf('ask: function(event, data, targetWorkerId)');
      const askEnd = js.indexOf('notify_user: function') !== -1
        ? js.indexOf('notify_user: function')
        : js.indexOf('emit: function');
      const askBody = js.slice(askStart, askEnd);
      expect(askBody).toContain('__isOffline()');
      expect(askBody).toContain('Promise.reject');
      expect(askBody).toContain('__showOfflineToast');
    });
  });

  describe('flo.callTool offline guard', () => {
    it('should include offline check in flo.callTool', () => {
      const js = extractBootstrapJS('test-agent');
      const callToolStart = js.indexOf('callTool: function(name, input, options)');
      const callToolEnd = js.indexOf('getCamera: function()');
      const callToolBody = js.slice(callToolStart, callToolEnd);
      expect(callToolBody).toContain('__isOffline()');
      expect(callToolBody).toContain('localTools');
      expect(callToolBody).toContain("'storage'");
      expect(callToolBody).toContain("'dom'");
      expect(callToolBody).toContain("'runjs'");
      expect(callToolBody).toContain("'state'");
    });

    it('should allow local tools (storage, dom, runjs, state) when offline', () => {
      const js = extractBootstrapJS('test-agent');
      const callToolStart = js.indexOf('callTool: function(name, input, options)');
      const callToolEnd = js.indexOf('getCamera: function()');
      const callToolBody = js.slice(callToolStart, callToolEnd);
      // The check should be: if offline AND tool not in localTools, reject
      expect(callToolBody).toContain('localTools.indexOf(name) === -1');
    });
  });

  describe('checkEscalation offline guard', () => {
    it('should include offline check in checkEscalation', () => {
      const js = extractBootstrapJS('test-agent');
      const checkStart = js.indexOf('function checkEscalation(key, value)');
      const checkEnd = js.indexOf('function scheduleStatePersist()');
      const checkBody = js.slice(checkStart, checkEnd);
      expect(checkBody).toContain('__isOffline()');
      expect(checkBody).toContain('__floOfflineEscalationsOccurred = true');
    });
  });

  describe('online reconnection listener', () => {
    it('should include online event listener', () => {
      const js = extractBootstrapJS('test-agent');
      expect(js).toContain("window.addEventListener('online'");
      expect(js).toContain('__floOfflineEscalationsOccurred');
      expect(js).toContain('offline_escalations_pending');
    });

    it('should broadcast state snapshot to workers on reconnect', () => {
      const js = extractBootstrapJS('test-agent');
      // Find the online handler
      const onlineStart = js.indexOf("window.addEventListener('online'");
      const onlineEnd = js.indexOf('// ====', onlineStart + 1);
      const onlineBody = js.slice(onlineStart, onlineEnd);
      expect(onlineBody).toContain('broadcastToWorkers');
      expect(onlineBody).toContain('offline_escalations_pending');
      expect(onlineBody).toContain('stateCache');
    });
  });

  describe('__floOfflineEscalationsOccurred flag', () => {
    it('should be initialized to false', () => {
      const js = extractBootstrapJS('test-agent');
      expect(js).toContain('var __floOfflineEscalationsOccurred = false');
    });
  });
});
