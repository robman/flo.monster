import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentView } from '../agent-view.js';
import type { AgentState } from '@flo-monster/core';

// Mock window.matchMedia for JSDOM (needed by mobile-utils)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

function createMockAgent(id = 'test-agent', state: AgentState = 'pending') {
  let eventCallback: ((event: any) => void) | null = null;
  return {
    id,
    state,
    config: { name: 'Test Agent' },
    hubPersistInfo: undefined as any,
    hubConnected: false,
    setMobileStatus: vi.fn(),
    sendUserMessage: vi.fn(),
    onEvent: vi.fn((cb: any) => {
      eventCallback = cb;
      return () => { eventCallback = null; };
    }),
    _emit: (event: any) => {
      if (eventCallback) eventCallback(event);
    },
  };
}

describe('AgentView state synchronization', () => {
  let container: HTMLElement;
  let view: AgentView;
  let mockAgent: ReturnType<typeof createMockAgent>;

  beforeEach(() => {
    container = document.createElement('div');
    view = new AgentView(container, {});
    mockAgent = createMockAgent();
  });

  it('calls renderHeaderActions on state_change to paused', () => {
    const spy = vi.spyOn(view, 'renderHeaderActions');
    view.mount(mockAgent as any);

    mockAgent._emit({ type: 'state_change', to: 'paused' });

    expect(spy).toHaveBeenCalledWith('paused');
  });

  it('calls renderHeaderActions on state_change to running', () => {
    const spy = vi.spyOn(view, 'renderHeaderActions');
    view.mount(mockAgent as any);

    mockAgent._emit({ type: 'state_change', to: 'running' });

    expect(spy).toHaveBeenCalledWith('running');
  });

  it('removes starting indicator on loop_complete', () => {
    view.mount(mockAgent as any);

    // Access the internal conversation view
    const conversation = (view as any).conversation;
    const removeSpy = vi.spyOn(conversation, 'removeStartingIndicator');

    mockAgent._emit({ type: 'loop_complete' });

    expect(removeSpy).toHaveBeenCalled();
  });

  it('removes starting indicator on state_change to running', () => {
    view.mount(mockAgent as any);

    const conversation = (view as any).conversation;
    const removeSpy = vi.spyOn(conversation, 'removeStartingIndicator');

    mockAgent._emit({ type: 'state_change', to: 'running' });

    expect(removeSpy).toHaveBeenCalled();
  });

  it('disables input on paused for hub-persisted agents', () => {
    mockAgent.hubPersistInfo = { hubAgentId: 'hub-1', hubName: 'Hub', hubConnectionId: 'c1' };
    view.mount(mockAgent as any);

    const conversation = (view as any).conversation;
    const spy = vi.spyOn(conversation, 'setInputEnabled');

    mockAgent._emit({ type: 'state_change', to: 'paused' });

    expect(spy).toHaveBeenCalledWith(false);
  });

  it('disables input on stopped for hub-persisted agents', () => {
    mockAgent.hubPersistInfo = { hubAgentId: 'hub-1', hubName: 'Hub', hubConnectionId: 'c1' };
    view.mount(mockAgent as any);

    const conversation = (view as any).conversation;
    const spy = vi.spyOn(conversation, 'setInputEnabled');

    mockAgent._emit({ type: 'state_change', to: 'stopped' });

    expect(spy).toHaveBeenCalledWith(false);
  });

  it('re-enables input on running after paused for hub-persisted agents', () => {
    mockAgent.hubPersistInfo = { hubAgentId: 'hub-1', hubName: 'Hub', hubConnectionId: 'c1' };
    view.mount(mockAgent as any);

    const conversation = (view as any).conversation;
    const spy = vi.spyOn(conversation, 'setInputEnabled');

    mockAgent._emit({ type: 'state_change', to: 'paused' });
    mockAgent._emit({ type: 'state_change', to: 'running' });

    expect(spy).toHaveBeenLastCalledWith(true);
  });

  it('does not disable input on state_change for local agents', () => {
    // No hubPersistInfo — local agent
    view.mount(mockAgent as any);

    const conversation = (view as any).conversation;
    const spy = vi.spyOn(conversation, 'setInputEnabled');

    mockAgent._emit({ type: 'state_change', to: 'paused' });

    expect(spy).not.toHaveBeenCalled();
  });
});
