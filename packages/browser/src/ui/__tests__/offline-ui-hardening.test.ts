import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock mobile-utils before importing components that use it
vi.mock('../mobile-utils.js', () => ({
  isMobileViewport: () => false,
  onViewportChange: () => () => {},
}));

// Mock speech handler to avoid import side effects
vi.mock('../../shell/relay/speech-handler.js', () => ({
  stopAllSpeechSessions: vi.fn(),
}));

import { Dashboard } from '../dashboard.js';
import { AgentCard } from '../agent-card.js';
import { HubAgentCard } from '../hub-agent-card.js';
import { AgentView } from '../agent-view.js';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentManager } from '../../shell/agent-manager.js';
import type { HubAgentProxy } from '../../shell/hub-agent-proxy.js';

/**
 * Create a minimal mock AgentContainer
 */
function mockAgent(overrides?: Partial<{ id: string; name: string; state: string }>): AgentContainer {
  const id = overrides?.id ?? 'agent-1';
  const name = overrides?.name ?? 'Test Agent';
  const state = overrides?.state ?? 'running';
  return {
    id,
    config: { name } as any,
    state,
    onEvent: vi.fn(() => () => {}),
    setMobileStatus: vi.fn(),
    setViewState: vi.fn(),
    getViewState: vi.fn(() => 'max'),
    hubPersistInfo: null,
    hubConnected: false,
    sendUserMessage: vi.fn(),
  } as unknown as AgentContainer;
}

/**
 * Create a minimal mock AgentManager
 */
function mockAgentManager(agents: AgentContainer[] = []): AgentManager {
  return {
    getAllAgents: () => agents,
    onAgentCreated: vi.fn(() => () => {}),
    onAgentTerminated: vi.fn(() => () => {}),
  } as unknown as AgentManager;
}

/**
 * Create a minimal mock HubAgentProxy
 */
function mockHubProxy(overrides?: Partial<{ hubAgentId: string; agentName: string; state: string }>): HubAgentProxy {
  return {
    hubAgentId: overrides?.hubAgentId ?? 'hub-1',
    agentName: overrides?.agentName ?? 'Test Hub Agent',
    state: overrides?.state ?? 'running',
    totalCost: 0,
    hubConnectionId: 'conn-1',
    onEvent: vi.fn(() => () => {}),
  } as unknown as HubAgentProxy;
}

describe('Offline UI Hardening', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Default to online
    Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
  });

  afterEach(() => {
    container.remove();
  });

  describe('Dashboard.setOffline()', () => {
    it('disables all agent cards when offline', () => {
      const agent = mockAgent();
      const manager = mockAgentManager([agent]);
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);

      const card = dashboard.getCard('agent-1');
      expect(card).toBeDefined();
      const buttons = card!.getElement().querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
      // Card itself should remain clickable (no agent-card--disabled class)
      expect(card!.getElement().classList.contains('agent-card--disabled')).toBe(false);
    });

    it('re-enables all agent cards when online', () => {
      const agent = mockAgent();
      const manager = mockAgentManager([agent]);
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);
      dashboard.setOffline(false);

      const card = dashboard.getCard('agent-1');
      const buttons = card!.getElement().querySelectorAll('.agent-card__controls button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it('disables the New Agent card when offline', () => {
      const manager = mockAgentManager();
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);

      const newCard = container.querySelector('.agent-card--new') as HTMLElement;
      expect(newCard).toBeTruthy();
      expect(newCard.classList.contains('agent-card--disabled')).toBe(true);
      expect(newCard.style.pointerEvents).toBe('none');
    });

    it('re-enables the New Agent card when online', () => {
      const manager = mockAgentManager();
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);
      dashboard.setOffline(false);

      const newCard = container.querySelector('.agent-card--new') as HTMLElement;
      expect(newCard.classList.contains('agent-card--disabled')).toBe(false);
      expect(newCard.style.pointerEvents).toBe('');
    });

    it('disables hub agent cards when offline', () => {
      const manager = mockAgentManager();
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());
      const proxy = mockHubProxy();
      dashboard.addHubAgentCard(proxy, { onSelect: vi.fn() }, 'My Hub');

      dashboard.setOffline(true);

      const hubCard = container.querySelector('[data-hub-agent-id="hub-1"]') as HTMLElement;
      expect(hubCard).toBeTruthy();
      const buttons = hubCard.querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
      // Card itself should remain clickable (no agent-card--disabled class)
      expect(hubCard.classList.contains('agent-card--disabled')).toBe(false);
    });

    it('re-enables hub agent cards when online', () => {
      const manager = mockAgentManager();
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());
      const proxy = mockHubProxy();
      dashboard.addHubAgentCard(proxy, { onSelect: vi.fn() }, 'My Hub');

      dashboard.setOffline(true);
      dashboard.setOffline(false);

      const hubCard = container.querySelector('[data-hub-agent-id="hub-1"]') as HTMLElement;
      const buttons = hubCard.querySelectorAll('.agent-card__controls button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });
  });

  describe('Dashboard: new cards inherit offline state', () => {
    it('disables an agent card added while offline', () => {
      const manager = mockAgentManager();
      const onCreatedCb = vi.fn<(cb: (agent: AgentContainer) => void) => () => void>();
      (manager as any).onAgentCreated = (cb: (agent: AgentContainer) => void) => {
        onCreatedCb(cb);
        return () => {};
      };
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);

      // Simulate a new agent being created while offline
      const newAgent = mockAgent({ id: 'agent-new', name: 'New Agent' });
      // Call the captured callback
      const createdCallback = onCreatedCb.mock.calls[0][0];
      createdCallback(newAgent);

      const card = dashboard.getCard('agent-new');
      expect(card).toBeDefined();
      const buttons = card!.getElement().querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
      // Card itself should remain clickable
      expect(card!.getElement().classList.contains('agent-card--disabled')).toBe(false);
    });

    it('disables a hub agent card added while offline', () => {
      const manager = mockAgentManager();
      const dashboard = new Dashboard(container, manager, vi.fn(), vi.fn());

      dashboard.setOffline(true);

      const proxy = mockHubProxy({ hubAgentId: 'hub-new' });
      dashboard.addHubAgentCard(proxy, { onSelect: vi.fn() }, 'My Hub');

      const hubCard = container.querySelector('[data-hub-agent-id="hub-new"]') as HTMLElement;
      expect(hubCard).toBeTruthy();
      const buttons = hubCard.querySelectorAll('.agent-card__controls button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
      // Card itself should remain clickable
      expect(hubCard.classList.contains('agent-card--disabled')).toBe(false);
    });
  });

  describe('AgentCard: renderControls preserves disabled state', () => {
    it('keeps buttons disabled after state change triggers renderControls', () => {
      const agent = mockAgent({ state: 'running' });
      let eventCallback: ((event: any) => void) | null = null;
      (agent as any).onEvent = (cb: (event: any) => void) => {
        eventCallback = cb;
        return () => {};
      };

      const card = new AgentCard(agent, { onSelect: vi.fn() });
      container.appendChild(card.getElement());

      // Disable the card (simulating offline)
      card.setDisabled(true);

      // Verify buttons are disabled
      let buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });

      // Simulate a state change (running -> paused) which triggers renderControls
      (agent as any).state = 'paused';
      eventCallback!({ type: 'state_change', from: 'running', to: 'paused' });

      // After re-render, buttons should still be disabled
      buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('keeps buttons enabled after state change when not disabled', () => {
      const agent = mockAgent({ state: 'running' });
      let eventCallback: ((event: any) => void) | null = null;
      (agent as any).onEvent = (cb: (event: any) => void) => {
        eventCallback = cb;
        return () => {};
      };

      const card = new AgentCard(agent, { onSelect: vi.fn() });
      container.appendChild(card.getElement());

      // Simulate a state change without disabling
      (agent as any).state = 'paused';
      eventCallback!({ type: 'state_change', from: 'running', to: 'paused' });

      const buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });
  });

  describe('HubAgentCard: renderControls preserves disabled state', () => {
    it('keeps buttons disabled after state change triggers renderControls', () => {
      const proxy = mockHubProxy({ state: 'running' });
      let eventCallback: ((event: any) => void) | null = null;
      (proxy as any).onEvent = (cb: (event: any) => void) => {
        eventCallback = cb;
        return () => {};
      };

      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'Test Hub');
      container.appendChild(card.getElement());

      // Disable the card (simulating offline)
      card.setDisabled(true);

      // Verify buttons are disabled
      let buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });

      // Simulate a state change (running -> paused) which triggers renderControls
      eventCallback!({ type: 'state_change', data: { from: 'running', to: 'paused' } });

      // After re-render, buttons should still be disabled
      buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('keeps buttons enabled after state change when not disabled', () => {
      const proxy = mockHubProxy({ state: 'running' });
      let eventCallback: ((event: any) => void) | null = null;
      (proxy as any).onEvent = (cb: (event: any) => void) => {
        eventCallback = cb;
        return () => {};
      };

      const card = new HubAgentCard(proxy, { onSelect: vi.fn() }, 'Test Hub');
      container.appendChild(card.getElement());

      // Simulate a state change without disabling
      eventCallback!({ type: 'state_change', data: { from: 'running', to: 'paused' } });

      const buttons = card.getElement().querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });
  });

  describe('AgentView: header buttons disabled when offline', () => {
    let agentView: AgentView;
    let viewContainer: HTMLElement;

    beforeEach(() => {
      viewContainer = document.createElement('div');
      document.body.appendChild(viewContainer);
      agentView = new AgentView(viewContainer, {
        onPause: vi.fn(),
        onResume: vi.fn(),
        onStop: vi.fn(),
        onKill: vi.fn(),
        onRestart: vi.fn(),
        onSettings: vi.fn(),
        onFiles: vi.fn(),
        onPersist: vi.fn(),
      });
      // Enable header by setting a back callback
      agentView.setOnBack(() => {});
    });

    afterEach(() => {
      agentView.destroy();
      viewContainer.remove();
    });

    it('disables action buttons when offline event fires', () => {
      const agent = mockAgent({ state: 'running' });
      agentView.mount(agent);

      // Verify buttons are initially enabled
      const actionsEl = viewContainer.querySelector('.agent-view__actions');
      expect(actionsEl).toBeTruthy();
      let buttons = actionsEl!.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });

      // Go offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
      window.dispatchEvent(new Event('offline'));

      // Buttons should now be disabled
      buttons = actionsEl!.querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('disables mode toggle (persist button) when offline', () => {
      const agent = mockAgent({ state: 'running' });
      agentView.mount(agent);

      const modeToggle = viewContainer.querySelector('.agent-view__mode-toggle--browser');
      expect(modeToggle).toBeTruthy();
      expect(modeToggle!.classList.contains('agent-view__mode-toggle--disabled')).toBe(false);

      // Go offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
      window.dispatchEvent(new Event('offline'));

      expect(modeToggle!.classList.contains('agent-view__mode-toggle--disabled')).toBe(true);

      // Go back online
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
      window.dispatchEvent(new Event('online'));

      expect(modeToggle!.classList.contains('agent-view__mode-toggle--disabled')).toBe(false);
    });

    it('re-enables action buttons when online event fires', () => {
      const agent = mockAgent({ state: 'running' });
      agentView.mount(agent);

      // Go offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
      window.dispatchEvent(new Event('offline'));

      const actionsEl = viewContainer.querySelector('.agent-view__actions');
      let buttons = actionsEl!.querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });

      // Go back online
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true, configurable: true });
      window.dispatchEvent(new Event('online'));

      buttons = actionsEl!.querySelectorAll('button');
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it('disables new buttons when renderHeaderActions is called while offline', () => {
      const agent = mockAgent({ state: 'running' });
      agentView.mount(agent);

      // Go offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
      window.dispatchEvent(new Event('offline'));

      // Re-render header actions (simulates a state change while offline)
      agentView.renderHeaderActions('paused');

      const actionsEl = viewContainer.querySelector('.agent-view__actions');
      const buttons = actionsEl!.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });

    it('applies offline state on construction if navigator.onLine is false', () => {
      // Clean up the existing view first
      agentView.destroy();
      viewContainer.remove();

      // Create a new container while offline
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true, configurable: true });
      viewContainer = document.createElement('div');
      document.body.appendChild(viewContainer);
      agentView = new AgentView(viewContainer, {
        onPause: vi.fn(),
        onStop: vi.fn(),
      });
      agentView.setOnBack(() => {});

      const agent = mockAgent({ state: 'running' });
      agentView.mount(agent);

      const actionsEl = viewContainer.querySelector('.agent-view__actions');
      const buttons = actionsEl!.querySelectorAll('button');
      expect(buttons.length).toBeGreaterThan(0);
      buttons.forEach(btn => {
        expect((btn as HTMLButtonElement).disabled).toBe(true);
      });
    });
  });
});
