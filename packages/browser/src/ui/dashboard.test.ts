import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dashboard } from './dashboard.js';
import type { AgentManager } from '../shell/agent-manager.js';
import type { AgentContainer } from '../agent/agent-container.js';

function createMockAgent(id: string, name: string = 'Agent'): AgentContainer {
  return {
    id,
    config: { id, name, model: 'test', tools: [], maxTokens: 4096 },
    state: 'running',
    onEvent: vi.fn(() => () => {}),
    getIframeElement: vi.fn(() => null),
  } as any;
}

function createMockManager(agents: AgentContainer[] = []): AgentManager & { _fireCreated: (agent: AgentContainer) => void; _fireTerminated: (id: string) => void; _fireKilled: (id: string) => void } {
  const createdCallbacks: Function[] = [];
  const terminatedCallbacks: Function[] = [];
  const killedCallbacks: Function[] = [];

  return {
    getAllAgents: vi.fn(() => agents),
    getAgentCount: vi.fn(() => agents.length),
    onAgentCreated: vi.fn((cb) => { createdCallbacks.push(cb); return () => {}; }),
    onAgentTerminated: vi.fn((cb) => { terminatedCallbacks.push(cb); return () => {}; }),
    onAgentKilled: vi.fn((cb) => { killedCallbacks.push(cb); return () => {}; }),
    onActiveAgentChanged: vi.fn(() => () => {}),
    _fireCreated: (agent: AgentContainer) => createdCallbacks.forEach(cb => cb(agent)),
    _fireTerminated: (id: string) => terminatedCallbacks.forEach(cb => cb(id)),
    _fireKilled: (id: string) => killedCallbacks.forEach(cb => cb(id)),
  } as any;
}

describe('Dashboard', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('renders grid with new-agent card', () => {
    const manager = createMockManager();
    new Dashboard(container, manager, vi.fn(), vi.fn());

    expect(container.querySelector('.dashboard-grid')).toBeTruthy();
    expect(container.querySelector('.agent-card--new')).toBeTruthy();
  });

  it('renders existing agent cards', () => {
    const agents = [createMockAgent('a1', 'Agent 1'), createMockAgent('a2', 'Agent 2')];
    const manager = createMockManager(agents);
    new Dashboard(container, manager, vi.fn(), vi.fn());

    const cards = container.querySelectorAll('.agent-card:not(.agent-card--new)');
    expect(cards).toHaveLength(2);
  });

  it('adds card when agent is created', () => {
    const manager = createMockManager();
    new Dashboard(container, manager, vi.fn(), vi.fn());

    const newAgent = createMockAgent('a1', 'New');
    manager._fireCreated(newAgent);

    const cards = container.querySelectorAll('.agent-card:not(.agent-card--new)');
    expect(cards).toHaveLength(1);
  });

  it('removes card when agent is terminated', () => {
    const agent = createMockAgent('a1');
    const manager = createMockManager([agent]);
    new Dashboard(container, manager, vi.fn(), vi.fn());

    manager._fireTerminated('a1');

    const cards = container.querySelectorAll('.agent-card:not(.agent-card--new)');
    expect(cards).toHaveLength(0);
  });

  it('calls onAgentSelect when card is clicked', () => {
    const agent = createMockAgent('a1');
    const manager = createMockManager([agent]);
    const onSelect = vi.fn();
    new Dashboard(container, manager, onSelect, vi.fn());

    const card = container.querySelector('.agent-card:not(.agent-card--new)') as HTMLElement;
    card.click();

    expect(onSelect).toHaveBeenCalledWith('a1');
  });

  it('calls onNewAgent when new-agent card is clicked', () => {
    const manager = createMockManager();
    const onNew = vi.fn();
    new Dashboard(container, manager, vi.fn(), onNew);

    const newCard = container.querySelector('.agent-card--new') as HTMLElement;
    newCard.click();

    expect(onNew).toHaveBeenCalled();
  });

  it('keeps card when agent is killed (only terminated removes)', () => {
    const agent = createMockAgent('a1');
    const manager = createMockManager([agent]);
    new Dashboard(container, manager, vi.fn(), vi.fn());

    // Killing an agent fires onAgentKilled, NOT onAgentTerminated
    // Dashboard only subscribes to onAgentTerminated for card removal
    // So the card should remain after kill
    manager._fireKilled('a1');

    const cards = container.querySelectorAll('.agent-card:not(.agent-card--new)');
    expect(cards).toHaveLength(1);
  });

  it('passes card callbacks to agent cards', () => {
    const agent = createMockAgent('a1');
    const manager = createMockManager([agent]);
    const onPause = vi.fn();
    new Dashboard(container, manager, vi.fn(), vi.fn(), { onPause });

    // The card should exist with controls
    const card = container.querySelector('.agent-card:not(.agent-card--new)');
    expect(card).toBeTruthy();
  });
});
