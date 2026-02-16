import { describe, it, expect, vi } from 'vitest';
import { AgentCard } from './agent-card.js';

function createMockAgent(id: string = 'a1', state: string = 'running') {
  return {
    id,
    config: { id, name: 'Test Agent', model: 'test', tools: [], maxTokens: 4096 },
    state,
    onEvent: vi.fn(() => () => {}),
  } as any;
}

describe('AgentCard', () => {
  it('renders agent name', () => {
    const agent = createMockAgent('a1');
    const card = new AgentCard(agent, { onSelect: vi.fn() });
    const el = card.getElement();
    expect(el.querySelector('.agent-card__name')!.textContent).toBe('Test Agent');
  });

  it('state label uses textContent not innerHTML', () => {
    const agent = createMockAgent('a1', 'running');
    const card = new AgentCard(agent, { onSelect: vi.fn() });
    const el = card.getElement();
    const stateEl = el.querySelector('.agent-card__state')!;
    // Should contain a span element for the dot, not raw HTML
    const dotSpan = stateEl.querySelector('span');
    expect(dotSpan).toBeTruthy();
    expect(dotSpan!.textContent).toBe('\u25CF');
    expect(stateEl.textContent).toContain('Running');
  });

  it('dispose removes event listener', () => {
    const unsub = vi.fn();
    const agent = {
      ...createMockAgent('a1'),
      onEvent: vi.fn(() => unsub),
    } as any;
    const card = new AgentCard(agent, { onSelect: vi.fn() });
    card.dispose();
    expect(unsub).toHaveBeenCalled();
  });

  describe('controls', () => {
    it('shows pause/stop/kill for running state', () => {
      const mockAgent = createMockAgent();
      mockAgent.state = 'running';
      const card = new AgentCard(mockAgent as any, { onSelect: vi.fn() });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      // pause, stop, kill, files, settings, save as template = 6 buttons
      expect(buttons?.length).toBe(6);
      expect(buttons?.[0].getAttribute('title')).toBe('Pause');
      expect(buttons?.[1].getAttribute('title')).toBe('Stop');
      expect(buttons?.[2].getAttribute('title')).toBe('Kill');
      expect(buttons?.[3].getAttribute('title')).toBe('Files');
      expect(buttons?.[4].getAttribute('title')).toBe('Settings');
      expect(buttons?.[5].getAttribute('title')).toBe('Save as Template');
    });

    it('shows resume/stop/kill for paused state', () => {
      const mockAgent = createMockAgent();
      mockAgent.state = 'paused';
      const card = new AgentCard(mockAgent as any, { onSelect: vi.fn() });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons?.[0].getAttribute('title')).toBe('Resume');
    });

    it('shows restart/delete for stopped state', () => {
      const mockAgent = createMockAgent();
      mockAgent.state = 'stopped';
      const card = new AgentCard(mockAgent as any, { onSelect: vi.fn() });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons?.[0].getAttribute('title')).toBe('Restart');
      expect(buttons?.[1].getAttribute('title')).toBe('Delete');
    });

    it('shows restart/delete for killed state', () => {
      const mockAgent = createMockAgent();
      mockAgent.state = 'killed';
      const card = new AgentCard(mockAgent as any, { onSelect: vi.fn() });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const buttons = controls?.querySelectorAll('.agent-card__control-btn');
      expect(buttons?.[0].getAttribute('title')).toBe('Restart');
      expect(buttons?.[1].getAttribute('title')).toBe('Delete');
    });

    it('gear button fires settings callback', () => {
      const onSettings = vi.fn();
      const mockAgent = createMockAgent();
      mockAgent.state = 'running';
      const card = new AgentCard(mockAgent as any, { onSelect: vi.fn(), onSettings });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const gearBtn = controls?.querySelector('[title="Settings"]') as HTMLElement;
      expect(gearBtn).toBeTruthy();
      gearBtn.click();
      expect(onSettings).toHaveBeenCalledWith(mockAgent.id);
    });

    it('button click does not bubble to card select', () => {
      const onSelect = vi.fn();
      const onPause = vi.fn();
      const mockAgent = createMockAgent();
      mockAgent.state = 'running';
      const card = new AgentCard(mockAgent as any, { onSelect, onPause });
      const controls = card.getElement().querySelector('.agent-card__controls');
      const pauseBtn = controls?.querySelector('[title="Pause"]') as HTMLElement;
      pauseBtn.click();
      expect(onPause).toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  describe('save indicator', () => {
    it('save indicator is hidden by default', () => {
      const agent = createMockAgent();
      const card = new AgentCard(agent as any, { onSelect: vi.fn() });
      const el = card.getElement();
      const indicator = el.querySelector('.save-indicator') as HTMLElement;
      expect(indicator).toBeTruthy();
      expect(indicator.style.display).toBe('none');
    });

    it('setSaveState updates the indicator', () => {
      const agent = createMockAgent();
      const card = new AgentCard(agent as any, { onSelect: vi.fn() });
      card.setSaveState('dirty');
      const el = card.getElement();
      const indicator = el.querySelector('.save-indicator') as HTMLElement;
      expect(indicator.classList.contains('save-indicator--dirty')).toBe(true);
    });

    it('showSaveIndicator(true) makes it visible', () => {
      const agent = createMockAgent();
      const card = new AgentCard(agent as any, { onSelect: vi.fn() });
      card.showSaveIndicator(true);
      const el = card.getElement();
      const indicator = el.querySelector('.save-indicator') as HTMLElement;
      expect(indicator.style.display).toBe('');
    });

    it('showSaveIndicator(false) hides it', () => {
      const agent = createMockAgent();
      const card = new AgentCard(agent as any, { onSelect: vi.fn() });
      card.showSaveIndicator(true);
      const indicator = card.getElement().querySelector('.save-indicator') as HTMLElement;
      expect(indicator.style.display).toBe('');
      card.showSaveIndicator(false);
      expect(indicator.style.display).toBe('none');
    });

    it('dispose cleans up save indicator', () => {
      const agent = createMockAgent();
      const card = new AgentCard(agent as any, { onSelect: vi.fn() });
      const el = card.getElement();
      const indicator = el.querySelector('.save-indicator') as HTMLElement;
      expect(indicator).toBeTruthy();
      card.dispose();
      // After dispose, setSaveState should not throw (saveIndicator is nulled)
      expect(() => card.setSaveState('dirty')).not.toThrow();
      // showSaveIndicator should also not throw
      expect(() => card.showSaveIndicator(true)).not.toThrow();
    });
  });

  describe('mode toggle', () => {
    it('shows browser mode toggle when onPersist callback provided', () => {
      const onPersist = vi.fn();
      const mockAgent = createMockAgent('a1', 'running');
      const card = new AgentCard(mockAgent, { onSelect: vi.fn(), onPersist });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle--browser');
      expect(toggle).toBeTruthy();
      expect(toggle!.getAttribute('title')).toContain('browser');
    });

    it('does not show mode toggle when onPersist callback not provided', () => {
      const mockAgent = createMockAgent('a1', 'running');
      const card = new AgentCard(mockAgent, { onSelect: vi.fn() });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle');
      expect(toggle).toBeFalsy();
    });

    it('does not show mode toggle for pending state', () => {
      const onPersist = vi.fn();
      const mockAgent = createMockAgent('a1', 'pending');
      const card = new AgentCard(mockAgent, { onSelect: vi.fn(), onPersist });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle');
      expect(toggle).toBeFalsy();
    });

    it('calls onPersist when browser mode toggle clicked', () => {
      const onPersist = vi.fn();
      const mockAgent = createMockAgent('a1', 'running');
      const card = new AgentCard(mockAgent, { onSelect: vi.fn(), onPersist });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle--browser') as HTMLElement;
      toggle.click();
      expect(onPersist).toHaveBeenCalledWith('a1');
    });

    it('shows hub mode toggle after setLocation to remote', () => {
      const onPersist = vi.fn();
      const mockAgent = createMockAgent('a1', 'running');
      const card = new AgentCard(mockAgent, { onSelect: vi.fn(), onPersist });
      card.setLocation({ type: 'remote', hubId: 'h1', hubName: 'My Hub' });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle--hub');
      expect(toggle).toBeTruthy();
      expect(toggle!.textContent).toContain('My Hub');
      // Browser toggle should be gone
      expect(el.querySelector('.agent-card__mode-toggle--browser')).toBeFalsy();
    });

    it('hub mode toggle click does not propagate to card select', () => {
      const onSelect = vi.fn();
      const onPersist = vi.fn();
      const mockAgent = createMockAgent('a1', 'running');
      const card = new AgentCard(mockAgent, { onSelect, onPersist });
      const el = card.getElement();
      const toggle = el.querySelector('.agent-card__mode-toggle--browser') as HTMLElement;
      toggle.click();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
