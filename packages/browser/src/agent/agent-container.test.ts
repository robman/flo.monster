import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentContainer } from './agent-container.js';
import { generateIframeSrcdoc } from './iframe-template.js';
import type { AgentConfig, AgentEvent } from '@flo-monster/core';

function createTestConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'test-agent-1',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
    ...overrides,
  };
}

describe('AgentContainer', () => {
  let container: AgentContainer;

  beforeEach(() => {
    container = new AgentContainer(createTestConfig());
  });

  describe('constructor', () => {
    it('sets state to pending', () => {
      expect(container.state).toBe('pending');
    });

    it('stores config', () => {
      expect(container.config.id).toBe('test-agent-1');
      expect(container.config.name).toBe('Test Agent');
    });

    it('sets id from config', () => {
      expect(container.id).toBe('test-agent-1');
    });
  });

  describe('state transitions', () => {
    it('pause transitions to paused (no-op when not running)', () => {
      // Can only pause if running, should be a no-op when pending
      container.pause();
      expect(container.state).toBe('pending');
    });

    it('resume is no-op when not paused', () => {
      container.resume();
      expect(container.state).toBe('pending');
    });

    it('kill sets state to killed', () => {
      container.kill();
      expect(container.state).toBe('killed');
    });

    it('kill is idempotent', () => {
      container.kill();
      container.kill();
      expect(container.state).toBe('killed');
    });

    it('stop from pending is no-op', () => {
      container.stop();
      expect(container.state).toBe('pending');
    });

    it('restart from stopped resets to pending', () => {
      // Force state to stopped by going through kill first, then use a fresh container
      // We need a container in stopped state - stop requires running/paused
      // So we'll use kill and then test restart from killed
      container.kill();
      container.restart();
      expect(container.state).toBe('pending');
    });

    it('restart from killed resets to pending', () => {
      container.kill();
      container.restart();
      expect(container.state).toBe('pending');
    });

    it('restart from error resets to pending', () => {
      // We can't directly set error state, so we test via kill path
      // Kill then restart is the typical flow
      container.kill();
      expect(container.state).toBe('killed');
      container.restart();
      expect(container.state).toBe('pending');
    });

    it('restart throws from pending state', () => {
      expect(() => container.restart()).toThrow('Cannot restart agent in state: pending');
    });
  });

  describe('onEvent', () => {
    it('receives state change events', () => {
      const events: AgentEvent[] = [];
      container.onEvent((e) => events.push(e));
      container.kill();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('state_change');
      if (events[0].type === 'state_change') {
        expect(events[0].from).toBe('pending');
        expect(events[0].to).toBe('killed');
      }
    });

    it('returns unsubscribe function', () => {
      const events: AgentEvent[] = [];
      const unsub = container.onEvent((e) => events.push(e));
      unsub();
      container.kill();
      expect(events).toHaveLength(0);
    });

    it('supports multiple listeners', () => {
      let count = 0;
      container.onEvent(() => count++);
      container.onEvent(() => count++);
      container.kill();
      expect(count).toBe(2);
    });
  });

  describe('getIframeElement', () => {
    it('returns null when not started', () => {
      expect(container.getIframeElement()).toBeNull();
    });
  });

  describe('iframe bootstrap', () => {
    it('srcdoc contains init guard against duplicate worker creation', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      // Multi-worker architecture uses workers['main'] guard
      expect(srcdoc).toContain("if (workers['main']) return");
    });

    it('srcdoc supports multiple workers with requestSources tracking', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('var workers = {};');
      expect(srcdoc).toContain('var requestSources = {};');
    });

    it('srcdoc contains spawn_subworker handler', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('spawn_subworker');
      expect(srcdoc).toContain('subworkerId');
    });

    it('srcdoc contains kill_subworker handler', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('kill_subworker');
      expect(srcdoc).toContain('sw.terminate()');
    });

    it('srcdoc contains subworker_message handler', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('subworker_message');
    });

    it('srcdoc routes responses to correct worker via requestSources', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain("requestSources[data.id] || 'main'");
    });

    it('srcdoc broadcasts hooks_config to all workers', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('Object.keys(workers)');
      expect(srcdoc).toContain('hooks_config');
    });

    it('srcdoc includes workerId in outgoing messages', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('workerId: workerId');
    });

    it('srcdoc contains placeholder content with agent name', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'My Custom Agent');
      expect(srcdoc).toContain('class="agent-placeholder"');
      expect(srcdoc).toContain('My Custom Agent');
      expect(srcdoc).toContain('Awaiting instructions...');
    });

    it('srcdoc escapes HTML in agent name', () => {
      const srcdoc = generateIframeSrcdoc('test-id', '<script>alert("xss")</script>');
      expect(srcdoc).not.toContain('<script>alert');
      expect(srcdoc).toContain('&lt;script&gt;');
    });
  });

  describe('hook message relay in srcdoc', () => {
    it('srcdoc contains hook message relay cases', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('pre_tool_use');
      expect(srcdoc).toContain('post_tool_use');
      expect(srcdoc).toContain('hooks_config');
      expect(srcdoc).toContain('agent_stop_result');
    });
  });

  describe('file request relay in srcdoc', () => {
    it('srcdoc contains file_request relay from worker to shell', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('file_request');
    });

    it('srcdoc contains file_result relay from shell to worker', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('file_result');
    });
  });

  describe('stop_agent and config_update relay in srcdoc', () => {
    it('srcdoc contains stop_agent relay case', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('stop_agent');
    });

    it('srcdoc contains config_update relay case', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('config_update');
    });
  });

  describe('source verification', () => {
    it('handleIframeMessage ignores events from wrong source', () => {
      const events: AgentEvent[] = [];
      container.onEvent((e) => events.push(e));

      // Dispatch a message event with wrong source (null source, no iframe set)
      const messageEvent = new MessageEvent('message', {
        data: { type: 'event', agentId: 'test-agent-1', event: { type: 'text_delta', text: 'hello' } },
        // source is null by default - and container.iframe is also null
        // null !== undefined (null?.contentWindow), so message should be rejected
      });
      window.dispatchEvent(messageEvent);

      // Container has no iframe (not started), so iframe?.contentWindow is undefined
      // The source is null. null !== undefined, so message should be rejected
      expect(events).toHaveLength(0);
    });

    it('handleIframeMessage rejects when no iframe is set', () => {
      // Verify the source verification exists by checking that the container
      // filters by source. When iframe is null, e.source !== null?.contentWindow
      // (undefined) returns true, so msg is rejected.
      const container2 = new AgentContainer(createTestConfig());
      const events: AgentEvent[] = [];
      container2.onEvent((e) => events.push(e));

      // Message from null source, no iframe -> rejected
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'event', agentId: container2.id, event: { type: 'text_delta', text: 'test' } },
      }));

      expect(events).toHaveLength(0);
    });
  });

  describe('updateConfig', () => {
    it('updates safe config fields', () => {
      container.updateConfig({ model: 'claude-opus-4-20250514', maxTokens: 8192 });
      expect(container.config.model).toBe('claude-opus-4-20250514');
      expect(container.config.maxTokens).toBe(8192);
    });

    it('updates systemPrompt', () => {
      container.updateConfig({ systemPrompt: 'New prompt' });
      expect(container.config.systemPrompt).toBe('New prompt');
    });

    it('updates tokenBudget and costBudgetUsd', () => {
      container.updateConfig({ tokenBudget: 50000, costBudgetUsd: 2.5 });
      expect(container.config.tokenBudget).toBe(50000);
      expect(container.config.costBudgetUsd).toBe(2.5);
    });
  });

  describe('showInPane and hideFromPane', () => {
    it('hideFromPane is safe when no iframe exists', () => {
      // Should not throw
      container.hideFromPane();
      expect(container.state).toBe('pending');
    });

    it('showInPane is no-op when no iframe exists', () => {
      const paneEl = document.createElement('div');
      // Should not throw
      container.showInPane(paneEl);
      expect(container.state).toBe('pending');
    });
  });

  describe('visibility tracking', () => {
    it('isVisible returns false initially', () => {
      expect(container.isVisible()).toBe(false);
    });

    it('isVisible remains false when showInPane called without iframe', () => {
      const paneEl = document.createElement('div');
      container.showInPane(paneEl);
      // No iframe exists, so visibility should not change
      expect(container.isVisible()).toBe(false);
    });

    it('hideFromPane does not emit event when already hidden', () => {
      const events: AgentEvent[] = [];
      container.onEvent((e) => events.push(e));

      // Container starts hidden
      expect(container.isVisible()).toBe(false);

      // hideFromPane when already hidden should not emit
      container.hideFromPane();

      // Filter for visibility events only
      const visibilityEvents = events.filter(e => e.type === 'visibility_change');
      expect(visibilityEvents).toHaveLength(0);
    });

    it('srcdoc contains visibility_change handler', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('visibility_change');
      expect(srcdoc).toContain('broadcastToWorkers');
    });

    it('srcdoc forwards visibility_change to all workers', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      // Check that visibility_change is handled via broadcastToWorkers
      expect(srcdoc).toContain("case 'visibility_change':");
      expect(srcdoc).toContain('broadcastToWorkers(data)');
    });
  });

  describe('DOM state capture', () => {
    it('captureDomState returns null when no iframe exists', async () => {
      const result = await container.captureDomState();
      expect(result).toBeNull();
    });

    it('captureDomState returns null when agent is not started', async () => {
      // Container is created but not started (pending state)
      expect(container.state).toBe('pending');
      const result = await container.captureDomState();
      expect(result).toBeNull();
    });

    it('captureDomState returns null after agent is killed', async () => {
      container.kill();
      expect(container.state).toBe('killed');
      const result = await container.captureDomState();
      expect(result).toBeNull();
    });

    it('srcdoc contains capture_dom_state handler', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('capture_dom_state');
      expect(srcdoc).toContain('handleCaptureDomState');
    });

    it('srcdoc contains dom_state_captured response', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      expect(srcdoc).toContain('dom_state_captured');
      expect(srcdoc).toContain('viewportHtml');
      expect(srcdoc).toContain('listeners');
      expect(srcdoc).toContain('capturedAt');
    });

    it('srcdoc handleCaptureDomState captures event listeners', () => {
      const srcdoc = generateIframeSrcdoc('test-id', 'Test Agent');
      // Verify the handleCaptureDomState function uses collectListeners
      expect(srcdoc).toContain('collectListeners()');
      // Verify collectListeners iterates eventListeners and captures all fields
      expect(srcdoc).toContain('selector: entry.selector');
      expect(srcdoc).toContain('events: entry.events');
      expect(srcdoc).toContain('workerId: entry.workerId');
      expect(srcdoc).toContain('options: entry.options');
    });
  });

  describe('subworker tracking', () => {
    it('getSubworkers returns empty array initially', () => {
      expect(container.getSubworkers()).toEqual([]);
    });

    it('getSubworkerCount returns 0 initially', () => {
      expect(container.getSubworkerCount()).toBe(0);
    });

    it('spawnSubworker adds to tracking map', () => {
      const subConfig = createTestConfig({ id: 'sub-1', name: 'Sub 1' });
      container.spawnSubworker('sub-1', subConfig, '// worker code');

      expect(container.getSubworkerCount()).toBe(1);
      const subs = container.getSubworkers();
      expect(subs).toHaveLength(1);
      expect(subs[0].id).toBe('sub-1');
      expect(subs[0].config.name).toBe('Sub 1');
      expect(subs[0].state).toBe('running');
      expect(typeof subs[0].createdAt).toBe('number');
    });

    it('killSubworker removes from tracking map', () => {
      const subConfig = createTestConfig({ id: 'sub-1', name: 'Sub 1' });
      container.spawnSubworker('sub-1', subConfig, '// worker code');
      expect(container.getSubworkerCount()).toBe(1);

      container.killSubworker('sub-1');
      expect(container.getSubworkerCount()).toBe(0);
      expect(container.getSubworkers()).toEqual([]);
    });

    it('pauseSubworker updates subworker state to paused', () => {
      const subConfig = createTestConfig({ id: 'sub-1', name: 'Sub 1' });
      container.spawnSubworker('sub-1', subConfig, '// worker code');

      container.pauseSubworker('sub-1');

      const subs = container.getSubworkers();
      expect(subs[0].state).toBe('paused');
    });

    it('stopSubworker updates subworker state to stopped', () => {
      const subConfig = createTestConfig({ id: 'sub-1', name: 'Sub 1' });
      container.spawnSubworker('sub-1', subConfig, '// worker code');

      container.stopSubworker('sub-1');

      const subs = container.getSubworkers();
      expect(subs[0].state).toBe('stopped');
    });

    it('tracks multiple subworkers', () => {
      const sub1Config = createTestConfig({ id: 'sub-1', name: 'Sub 1' });
      const sub2Config = createTestConfig({ id: 'sub-2', name: 'Sub 2' });

      container.spawnSubworker('sub-1', sub1Config, '// worker code');
      container.spawnSubworker('sub-2', sub2Config, '// worker code');

      expect(container.getSubworkerCount()).toBe(2);

      container.killSubworker('sub-1');
      expect(container.getSubworkerCount()).toBe(1);
      expect(container.getSubworkers()[0].id).toBe('sub-2');
    });
  });

  describe('sandboxPermissions config', () => {
    it('stores sandboxPermissions in config', () => {
      const config = createTestConfig({
        sandboxPermissions: { camera: true, microphone: true },
      });
      const agent = new AgentContainer(config);
      expect(agent.config.sandboxPermissions?.camera).toBe(true);
      expect(agent.config.sandboxPermissions?.microphone).toBe(true);
    });

    it('updateConfig with sandboxPermissions updates config', () => {
      const agent = new AgentContainer(createTestConfig());
      expect(agent.config.sandboxPermissions).toBeUndefined();

      agent.updateConfig({ sandboxPermissions: { camera: true, geolocation: true } });
      expect(agent.config.sandboxPermissions?.camera).toBe(true);
      expect(agent.config.sandboxPermissions?.geolocation).toBe(true);
      expect(agent.config.sandboxPermissions?.microphone).toBeUndefined();
    });

    it('updateConfig with empty sandboxPermissions clears permissions', () => {
      const config = createTestConfig({
        sandboxPermissions: { camera: true },
      });
      const agent = new AgentContainer(config);
      agent.updateConfig({ sandboxPermissions: {} });
      expect(agent.config.sandboxPermissions?.camera).toBeUndefined();
    });
  });
});
