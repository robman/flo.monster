import type { AgentContainer } from '../agent/agent-container.js';
import type { AgentState, AgentViewState, SkillInvocationResult } from '@flo-monster/core';
import { ConversationView } from './conversation.js';
import { isMobileViewport, onViewportChange } from './mobile-utils.js';

function resetThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
  if (meta) meta.content = '#ffffff';
}

export interface AgentViewCallbacks {
  onPause?: (agentId: string) => void;
  onResume?: (agentId: string) => void;
  onStop?: (agentId: string) => void;
  onKill?: (agentId: string) => void;
  onRestart?: (agentId: string) => void;
  onSettings?: (agentId: string) => void;
  onFiles?: (agentId: string) => void;
  onSaveAsTemplate?: (agentId: string) => void;
  onPersist?: (agentId: string) => void;
  onViewStateChange?: (agentId: string, state: AgentViewState) => void;
}

export class AgentView {
  private container: HTMLElement;
  private wrapperEl: HTMLElement;
  private headerEl: HTMLElement;
  private iframePane: HTMLElement;
  private conversationPane: HTMLElement;
  private conversation: ConversationView;
  private agent: AgentContainer | null = null;
  private unsubscribe: (() => void) | null = null;
  private onBackCallback: (() => void) | null = null;
  private viewportCloseBtn: HTMLElement;
  private actionsEl: HTMLElement | null = null;
  private viewStateControlsEl: HTMLElement | null = null;
  private currentViewState: AgentViewState;
  private isMobile: boolean = false;
  private viewportUnsubscribe: (() => void) | null = null;
  private callbacks: AgentViewCallbacks;
  private modeToggleEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private mobileMenuEl: HTMLElement | null = null;
  private mobileMenuBackdrop: HTMLElement | null = null;
  private agentLocation: { type: 'local' } | { type: 'remote'; hubName: string } = { type: 'local' };
  private skillInvocationCallback: ((name: string, args: string) => SkillInvocationResult | null) | null = null;
  private splitterEl: HTMLElement;
  private _offline = false;
  private offlineHandler: (() => void) | null = null;
  private onlineHandler: (() => void) | null = null;
  private contentArea: HTMLElement | null = null;

  constructor(container: HTMLElement, callbacks?: AgentViewCallbacks) {
    this.container = container;
    this.callbacks = callbacks || {};

    // Create wrapper
    this.wrapperEl = document.createElement('div');
    this.wrapperEl.className = 'agent-view';

    // Create header with back button
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'agent-view__header';
    this.headerEl.hidden = true; // Hidden by default (backward compat)
    this.wrapperEl.appendChild(this.headerEl);

    // Create content area
    this.contentArea = document.createElement('div');
    this.contentArea.className = 'agent-view__content';

    this.iframePane = document.createElement('div');
    this.iframePane.className = 'agent-view__iframe-pane';
    this.contentArea.appendChild(this.iframePane);

    this.splitterEl = document.createElement('div');
    this.splitterEl.className = 'agent-view__splitter';
    this.contentArea.appendChild(this.splitterEl);
    this.initSplitter();

    this.conversationPane = document.createElement('div');
    this.conversationPane.className = 'agent-view__conversation-pane';
    this.contentArea.appendChild(this.conversationPane);

    this.wrapperEl.appendChild(this.contentArea);

    // Floating close button for ui-only mode (outside iframe, un-hideable by agent)
    this.viewportCloseBtn = document.createElement('button');
    this.viewportCloseBtn.className = 'agent-view__viewport-close';
    this.viewportCloseBtn.textContent = '\u00D7'; // × symbol
    this.viewportCloseBtn.setAttribute('aria-label', 'Close');
    this.viewportCloseBtn.addEventListener('click', () => {
      // Exit ui-only mode (not navigate away from agent)
      this.setViewState(this.isMobile ? 'chat-only' : 'max');
    });
    this.wrapperEl.appendChild(this.viewportCloseBtn);

    container.appendChild(this.wrapperEl);

    // Create conversation view
    this.conversation = new ConversationView(this.conversationPane);

    // Track viewport mode for mobile responsiveness
    this.isMobile = isMobileViewport();
    // Default to chat-only on mobile, max on desktop
    this.currentViewState = this.isMobile ? 'chat-only' : 'max';
    // Apply initial view state class
    this.wrapperEl.classList.add(`agent-view--${this.currentViewState}`);

    this.viewportUnsubscribe = onViewportChange((isMobile) => {
      const wasDesktop = !this.isMobile;
      this.isMobile = isMobile;

      // Notify agent of mobile status change
      if (this.agent) {
        this.agent.setMobileStatus(isMobile);
      }

      // Auto-transition from 'max' to 'chat-only' when viewport shrinks to mobile
      if (isMobile && wasDesktop && this.currentViewState === 'max') {
        this.setViewState('chat-only');
      }

      // Re-render header to update back button text and view state controls
      if (this.onBackCallback) {
        this.renderHeader(this.agent?.config.name);
        // Re-render actions for current state
        if (this.agent) {
          this.renderHeaderActions(this.agent.state);
        }
      }
    });

    // Offline/online handlers for disabling action buttons
    this.offlineHandler = () => this.setOffline(true);
    this.onlineHandler = () => this.setOffline(false);
    window.addEventListener('offline', this.offlineHandler);
    window.addEventListener('online', this.onlineHandler);
    // Apply initial state
    if (!navigator.onLine) {
      this._offline = true;
    }
  }

  setOnBack(callback: () => void): void {
    this.onBackCallback = callback;
    this.renderHeader();
  }

  setAgentName(name: string): void {
    this.renderHeader(name);
  }

  setSkillInvocationCallback(cb: (name: string, args: string) => SkillInvocationResult | null): void {
    this.skillInvocationCallback = cb;
  }

  private renderHeader(name?: string): void {
    if (!this.onBackCallback) {
      this.headerEl.hidden = true;
      return;
    }

    this.headerEl.hidden = false;
    this.headerEl.innerHTML = '';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn agent-view__back-btn';
    backBtn.textContent = this.isMobile ? '\u2190' : '\u2190 Dashboard';
    backBtn.addEventListener('click', () => this.onBackCallback?.());

    const titleEl = document.createElement('span');
    titleEl.className = 'agent-view__title';
    titleEl.textContent = name || this.agent?.config.name || 'Agent';

    // View state controls
    this.viewStateControlsEl = document.createElement('div');
    this.viewStateControlsEl.className = 'agent-view__view-controls';
    this.renderViewStateControls();

    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'agent-view__actions';

    // Toolbar row for mobile: hamburger (right) — view controls are in header, repositioned via CSS
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'agent-view__header-toolbar';

    const hamburgerBtn = document.createElement('button');
    hamburgerBtn.className = 'btn agent-view__hamburger';
    hamburgerBtn.textContent = '\u2630';
    hamburgerBtn.title = 'Menu';
    hamburgerBtn.addEventListener('click', () => this.toggleMobileMenu());
    this.toolbarEl.appendChild(hamburgerBtn);

    this.headerEl.appendChild(backBtn);
    this.headerEl.appendChild(titleEl);
    this.headerEl.appendChild(this.viewStateControlsEl);
    this.headerEl.appendChild(this.actionsEl);
    this.headerEl.appendChild(this.toolbarEl);
  }

  private renderViewStateControls(): void {
    if (!this.viewStateControlsEl) return;
    this.viewStateControlsEl.innerHTML = '';

    const allStates: { state: AgentViewState; label: string; title: string }[] = [
      { state: 'max', label: '\u25A3', title: 'Full View (UI + Chat)' },
      { state: 'ui-only', label: '\u25A1', title: 'UI Only' },
      { state: 'chat-only', label: '\u2630', title: 'Chat Only' },
    ];

    // Filter out 'max' on mobile viewports
    const states = this.isMobile
      ? allStates.filter(s => s.state !== 'max')
      : allStates;

    for (const { state, label, title } of states) {
      const btn = document.createElement('button');
      btn.className = 'agent-view__view-btn' + (this.currentViewState === state ? ' agent-view__view-btn--active' : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', () => this.setViewState(state));
      this.viewStateControlsEl!.appendChild(btn);
    }
  }

  private static SPLITTER_KEY = 'flo:splitter-ratio';

  private applySplitRatio(ratio: number): void {
    this.iframePane.style.flex = 'none';
    this.iframePane.style.width = `${ratio * 100}%`;
    this.conversationPane.style.flex = 'none';
    this.conversationPane.style.width = `${(1 - ratio) * 100}%`;
  }

  private initSplitter(): void {
    let dragging = false;
    let currentRatio = 0.5;

    // Restore persisted ratio
    try {
      const saved = localStorage.getItem(AgentView.SPLITTER_KEY);
      if (saved) {
        const r = parseFloat(saved);
        if (r >= 0.2 && r <= 0.8) {
          currentRatio = r;
          this.applySplitRatio(r);
        }
      }
    } catch { /* localStorage unavailable */ }

    const onPointerDown = (e: PointerEvent) => {
      if (this.currentViewState !== 'max' || this.isMobile) return;
      e.preventDefault();
      dragging = true;
      this.splitterEl.classList.add('agent-view__splitter--active');
      this.splitterEl.setPointerCapture(e.pointerId);
      // Prevent iframe from stealing pointer events during drag
      this.iframePane.style.pointerEvents = 'none';
      this.conversationPane.style.pointerEvents = 'none';
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !this.contentArea) return;
      const rect = this.contentArea.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const total = rect.width;
      currentRatio = Math.max(0.2, Math.min(0.8, x / total));
      this.applySplitRatio(currentRatio);
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      this.splitterEl.classList.remove('agent-view__splitter--active');
      this.iframePane.style.pointerEvents = '';
      this.conversationPane.style.pointerEvents = '';
      try { localStorage.setItem(AgentView.SPLITTER_KEY, currentRatio.toString()); } catch { /* */ }
    };

    this.splitterEl.addEventListener('pointerdown', onPointerDown);
    this.splitterEl.addEventListener('pointermove', onPointerMove);
    this.splitterEl.addEventListener('pointerup', onPointerUp);
    this.splitterEl.addEventListener('pointercancel', onPointerUp);
  }

  private resetSplitter(): void {
    this.iframePane.style.flex = '';
    this.iframePane.style.width = '';
    this.conversationPane.style.flex = '';
    this.conversationPane.style.width = '';
  }

  private restoreSplitter(): void {
    try {
      const saved = localStorage.getItem(AgentView.SPLITTER_KEY);
      if (saved) {
        const r = parseFloat(saved);
        if (r >= 0.2 && r <= 0.8) this.applySplitRatio(r);
      }
    } catch { /* */ }
  }

  setViewState(state: AgentViewState): void {
    // Don't allow 'max' state on mobile
    if (this.isMobile && state === 'max') {
      state = 'chat-only';
    }

    if (state === this.currentViewState) return;
    // Reset splitter widths when leaving max mode
    if (this.currentViewState === 'max') this.resetSplitter();
    this.currentViewState = state;
    // Restore persisted splitter ratio when entering max mode
    if (state === 'max') this.restoreSplitter();

    // Update wrapper CSS class
    this.wrapperEl.classList.remove('agent-view--max', 'agent-view--ui-only', 'agent-view--chat-only');
    this.wrapperEl.classList.add(`agent-view--${state}`);

    // Toggle body class so elements outside agent-view (top bar, status bar) can hide
    if (state === 'ui-only') {
      document.body.classList.add('view-ui-only');
    } else {
      document.body.classList.remove('view-ui-only');
      resetThemeColor();
    }

    // Update control buttons
    this.renderViewStateControls();

    // Notify agent container
    if (this.agent) {
      this.agent.setViewState(state, 'user');
      this.callbacks.onViewStateChange?.(this.agent.id, state);
    }
  }

  getViewState(): AgentViewState {
    return this.currentViewState;
  }

  private setOffline(offline: boolean): void {
    this._offline = offline;
    this.applyOfflineToActions();
  }

  private applyOfflineToActions(): void {
    if (!this.actionsEl) return;
    const buttons = this.actionsEl.querySelectorAll('button');
    buttons.forEach(btn => {
      (btn as HTMLButtonElement).disabled = this._offline;
    });
    // Also disable the mode toggle (it's a span, not a button)
    if (this.modeToggleEl) {
      this.modeToggleEl.classList.toggle('agent-view__mode-toggle--disabled', this._offline);
    }
  }

  renderHeaderActions(state: AgentState): void {
    if (!this.actionsEl) return;
    this.actionsEl.textContent = '';
    const agentId = this.agent?.id;
    if (!agentId) return;

    const addButton = (label: string, title: string, onClick: () => void, className?: string) => {
      const btn = document.createElement('button');
      btn.className = 'btn agent-view__action-btn' + (className ? ' ' + className : '');
      btn.textContent = label;
      btn.title = title;
      btn.addEventListener('click', onClick);
      this.actionsEl!.appendChild(btn);
    };

    switch (state) {
      case 'running':
        addButton('\u23F8 Pause', 'Pause', () => this.callbacks.onPause?.(agentId));
        addButton('\u23F9 Stop', 'Stop', () => this.callbacks.onStop?.(agentId));
        break;
      case 'paused':
        addButton('\u25B6 Resume', 'Resume', () => this.callbacks.onResume?.(agentId));
        addButton('\u23F9 Stop', 'Stop', () => this.callbacks.onStop?.(agentId));
        break;
      case 'stopped':
      case 'killed':
        addButton('\u21BB Restart', 'Restart', () => this.callbacks.onRestart?.(agentId));
        break;
      case 'error':
        addButton('\u21BB Restart', 'Restart', () => this.callbacks.onRestart?.(agentId));
        break;
    }

    // Always add files, settings, and mode toggle (except pending)
    if (state !== 'pending') {
      addButton('\uD83D\uDCC2 Files', 'Files', () => this.callbacks.onFiles?.(agentId));
      addButton('\uD83D\uDCBE Template', 'Save as Template', () => this.callbacks.onSaveAsTemplate?.(agentId));
      addButton('\u2699', 'Settings', () => this.callbacks.onSettings?.(agentId));

      // Mode toggle: Browser ↔ Hub
      this.modeToggleEl = document.createElement('span');
      this.modeToggleEl.className = 'agent-view__mode-toggle';
      if (this.agentLocation.type === 'local') {
        this.modeToggleEl.classList.add('agent-view__mode-toggle--browser');
        this.modeToggleEl.textContent = '\uD83D\uDDA5'; // 🖥 monitor icon
        this.modeToggleEl.title = 'Running in browser \u2014 click to persist to hub';
        if (this.callbacks.onPersist) {
          this.modeToggleEl.style.cursor = 'pointer';
          this.modeToggleEl.addEventListener('click', () => {
            if (this.agent) this.callbacks.onPersist?.(this.agent.id);
          });
        }
      } else {
        this.modeToggleEl.classList.add('agent-view__mode-toggle--hub');
        this.modeToggleEl.textContent = '\u2601'; // ☁ cloud
        this.modeToggleEl.title = 'Running on hub: ' + this.agentLocation.hubName;
      }
      this.actionsEl!.appendChild(this.modeToggleEl);
    }

    // Re-apply offline state after re-rendering actions
    if (this._offline) {
      this.applyOfflineToActions();
    }
  }

  private toggleMobileMenu(): void {
    if (this.mobileMenuEl) {
      this.closeMobileMenu();
    } else {
      this.openMobileMenu();
    }
  }

  private openMobileMenu(): void {
    this.closeMobileMenu();
    if (!this.agent) return;
    const agentId = this.agent.id;
    const state = this.agent.state;

    // Backdrop for click-outside-to-close
    this.mobileMenuBackdrop = document.createElement('div');
    this.mobileMenuBackdrop.className = 'agent-view__mobile-menu-backdrop';
    this.mobileMenuBackdrop.addEventListener('click', () => this.closeMobileMenu());

    // Menu
    this.mobileMenuEl = document.createElement('div');
    this.mobileMenuEl.className = 'agent-view__mobile-menu';

    const addItem = (label: string, onClick: () => void) => {
      const item = document.createElement('button');
      item.className = 'agent-view__mobile-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        onClick();
        this.closeMobileMenu();
      });
      this.mobileMenuEl!.appendChild(item);
    };

    // State-dependent actions
    switch (state) {
      case 'running':
        addItem('\u23F8 Pause', () => this.callbacks.onPause?.(agentId));
        addItem('\u23F9 Stop', () => this.callbacks.onStop?.(agentId));
        break;
      case 'paused':
        addItem('\u25B6 Resume', () => this.callbacks.onResume?.(agentId));
        addItem('\u23F9 Stop', () => this.callbacks.onStop?.(agentId));
        break;
      case 'stopped':
      case 'killed':
      case 'error':
        addItem('\u21BB Restart', () => this.callbacks.onRestart?.(agentId));
        break;
    }

    // Always-present items (except pending)
    if (state !== 'pending') {
      addItem('\uD83D\uDCC2 Files', () => this.callbacks.onFiles?.(agentId));
      addItem('\uD83D\uDCBE Template', () => this.callbacks.onSaveAsTemplate?.(agentId));
      addItem('\u2699 Settings', () => this.callbacks.onSettings?.(agentId));

      // Mode toggle item
      if (this.agentLocation.type === 'local') {
        addItem('\uD83D\uDDA5 Mode: Browser', () => {
          if (this.agent && this.callbacks.onPersist) {
            this.callbacks.onPersist(this.agent.id);
          }
        });
      } else {
        const modeItem = document.createElement('div');
        modeItem.className = 'agent-view__mobile-menu-item agent-view__mobile-menu-item--info';
        modeItem.textContent = '\u2601 Mode: Hub (' + this.agentLocation.hubName + ')';
        this.mobileMenuEl.appendChild(modeItem);
      }
    }

    this.headerEl.appendChild(this.mobileMenuBackdrop);
    this.headerEl.appendChild(this.mobileMenuEl);
  }

  private closeMobileMenu(): void {
    if (this.mobileMenuBackdrop) {
      this.mobileMenuBackdrop.remove();
      this.mobileMenuBackdrop = null;
    }
    if (this.mobileMenuEl) {
      this.mobileMenuEl.remove();
      this.mobileMenuEl = null;
    }
  }

  setAgentLocation(location: { type: 'local' } | { type: 'remote'; hubName: string }): void {
    this.agentLocation = location;
    // Re-render header to update toggle
    if (this.agent) {
      this.renderHeaderActions(this.agent.state);
    }
  }

  mount(agent: AgentContainer): void {
    this.unmount();
    this.agent = agent;

    // Re-apply body class after unmount() cleared it
    if (this.currentViewState === 'ui-only') {
      document.body.classList.add('view-ui-only');
    }

    // Set agent ID for cost tracking
    this.conversation.setAgentId(agent.id);

    // The iframe is managed by the persistent #agent-iframes container
    // and positioned over the pane via showInPane(). We do NOT move it here.

    // Send initial mobile status to agent
    agent.setMobileStatus(this.isMobile);

    // Set initial hub offline state for hub-persisted agents
    if (agent.hubPersistInfo) {
      this.conversation.setHubOffline(!agent.hubConnected);
    }

    // Subscribe to agent events
    this.unsubscribe = agent.onEvent((event) => {
      this.conversation.handleEvent(event);
      // Handle view state changes from agent
      if (event.type === 'view_state_change' && event.requestedBy === 'agent') {
        this.setViewState(event.to);
      }
      // Update header buttons for all state changes
      if (event.type === 'state_change') {
        this.renderHeaderActions(event.to);
        if (event.to === 'running') {
          this.conversation.removeStartingIndicator();
          if (agent.hubPersistInfo) {
            this.conversation.setInputEnabled(true);
          }
        } else if (agent.hubPersistInfo) {
          // For hub agents, disable input when not running (paused/stopped)
          this.conversation.setInputEnabled(false);
        }
      }
      if (event.type === 'loop_complete') {
        this.conversation.removeStartingIndicator();
      }
      // Handle hub connection changes
      if ((event as any).type === 'hub_connection_change') {
        this.conversation.setHubOffline(!(event as any).connected);
      }
    });

    // Wire up user input
    this.conversation.onUserMessage((text) => {
      agent.sendUserMessage(text);
    });

    // Wire up skill invocation if callback set
    if (this.skillInvocationCallback) {
      this.conversation.onSkillInvocation(this.skillInvocationCallback);
    }

    if (this.onBackCallback) {
      this.renderHeader(agent.config.name);
    }

    // Initial render: buttons and input state from current agent state
    this.renderHeaderActions(agent.state);
    if (agent.hubPersistInfo && agent.state !== 'running') {
      this.conversation.setInputEnabled(false);
    }
  }

  unmount(): void {
    this.closeMobileMenu();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Clear hub offline banner when switching away from agent
    this.conversation.setHubOffline(false);
    this.agent = null;
    document.body.classList.remove('view-ui-only');
    resetThemeColor();
  }

  destroy(): void {
    this.closeMobileMenu();
    this.unmount();
    if (this.offlineHandler) {
      window.removeEventListener('offline', this.offlineHandler);
      this.offlineHandler = null;
    }
    if (this.onlineHandler) {
      window.removeEventListener('online', this.onlineHandler);
      this.onlineHandler = null;
    }
    document.body.classList.remove('view-ui-only');
    resetThemeColor();
    if (this.viewportUnsubscribe) {
      this.viewportUnsubscribe();
      this.viewportUnsubscribe = null;
    }
  }

  isMobileViewport(): boolean {
    return this.isMobile;
  }

  getConversation(): ConversationView {
    return this.conversation;
  }

  getIframePane(): HTMLElement {
    return this.iframePane;
  }
}
