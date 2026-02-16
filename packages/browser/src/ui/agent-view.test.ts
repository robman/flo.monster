import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentView } from './agent-view.js';
import * as mobileUtils from './mobile-utils.js';

function createMockAgent(id: string = 'test-1') {
  return {
    id,
    config: { name: 'Test Agent' },
    getIframeElement: () => null,
    onEvent: vi.fn(() => vi.fn()),
    sendUserMessage: vi.fn(),
    setMobileStatus: vi.fn(),
  } as any;
}

describe('AgentView', () => {
  // Mock mobile utils for all tests by default
  beforeEach(() => {
    vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
    vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates split pane layout', () => {
    const container = document.createElement('div');
    new AgentView(container);
    expect(container.querySelector('.agent-view')).toBeTruthy();
    expect(container.querySelector('.agent-view__iframe-pane')).toBeTruthy();
    expect(container.querySelector('.agent-view__conversation-pane')).toBeTruthy();
  });

  it('mount subscribes to events (iframe managed externally)', () => {
    const container = document.createElement('div');
    const view = new AgentView(container);

    const mockAgent = createMockAgent();
    view.mount(mockAgent);

    // Iframe is no longer appended by mount — managed by persistent container
    expect(mockAgent.onEvent).toHaveBeenCalled();
  });

  it('unmount unsubscribes from events', () => {
    const container = document.createElement('div');
    const view = new AgentView(container);

    const unsub = vi.fn();
    const mockAgent = {
      getIframeElement: () => document.createElement('iframe'),
      onEvent: vi.fn(() => unsub),
      sendUserMessage: vi.fn(),
      setMobileStatus: vi.fn(),
    } as any;

    view.mount(mockAgent);
    view.unmount();

    expect(unsub).toHaveBeenCalled();
  });

  it('getConversation returns ConversationView instance', () => {
    const container = document.createElement('div');
    const view = new AgentView(container);
    expect(view.getConversation()).toBeDefined();
  });

  it('getIframePane returns iframe pane element', () => {
    const container = document.createElement('div');
    const view = new AgentView(container);
    expect(view.getIframePane().className).toBe('agent-view__iframe-pane');
  });

  it('constructor accepts optional callbacks', () => {
    const container = document.createElement('div');
    const view = new AgentView(container, { onPause: vi.fn() });
    expect(container.querySelector('.agent-view')).toBeTruthy();
  });

  describe('header actions', () => {
    it('shows pause/stop when running', () => {
      const container = document.createElement('div');
      const onPause = vi.fn();
      const onStop = vi.fn();
      const view = new AgentView(container, { onPause, onStop });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const actions = container.querySelector('.agent-view__actions');
      const buttons = actions?.querySelectorAll('.agent-view__action-btn');
      expect(buttons?.length).toBeGreaterThanOrEqual(2);
      expect(buttons?.[0].textContent).toContain('Pause');
      expect(buttons?.[1].textContent).toContain('Stop');
    });

    it('calls onPause callback when pause button is clicked', () => {
      const container = document.createElement('div');
      const onPause = vi.fn();
      const view = new AgentView(container, { onPause });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const pauseBtn = container.querySelector('.agent-view__action-btn') as HTMLElement;
      pauseBtn.click();
      expect(onPause).toHaveBeenCalledWith('test-1');
    });

    it('shows resume/stop when paused', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onResume: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('paused');

      const actions = container.querySelector('.agent-view__actions');
      const buttons = actions?.querySelectorAll('.agent-view__action-btn');
      expect(buttons?.[0].textContent).toContain('Resume');
      expect(buttons?.[1].textContent).toContain('Stop');
    });

    it('shows restart for stopped', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onRestart: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('stopped');

      const actions = container.querySelector('.agent-view__actions');
      const buttons = actions?.querySelectorAll('.agent-view__action-btn');
      expect(buttons?.[0].textContent).toContain('Restart');
    });

    it('shows restart for killed', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onRestart: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('killed');

      const actions = container.querySelector('.agent-view__actions');
      const buttons = actions?.querySelectorAll('.agent-view__action-btn');
      expect(buttons?.[0].textContent).toContain('Restart');
    });

    it('shows restart for error', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onRestart: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('error');

      const actions = container.querySelector('.agent-view__actions');
      const buttons = actions?.querySelectorAll('.agent-view__action-btn');
      expect(buttons?.[0].textContent).toContain('Restart');
    });

    it('shows settings gear for non-pending states', () => {
      const container = document.createElement('div');
      const onSettings = vi.fn();
      const view = new AgentView(container, { onSettings });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const buttons = container.querySelectorAll('.agent-view__action-btn');
      const lastBtn = buttons[buttons.length - 1];
      expect(lastBtn.textContent).toContain('\u2699');

      (lastBtn as HTMLElement).click();
      expect(onSettings).toHaveBeenCalledWith('test-1');
    });

    it('does not show settings gear for pending state', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onSettings: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('pending');

      const buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons.length).toBe(0);
    });

    it('updates buttons on state change', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, {});
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);

      view.renderHeaderActions('running');
      let buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons[0].textContent).toContain('Pause');

      view.renderHeaderActions('paused');
      buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons[0].textContent).toContain('Resume');

      view.renderHeaderActions('stopped');
      buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons[0].textContent).toContain('Restart');
    });

    it('does nothing if actionsEl not initialized (no setOnBack called)', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);

      // Should not throw
      view.renderHeaderActions('running');
      const buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons.length).toBe(0);
    });

    it('shows files button for non-pending states', () => {
      const container = document.createElement('div');
      const onFiles = vi.fn();
      const view = new AgentView(container, { onFiles });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const buttons = container.querySelectorAll('.agent-view__action-btn');
      const filesBtn = Array.from(buttons).find(b => b.getAttribute('title') === 'Files');
      expect(filesBtn).toBeTruthy();
      expect(filesBtn!.textContent).toContain('\uD83D\uDCC2');

      (filesBtn as HTMLElement).click();
      expect(onFiles).toHaveBeenCalledWith('test-1');
    });

    it('does not show files button for pending state', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onFiles: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('pending');

      const buttons = container.querySelectorAll('.agent-view__action-btn');
      const filesBtn = Array.from(buttons).find(b => b.getAttribute('title') === 'Files');
      expect(filesBtn).toBeFalsy();
    });

    it('does nothing if no agent mounted', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onPause: vi.fn() });
      view.setOnBack(() => {});

      // renderHeaderActions without mounting an agent
      view.renderHeaderActions('running');
      const buttons = container.querySelectorAll('.agent-view__action-btn');
      expect(buttons.length).toBe(0);
    });
  });

  describe('mobile viewport handling', () => {
    let container: HTMLElement;
    let agentView: AgentView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      if (agentView) {
        agentView.destroy();
      }
      container.remove();
      vi.restoreAllMocks();
    });

    it('should track mobile viewport state', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);

      expect(agentView.isMobileViewport()).toBe(true);
    });

    it('should not allow max state on mobile', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render to show controls
      agentView.setViewState('max');

      // Should fall back to chat-only instead of max
      expect(agentView.getViewState()).toBe('chat-only');
    });

    it('should auto-transition from max to chat-only when viewport shrinks', () => {
      let viewportChangeCallback: ((isMobile: boolean) => void) | null = null;

      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockImplementation((cb) => {
        viewportChangeCallback = cb;
        return () => {};
      });

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render
      expect(agentView.getViewState()).toBe('max');

      // Simulate viewport shrinking to mobile
      viewportChangeCallback!(true);

      expect(agentView.getViewState()).toBe('chat-only');
      expect(agentView.isMobileViewport()).toBe(true);
    });

    it('should show short back button text on mobile', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const backBtn = container.querySelector('.agent-view__back-btn');
      expect(backBtn?.textContent).toBe('\u2190');
    });

    it('should show full back button text on desktop', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const backBtn = container.querySelector('.agent-view__back-btn');
      expect(backBtn?.textContent).toBe('\u2190 Dashboard');
    });

    it('should not change state when already on ui-only and viewport shrinks', () => {
      let viewportChangeCallback: ((isMobile: boolean) => void) | null = null;

      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockImplementation((cb) => {
        viewportChangeCallback = cb;
        return () => {};
      });

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render
      agentView.setViewState('ui-only');

      // Simulate viewport shrinking to mobile
      viewportChangeCallback!(true);

      // Should stay on ui-only (not auto-transition)
      expect(agentView.getViewState()).toBe('ui-only');
    });
  });

  describe('view state controls', () => {
    let container: HTMLElement;
    let agentView: AgentView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      if (agentView) {
        agentView.destroy();
      }
      container.remove();
      vi.restoreAllMocks();
    });

    it('should show all 3 states on desktop', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render

      const buttons = container.querySelectorAll('.agent-view__view-btn');
      expect(buttons.length).toBe(3);
    });

    it('should only show 2 states on mobile (no max)', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render

      const buttons = container.querySelectorAll('.agent-view__view-btn');
      expect(buttons.length).toBe(2);
    });

    it('should update controls when viewport changes', () => {
      let viewportChangeCallback: ((isMobile: boolean) => void) | null = null;

      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockImplementation((cb) => {
        viewportChangeCallback = cb;
        return () => {};
      });

      agentView = new AgentView(container);
      agentView.setOnBack(() => {}); // Trigger header render

      expect(container.querySelectorAll('.agent-view__view-btn').length).toBe(3);

      // Simulate viewport shrinking to mobile
      viewportChangeCallback!(true);

      expect(container.querySelectorAll('.agent-view__view-btn').length).toBe(2);
    });
  });

  describe('view state switching', () => {
    let container: HTMLElement;
    let agentView: AgentView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});
    });

    afterEach(() => {
      if (agentView) {
        agentView.destroy();
      }
      container.remove();
      vi.restoreAllMocks();
    });

    it('should switch to ui-only state', () => {
      agentView = new AgentView(container);
      agentView.setViewState('ui-only');

      expect(agentView.getViewState()).toBe('ui-only');
      expect(container.querySelector('.agent-view')?.classList.contains('agent-view--ui-only')).toBe(true);
    });

    it('should switch to chat-only state', () => {
      agentView = new AgentView(container);
      agentView.setViewState('chat-only');

      expect(agentView.getViewState()).toBe('chat-only');
      expect(container.querySelector('.agent-view')?.classList.contains('agent-view--chat-only')).toBe(true);
    });
  });

  describe('viewport close button', () => {
    let container: HTMLElement;
    let agentView: AgentView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});
    });

    afterEach(() => {
      if (agentView) {
        agentView.destroy();
      }
      container.remove();
      vi.restoreAllMocks();
    });

    it('should have close button in wrapperEl', () => {
      agentView = new AgentView(container);
      const closeBtn = container.querySelector('.agent-view__viewport-close');
      expect(closeBtn).not.toBeNull();
    });

    it('close button should have aria-label', () => {
      agentView = new AgentView(container);
      const closeBtn = container.querySelector('.agent-view__viewport-close');
      expect(closeBtn?.getAttribute('aria-label')).toBe('Close');
    });

    it('close button exits ui-only mode to max on desktop', () => {
      agentView = new AgentView(container);
      agentView.setViewState('ui-only');
      expect(agentView.getViewState()).toBe('ui-only');

      const closeBtn = container.querySelector('.agent-view__viewport-close') as HTMLElement;
      closeBtn.click();

      expect(agentView.getViewState()).toBe('max');
    });

    it('close button exits ui-only mode to chat-only on mobile', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      agentView = new AgentView(container);
      agentView.setViewState('ui-only');
      expect(agentView.getViewState()).toBe('ui-only');

      const closeBtn = container.querySelector('.agent-view__viewport-close') as HTMLElement;
      closeBtn.click();

      expect(agentView.getViewState()).toBe('chat-only');
    });

    it('close button is NOT inside the iframe pane', () => {
      agentView = new AgentView(container);
      const iframePane = container.querySelector('.agent-view__iframe-pane');
      const closeBtn = container.querySelector('.agent-view__viewport-close');

      expect(iframePane?.contains(closeBtn)).toBe(false);
    });

    it('ui-only mode adds view-ui-only class to body', () => {
      agentView = new AgentView(container);
      agentView.setViewState('ui-only');
      expect(document.body.classList.contains('view-ui-only')).toBe(true);

      agentView.setViewState('max');
      expect(document.body.classList.contains('view-ui-only')).toBe(false);
    });

    it('close button is child of wrapper element', () => {
      agentView = new AgentView(container);
      const wrapper = container.querySelector('.agent-view');
      const closeBtn = container.querySelector('.agent-view__viewport-close');

      expect(wrapper?.contains(closeBtn)).toBe(true);
      expect(closeBtn?.parentElement).toBe(wrapper);
    });
  });

  describe('destroy', () => {
    it('should cleanup viewport listener', () => {
      const cleanup = vi.fn();
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(false);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(cleanup);

      const container = document.createElement('div');
      const agentView = new AgentView(container);
      agentView.destroy();

      expect(cleanup).toHaveBeenCalled();
      vi.restoreAllMocks();
    });
  });

  describe('mobile hamburger menu', () => {
    let container: HTMLElement;
    let agentView: AgentView;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
    });

    afterEach(() => {
      if (agentView) {
        agentView.destroy();
      }
      container.remove();
      vi.restoreAllMocks();
    });

    it('should render hamburger button in toolbar', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const hamburger = container.querySelector('.agent-view__hamburger');
      expect(hamburger).toBeTruthy();
      expect(hamburger?.textContent).toBe('\u2630');
    });

    it('should render toolbar with hamburger and view controls in header', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const toolbar = container.querySelector('.agent-view__header-toolbar');
      expect(toolbar).toBeTruthy();
      // Hamburger should be inside the toolbar
      expect(toolbar?.querySelector('.agent-view__hamburger')).toBeTruthy();
      // View controls are a direct child of the header (positioned via CSS order on mobile)
      const header = container.querySelector('.agent-view__header');
      expect(header?.querySelector(':scope > .agent-view__view-controls')).toBeTruthy();
    });

    it('should open mobile menu on hamburger click', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;
      hamburger.click();

      expect(container.querySelector('.agent-view__mobile-menu')).toBeTruthy();
      expect(container.querySelector('.agent-view__mobile-menu-backdrop')).toBeTruthy();
    });

    it('should show state-dependent items in mobile menu for running state', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container);
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;
      hamburger.click();

      const items = container.querySelectorAll('.agent-view__mobile-menu-item');
      const labels = Array.from(items).map(i => i.textContent);
      expect(labels).toContain('\u23F8 Pause');
      expect(labels).toContain('\u23F9 Stop');
    });

    it('should close menu when item is clicked', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      const onPause = vi.fn();
      agentView = new AgentView(container, { onPause });
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;
      hamburger.click();

      const pauseItem = Array.from(container.querySelectorAll('.agent-view__mobile-menu-item'))
        .find(i => i.textContent?.includes('Pause')) as HTMLElement;
      pauseItem.click();

      expect(onPause).toHaveBeenCalledWith('test-1');
      expect(container.querySelector('.agent-view__mobile-menu')).toBeNull();
    });

    it('should close menu when backdrop is clicked', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container, {});
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;
      hamburger.click();
      expect(container.querySelector('.agent-view__mobile-menu')).toBeTruthy();

      const backdrop = container.querySelector('.agent-view__mobile-menu-backdrop') as HTMLElement;
      backdrop.click();

      expect(container.querySelector('.agent-view__mobile-menu')).toBeNull();
    });

    it('should toggle menu on repeated hamburger clicks', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container, {});
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;

      hamburger.click();
      expect(container.querySelector('.agent-view__mobile-menu')).toBeTruthy();

      hamburger.click();
      expect(container.querySelector('.agent-view__mobile-menu')).toBeNull();
    });

    it('should close mobile menu on unmount', () => {
      vi.spyOn(mobileUtils, 'isMobileViewport').mockReturnValue(true);
      vi.spyOn(mobileUtils, 'onViewportChange').mockReturnValue(() => {});

      agentView = new AgentView(container, {});
      agentView.setOnBack(() => {});

      const mockAgent = createMockAgent();
      (mockAgent as any).state = 'running';
      agentView.mount(mockAgent);

      const hamburger = container.querySelector('.agent-view__hamburger') as HTMLElement;
      hamburger.click();
      expect(container.querySelector('.agent-view__mobile-menu')).toBeTruthy();

      agentView.unmount();
      expect(container.querySelector('.agent-view__mobile-menu')).toBeNull();
    });
  });

  describe('mode toggle', () => {
    it('shows browser mode toggle in header actions', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onPersist: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const toggle = container.querySelector('.agent-view__mode-toggle--browser');
      expect(toggle).toBeTruthy();
      expect(toggle!.getAttribute('title')).toContain('browser');
    });

    it('does not show mode toggle for pending state', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, { onPersist: vi.fn() });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('pending');

      const toggle = container.querySelector('.agent-view__mode-toggle');
      expect(toggle).toBeFalsy();
    });

    it('calls onPersist when browser mode toggle clicked', () => {
      const container = document.createElement('div');
      const onPersist = vi.fn();
      const view = new AgentView(container, { onPersist });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      const toggle = container.querySelector('.agent-view__mode-toggle--browser') as HTMLElement;
      toggle.click();
      expect(onPersist).toHaveBeenCalledWith('test-1');
    });

    it('shows hub mode toggle after setAgentLocation', () => {
      const container = document.createElement('div');
      const view = new AgentView(container, {});
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.renderHeaderActions('running');

      view.setAgentLocation({ type: 'remote', hubName: 'My Hub' });

      const toggle = container.querySelector('.agent-view__mode-toggle--hub');
      expect(toggle).toBeTruthy();
      expect(toggle!.getAttribute('title')).toContain('My Hub');
      // Browser toggle should be gone
      expect(container.querySelector('.agent-view__mode-toggle--browser')).toBeFalsy();
    });

    it('hub mode toggle is not clickable', () => {
      const container = document.createElement('div');
      const onPersist = vi.fn();
      const view = new AgentView(container, { onPersist });
      view.setOnBack(() => {});

      const mockAgent = createMockAgent();
      view.mount(mockAgent);
      view.setAgentLocation({ type: 'remote', hubName: 'My Hub' });

      const toggle = container.querySelector('.agent-view__mode-toggle--hub') as HTMLElement;
      toggle.click();
      // onPersist should NOT be called for hub mode
      expect(onPersist).not.toHaveBeenCalled();
    });
  });
});
