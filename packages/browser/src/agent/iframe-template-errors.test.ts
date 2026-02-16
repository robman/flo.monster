import { describe, it, expect } from 'vitest';
import { generateBootstrapScript } from './iframe-template.js';

describe('iframe-template error monitoring', () => {
  const script = generateBootstrapScript('test-agent');

  describe('error batching', () => {
    it('has errorBatch array and timer', () => {
      expect(script).toContain('var errorBatch = []');
      expect(script).toContain('var errorBatchTimer = null');
    });

    it('has batch configuration constants', () => {
      expect(script).toContain('var ERROR_BATCH_WINDOW = 1500');
      expect(script).toContain('var ERROR_BATCH_MAX = 10');
    });

    it('has reportError function with deduplication by message', () => {
      expect(script).toContain('function reportError(errorInfo)');
      expect(script).toContain('errorBatch[i].message === errorInfo.message');
    });

    it('increments count on duplicate errors', () => {
      expect(script).toContain('errorBatch[i].count = (errorBatch[i].count || 1) + 1');
    });

    it('caps unique errors at ERROR_BATCH_MAX', () => {
      expect(script).toContain('if (errorBatch.length >= ERROR_BATCH_MAX) return');
    });

    it('starts timer on first error in batch', () => {
      expect(script).toContain('errorBatchTimer = setTimeout(flushErrorBatch, ERROR_BATCH_WINDOW)');
    });

    it('has flushErrorBatch function that sends batch', () => {
      expect(script).toContain('function flushErrorBatch()');
      expect(script).toContain("relayToShell({ type: 'runtime_error', errors: batch })");
    });

    it('clears batch after flush', () => {
      expect(script).toContain('var batch = errorBatch');
      expect(script).toContain('errorBatch = []');
    });

    it('flushes on visibilitychange hidden', () => {
      expect(script).toContain("document.addEventListener('visibilitychange'");
      expect(script).toContain("document.visibilityState === 'hidden'");
      expect(script).toContain('flushErrorBatch()');
    });

    it('clears timer before flush on visibilitychange', () => {
      expect(script).toContain('clearTimeout(errorBatchTimer)');
    });
  });

  describe('console.error interception', () => {
    it('saves original console.error', () => {
      expect(script).toContain('var _origConsoleError = console.error');
    });

    it('calls original console.error', () => {
      expect(script).toContain('_origConsoleError.apply(console, arguments)');
    });

    it('has recursion guard', () => {
      expect(script).toContain('var _inErrorHandler = false');
      expect(script).toContain('if (_inErrorHandler) return');
    });

    it('reports with console category', () => {
      expect(script).toContain("category: 'console'");
    });

    it('extracts message from Error objects', () => {
      expect(script).toContain('arguments[i] instanceof Error ? arguments[i].message');
    });

    it('handles non-string arguments with JSON.stringify', () => {
      expect(script).toContain('JSON.stringify(arguments[i])');
    });

    it('falls back to String() if JSON.stringify fails', () => {
      expect(script).toContain('parts.push(String(arguments[i]))');
    });
  });

  describe('resource load failures', () => {
    it('adds capture-phase error listener on window', () => {
      // Check for the addEventListener call with capture: true
      expect(script).toContain("window.addEventListener('error'");
      expect(script).toContain('}, true)');
    });

    it('checks target is not window itself', () => {
      expect(script).toContain('e.target && e.target !== window');
    });

    it('captures IMG, SCRIPT, LINK, VIDEO, AUDIO, SOURCE tags', () => {
      expect(script).toContain("tag === 'IMG'");
      expect(script).toContain("tag === 'SCRIPT'");
      expect(script).toContain("tag === 'LINK'");
      expect(script).toContain("tag === 'VIDEO'");
      expect(script).toContain("tag === 'AUDIO'");
      expect(script).toContain("tag === 'SOURCE'");
    });

    it('reports with resource category', () => {
      expect(script).toContain("category: 'resource'");
    });

    it('includes tag name and src/href in message', () => {
      expect(script).toContain("'Failed to load ' + tag.toLowerCase()");
      expect(script).toContain('e.target.src || e.target.href');
    });
  });

  describe('window.onerror', () => {
    it('reports with error category', () => {
      expect(script).toContain("category: 'error'");
    });

    it('includes source, line, column, and stack', () => {
      expect(script).toContain("source: source || 'unknown'");
      expect(script).toContain('line: lineno');
      expect(script).toContain('column: colno');
    });
  });

  describe('window.onunhandledrejection', () => {
    it('reports with promise category', () => {
      expect(script).toContain("category: 'promise'");
    });

    it('reports source as unhandled promise rejection', () => {
      expect(script).toContain("source: 'unhandled promise rejection'");
    });
  });

  describe('batch format in relay', () => {
    it('forwards errors array from shell to worker', () => {
      // The iframe message handler should relay errors array to worker
      expect(script).toContain("errors: data.errors || (data.error ? [data.error] : [])");
    });
  });

  describe('no old throttle code', () => {
    it('does not have old throttle variables', () => {
      expect(script).not.toContain('var lastErrorTime');
      expect(script).not.toContain('var errorCount');
      expect(script).not.toContain('var suppressedCount');
      expect(script).not.toContain('ERROR_THROTTLE_MS');
      expect(script).not.toContain('ERROR_RESET_MS');
    });

    it('does not use old single-error format', () => {
      // The old format was: relayToShell({ type: 'runtime_error', error: errorInfo })
      // New format uses 'errors' (plural) with an array
      // But note: the relay handler has backward compat that checks data.error
      // The originating reportError/flushErrorBatch should use 'errors'
      expect(script).toContain("errors: batch");
    });
  });
});
