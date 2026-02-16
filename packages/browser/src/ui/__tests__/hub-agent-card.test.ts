import { describe, it, expect, vi } from 'vitest';
import { HubAgentCard } from '../hub-agent-card.js';

function createMockProxy(overrides: Partial<any> = {}): any {
  const callbacks = new Set<Function>();
  return {
    hubAgentId: 'hub-agent-1',
    hubConnectionId: 'conn-1',
    agentName: 'Test Hub Agent',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    state: 'running',
    totalCost: 0.05,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    sendAction: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    restore: vi.fn().mockResolvedValue({}),
    updateState: vi.fn(),
    onEvent: vi.fn((cb: Function) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    }),
    // Helper to trigger events in tests
    _triggerEvent: (event: any) => {
      for (const cb of callbacks) cb(event);
    },
    ...overrides,
  };
}

describe('HubAgentCard', () => {
  describe('constructor', () => {
    it('creates card element with remote styling', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      expect(el.classList.contains('agent-card')).toBe(true);
      expect(el.classList.contains('agent-card--remote')).toBe(true);
    });

    it('displays agent name', () => {
      const proxy = createMockProxy({ agentName: 'My Cool Agent' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      const nameEl = el.querySelector('.agent-card__name');
      expect(nameEl).toBeTruthy();
      expect(nameEl!.textContent).toBe('My Cool Agent');
    });

    it('displays hub name with cloud icon', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'production-hub');
      const el = card.getElement();
      const locationEl = el.querySelector('.agent-card__location');
      expect(locationEl).toBeTruthy();
      const hubIcon = locationEl!.querySelector('.agent-card__hub-icon');
      expect(hubIcon).toBeTruthy();
      expect(hubIcon!.textContent).toBe('\u2601');
      expect(locationEl!.textContent).toContain('production-hub');
    });

    it('displays initial state', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      const stateEl = el.querySelector('.agent-card__state');
      expect(stateEl).toBeTruthy();
      const dot = stateEl!.querySelector('span');
      expect(dot).toBeTruthy();
      expect(dot!.textContent).toBe('\u25CF');
      expect(stateEl!.textContent).toContain('Running');
    });

    it('displays initial cost', () => {
      const proxy = createMockProxy({ totalCost: 0.05 });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      const costEl = el.querySelector('.agent-card__cost');
      expect(costEl).toBeTruthy();
      expect(costEl!.textContent).toBe('$0.0500');
    });

    it('sets data-hub-agent-id attribute', () => {
      const proxy = createMockProxy({ hubAgentId: 'hub-xyz-123' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      expect(el.dataset.hubAgentId).toBe('hub-xyz-123');
    });

    it('subscribes to proxy events', () => {
      const proxy = createMockProxy();
      new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      expect(proxy.onEvent).toHaveBeenCalledOnce();
    });
  });

  describe('controls', () => {
    it('shows pause/stop/kill for running state', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons).toBeTruthy();
      // pause, stop, kill = 3 lifecycle buttons (no restore callback)
      expect(buttons!.length).toBe(3);
      expect(buttons![0].getAttribute('title')).toBe('Pause');
      expect(buttons![1].getAttribute('title')).toBe('Stop');
      expect(buttons![2].getAttribute('title')).toBe('Kill');
    });

    it('shows resume/stop/kill for paused state', () => {
      const proxy = createMockProxy({ state: 'paused' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onResume: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons).toBeTruthy();
      expect(buttons!.length).toBe(3);
      expect(buttons![0].getAttribute('title')).toBe('Resume');
      expect(buttons![1].getAttribute('title')).toBe('Stop');
      expect(buttons![2].getAttribute('title')).toBe('Kill');
    });

    it('shows no lifecycle controls for stopped state', () => {
      const proxy = createMockProxy({ state: 'stopped' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      // No lifecycle buttons for stopped state (no restart on hub agents)
      expect(buttons!.length).toBe(0);
    });

    it('shows no lifecycle controls for killed state', () => {
      const proxy = createMockProxy({ state: 'killed' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons!.length).toBe(0);
    });

    it('shows restore button when callback provided', () => {
      const proxy = createMockProxy({ state: 'running' });
      const onRestore = vi.fn();
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onRestore,
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const restoreBtn = controls?.querySelector('[title="Restore Locally"]');
      expect(restoreBtn).toBeTruthy();
    });

    it('does not show restore button when no callback', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        // no onRestore
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const restoreBtn = controls?.querySelector('[title="Restore Locally"]');
      expect(restoreBtn).toBeNull();
    });

    it('kill button has danger class', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const killBtn = controls?.querySelector('[title="Kill"]');
      expect(killBtn).toBeTruthy();
      expect(killBtn!.classList.contains('agent-card__control-btn--danger')).toBe(true);
    });

    it('restore button appears for all states when callback provided', () => {
      for (const state of ['running', 'paused', 'stopped', 'killed']) {
        const proxy = createMockProxy({ state });
        const card = new HubAgentCard(proxy, {
          onSelect: vi.fn(),
          onRestore: vi.fn(),
        }, 'my-hub');
        const controls = card.getElement().querySelector('.agent-card__controls');
        const restoreBtn = controls?.querySelector('[title="Restore Locally"]');
        expect(restoreBtn).toBeTruthy();
      }
    });
  });

  describe('callbacks', () => {
    it('fires onSelect when card clicked (not on controls)', () => {
      const proxy = createMockProxy({ hubAgentId: 'hub-agent-42' });
      const onSelect = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect }, 'my-hub');
      const el = card.getElement();
      // Click on the name element (not on controls)
      const nameEl = el.querySelector('.agent-card__name') as HTMLElement;
      nameEl.click();
      expect(onSelect).toHaveBeenCalledWith('hub-agent-42');
    });

    it('does not fire onSelect when control button clicked', () => {
      const proxy = createMockProxy({ state: 'running' });
      const onSelect = vi.fn();
      const onPause = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect, onPause }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls');
      const pauseBtn = controls?.querySelector('[title="Pause"]') as HTMLElement;
      pauseBtn.click();
      expect(onPause).toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });

    it('fires onPause callback', () => {
      const proxy = createMockProxy({ state: 'running', hubAgentId: 'hub-agent-1' });
      const onPause = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn(), onPause }, 'my-hub');
      const pauseBtn = card.getElement().querySelector('[title="Pause"]') as HTMLElement;
      pauseBtn.click();
      expect(onPause).toHaveBeenCalledWith('hub-agent-1');
    });

    it('fires onResume callback', () => {
      const proxy = createMockProxy({ state: 'paused', hubAgentId: 'hub-agent-1' });
      const onResume = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn(), onResume }, 'my-hub');
      const resumeBtn = card.getElement().querySelector('[title="Resume"]') as HTMLElement;
      resumeBtn.click();
      expect(onResume).toHaveBeenCalledWith('hub-agent-1');
    });

    it('fires onStop callback', () => {
      const proxy = createMockProxy({ state: 'running', hubAgentId: 'hub-agent-1' });
      const onStop = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn(), onStop }, 'my-hub');
      const stopBtn = card.getElement().querySelector('[title="Stop"]') as HTMLElement;
      stopBtn.click();
      expect(onStop).toHaveBeenCalledWith('hub-agent-1');
    });

    it('fires onKill callback', () => {
      const proxy = createMockProxy({ state: 'running', hubAgentId: 'hub-agent-1' });
      const onKill = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn(), onKill }, 'my-hub');
      const killBtn = card.getElement().querySelector('[title="Kill"]') as HTMLElement;
      killBtn.click();
      expect(onKill).toHaveBeenCalledWith('hub-agent-1');
    });

    it('fires onRestore callback', () => {
      const proxy = createMockProxy({ state: 'running', hubAgentId: 'hub-agent-1' });
      const onRestore = vi.fn();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn(), onRestore }, 'my-hub');
      const restoreBtn = card.getElement().querySelector('[title="Restore Locally"]') as HTMLElement;
      restoreBtn.click();
      expect(onRestore).toHaveBeenCalledWith('hub-agent-1');
    });
  });

  describe('state changes', () => {
    it('updates state display on proxy event', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      const stateEl = el.querySelector('.agent-card__state')!;
      expect(stateEl.textContent).toContain('Running');

      // Trigger state change via proxy event
      proxy._triggerEvent({ type: 'state_change', data: { from: 'running', to: 'paused' } });

      expect(stateEl.textContent).toContain('Paused');
    });

    it('updates controls on state change', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onPause: vi.fn(),
        onResume: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls')!;

      // Initially running: should have Pause button
      expect(controls.querySelector('[title="Pause"]')).toBeTruthy();
      expect(controls.querySelector('[title="Resume"]')).toBeNull();

      // Trigger state change to paused
      proxy._triggerEvent({ type: 'state_change', data: { from: 'running', to: 'paused' } });

      // Now should have Resume button, no Pause
      expect(controls.querySelector('[title="Resume"]')).toBeTruthy();
      expect(controls.querySelector('[title="Pause"]')).toBeNull();
    });

    it('updates controls to show no lifecycle buttons when stopped', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, {
        onSelect: vi.fn(),
        onPause: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
      }, 'my-hub');
      const controls = card.getElement().querySelector('.agent-card__controls')!;

      // Initially has lifecycle buttons
      expect(controls.querySelectorAll('.agent-card__control-btn').length).toBeGreaterThan(0);

      // Trigger state change to stopped
      proxy._triggerEvent({ type: 'state_change', data: { from: 'running', to: 'stopped' } });

      // No lifecycle buttons for stopped hub agents
      expect(controls.querySelectorAll('.agent-card__control-btn').length).toBe(0);
    });

    it('ignores non-state-change events', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const stateEl = card.getElement().querySelector('.agent-card__state')!;
      expect(stateEl.textContent).toContain('Running');

      // Trigger a different event type
      proxy._triggerEvent({ type: 'cost_update', data: { cost: 1.23 } });

      // State should not change
      expect(stateEl.textContent).toContain('Running');
    });

    it('handles unknown state gracefully', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');

      // Call updateState directly with an unknown state
      card.updateState('custom_state');

      const stateEl = card.getElement().querySelector('.agent-card__state')!;
      // Should display the raw state string if no label exists
      expect(stateEl.textContent).toContain('custom_state');
    });
  });

  describe('updateState', () => {
    it('shows correct state label for each known state', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const stateEl = card.getElement().querySelector('.agent-card__state')!;

      const stateLabels: Record<string, string> = {
        pending: 'Pending',
        running: 'Running',
        paused: 'Paused',
        stopped: 'Stopped',
        error: 'Error',
        killed: 'Killed',
      };

      for (const [state, label] of Object.entries(stateLabels)) {
        card.updateState(state);
        expect(stateEl.textContent).toContain(label);
        // Each state should have a dot indicator
        const dot = stateEl.querySelector('span');
        expect(dot).toBeTruthy();
        expect(dot!.textContent).toBe('\u25CF');
      }
    });

    it('sets state-specific color on dot', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const stateEl = card.getElement().querySelector('.agent-card__state')!;

      card.updateState('running');
      expect(stateEl.querySelector('span')!.style.color).toBe('var(--color-success)');

      card.updateState('paused');
      expect(stateEl.querySelector('span')!.style.color).toBe('var(--color-warning)');

      card.updateState('error');
      expect(stateEl.querySelector('span')!.style.color).toBe('var(--color-error)');
    });
  });

  describe('updateCost', () => {
    it('updates cost display', () => {
      const proxy = createMockProxy({ totalCost: 0.05 });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const costEl = card.getElement().querySelector('.agent-card__cost')!;
      expect(costEl.textContent).toBe('$0.0500');

      card.updateCost(1.2345);
      expect(costEl.textContent).toBe('$1.2345');
    });

    it('formats cost to 4 decimal places', () => {
      const proxy = createMockProxy({ totalCost: 0 });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');

      card.updateCost(0);
      expect(card.getElement().querySelector('.agent-card__cost')!.textContent).toBe('$0.0000');

      card.updateCost(123.4);
      expect(card.getElement().querySelector('.agent-card__cost')!.textContent).toBe('$123.4000');

      card.updateCost(0.00001);
      expect(card.getElement().querySelector('.agent-card__cost')!.textContent).toBe('$0.0000');
    });
  });

  describe('dispose', () => {
    it('removes element from DOM', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const parent = document.createElement('div');
      parent.appendChild(card.getElement());
      expect(parent.children.length).toBe(1);

      card.dispose();
      expect(parent.children.length).toBe(0);
    });

    it('unsubscribes from proxy events', () => {
      const proxy = createMockProxy({ state: 'running' });
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const stateEl = card.getElement().querySelector('.agent-card__state')!;
      expect(stateEl.textContent).toContain('Running');

      card.dispose();

      // Trigger state change after dispose — should NOT update state display
      proxy._triggerEvent({ type: 'state_change', data: { from: 'running', to: 'paused' } });

      // State should remain as it was at disposal (Running, not Paused)
      expect(stateEl.textContent).toContain('Running');
    });

    it('can be called multiple times safely', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      expect(() => {
        card.dispose();
        card.dispose();
      }).not.toThrow();
    });
  });

  describe('DOM structure', () => {
    it('has correct child element order', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      const el = card.getElement();
      const children = Array.from(el.children);
      expect(children.length).toBe(5);
      expect(children[0].className).toBe('agent-card__name');
      expect(children[1].className).toBe('agent-card__location');
      expect(children[2].className).toBe('agent-card__state');
      expect(children[3].className).toBe('agent-card__cost');
      expect(children[4].className).toBe('agent-card__controls');
    });

    it('card element is a div', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      expect(card.getElement().tagName).toBe('DIV');
    });

    it('getElement returns the same element on multiple calls', () => {
      const proxy = createMockProxy();
      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'my-hub');
      expect(card.getElement()).toBe(card.getElement());
    });
  });
});
