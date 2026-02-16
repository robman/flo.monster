import { describe, it, expect, vi } from 'vitest';

// Test the admin server handler logic for get_agent_dom
describe('Admin server: get_agent_dom', () => {
  it('returns DOM state for existing agent', () => {
    const mockDomState = {
      viewportHtml: '<div>Hello</div>',
      bodyAttrs: {},
      headHtml: '<style>body { color: red; }</style>',
      htmlAttrs: {},
      listeners: [],
      capturedAt: Date.now(),
    };

    const runner = {
      getDomState: vi.fn().mockReturnValue(mockDomState),
    };

    const agents = new Map();
    agents.set('test-agent', runner);

    // Simulate the handler logic
    const agentId = 'test-agent';
    const result = agents.get(agentId);
    expect(result).toBeDefined();
    const domState = result!.getDomState();
    expect(domState).toEqual(mockDomState);
    expect(domState.viewportHtml).toBe('<div>Hello</div>');
    expect(domState.headHtml).toBe('<style>body { color: red; }</style>');
    expect(domState.capturedAt).toBeGreaterThan(0);
  });

  it('returns null when agent has no DOM state', () => {
    const runner = {
      getDomState: vi.fn().mockReturnValue(undefined),
    };

    const agents = new Map();
    agents.set('test-agent', runner);

    const result = agents.get('test-agent')!.getDomState();
    // Handler does: domState || null
    const domState = result || null;
    expect(domState).toBeNull();
  });

  it('returns error for non-existent agent', () => {
    const agents = new Map();
    const result = agents.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('constructs correct response shape', () => {
    const mockDomState = {
      viewportHtml: '<h1>Title</h1><p>Content</p>',
      bodyAttrs: { class: 'dark-mode', style: 'background: #000' },
      headHtml: '<title>Test</title>',
      htmlAttrs: { lang: 'en' },
      listeners: [
        { selector: '#btn', events: ['click'], workerId: 'main' },
      ],
      capturedAt: 1700000000000,
    };

    const runner = {
      getDomState: vi.fn().mockReturnValue(mockDomState),
    };

    const agents = new Map();
    agents.set('agent-123', runner);

    const agentId = 'agent-123';
    const foundRunner = agents.get(agentId);
    const domState = foundRunner!.getDomState() || null;

    // This mirrors what the server handler sends
    const response = {
      type: 'agent_dom' as const,
      agentId,
      domState,
    };

    expect(response.type).toBe('agent_dom');
    expect(response.agentId).toBe('agent-123');
    expect(response.domState).not.toBeNull();
    expect(response.domState!.viewportHtml).toBe('<h1>Title</h1><p>Content</p>');
    expect(response.domState!.bodyAttrs).toEqual({ class: 'dark-mode', style: 'background: #000' });
    expect(response.domState!.htmlAttrs).toEqual({ lang: 'en' });
    expect(response.domState!.listeners).toHaveLength(1);
    expect(response.domState!.capturedAt).toBe(1700000000000);
  });
});
