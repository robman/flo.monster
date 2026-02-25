import type { AgentEvent, ToolResult, TokenUsage, CostEstimate, SkillInvocationResult } from '@flo-monster/core';
import { stopAllSpeechSessions } from '../shell/relay/speech-handler.js';

/**
 * Maximum number of turns to keep in the DOM.
 * Older turns are removed to prevent browser bloat.
 * TODO: Add dynamic scrollback - load older turns on scroll up
 */
const MAX_VISIBLE_TURNS = 100;

export class ConversationView {
  private container: HTMLElement;
  private messagesEl: HTMLElement;
  private inputEl: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private micBtn: HTMLButtonElement | null = null;
  private micRecognition: any = null;
  private isMicRecording = false;
  private currentMessageEl: HTMLElement | null = null;
  private rawTextBuffer = '';  // Raw text accumulator for terse tag stripping
  private toolCallEls = new Map<string, HTMLElement>();
  private userMessageCallback: ((text: string) => void) | null = null;
  private skillInvocationCallback: ((name: string, args: string) => SkillInvocationResult | null) | null = null;
  private turnCount = 0;
  private thinkingIndicator: HTMLElement | null = null;
  private startingIndicator: HTMLElement | null = null;
  private agentId: string | null = null;
  private hubOfflineBanner: HTMLElement | null = null;
  private _hubOffline: boolean = false;

  constructor(container: HTMLElement) {
    this.container = container;

    // Create messages area
    this.messagesEl = document.createElement('div');
    this.messagesEl.className = 'conversation';
    container.appendChild(this.messagesEl);

    // Create user input area
    this.inputEl = document.createElement('div');
    this.inputEl.className = 'user-input';

    // Drag handle for resizing textarea upward
    const dragHandle = document.createElement('div');
    dragHandle.className = 'user-input__drag-handle';
    this.setupDragHandle(dragHandle);

    this.textarea = document.createElement('textarea');
    this.textarea.className = 'user-input__textarea';
    this.textarea.placeholder = 'Type a message...';
    this.textarea.rows = 1;
    this.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
      }
    });

    this.sendBtn = document.createElement('button');
    this.sendBtn.className = 'btn btn--primary user-input__send';
    this.sendBtn.textContent = 'Send';
    this.sendBtn.addEventListener('click', () => this.handleSend());

    // Mic button — only if SpeechRecognition is available
    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognitionAPI) {
      this.micBtn = document.createElement('button');
      this.micBtn.className = 'user-input__mic';
      this.micBtn.type = 'button';
      this.micBtn.textContent = '\u{1F3A4}';  // microphone emoji
      this.micBtn.title = 'Voice input';
      this.micBtn.addEventListener('click', () => this.toggleMic());
    }

    const inputRow = document.createElement('div');
    inputRow.className = 'user-input__row';
    inputRow.appendChild(this.textarea);
    if (this.micBtn) {
      inputRow.appendChild(this.micBtn);
    }
    inputRow.appendChild(this.sendBtn);

    this.inputEl.appendChild(dragHandle);
    this.inputEl.appendChild(inputRow);
    container.appendChild(this.inputEl);

    // Disable input when offline
    const originalPlaceholder = this.textarea.placeholder;
    window.addEventListener('offline', () => {
      this.textarea.disabled = true;
      this.textarea.placeholder = 'Offline \u2014 reconnect to send messages';
      this.sendBtn.disabled = true;
      if (this.micBtn) this.micBtn.disabled = true;
    });
    window.addEventListener('online', () => {
      // Only re-enable if not overridden by hub offline state
      if (!this._hubOffline) {
        this.textarea.disabled = false;
        this.textarea.placeholder = originalPlaceholder;
        this.sendBtn.disabled = false;
        if (this.micBtn) this.micBtn.disabled = false;
      }
    });
  }

  handleEvent(event: AgentEvent): void {
    // Handle hub-only event types not in AgentEvent union
    const eventType = (event as any).type as string;
    if (eventType === 'conversation_history') {
      this.renderHistory((event as any).messages);
      return;
    }
    if (eventType === 'hub_user_message' || eventType === 'page_event_message') {
      this.addUserMessage((event as any).content);
      return;
    }
    if (eventType === 'hub_intervention_message') {
      this.addInterventionBlock((event as any).content);
      return;
    }
    if (eventType === 'budget_exceeded') {
      this.showBudgetExceeded((event as any).reason, (event as any).message);
      return;
    }

    switch (event.type) {
      case 'message_start':
        this.startAssistantMessage();
        break;
      case 'text_delta':
        this.appendAssistantText(event.text);
        break;
      case 'tool_use_start':
        this.startToolCall(event.toolUseId, event.toolName);
        break;
      case 'tool_use_input_delta':
        this.updateToolInput(event.toolUseId, event.partialJson);
        break;
      case 'tool_use_done':
        // Could update tool input display with final parsed input
        break;
      case 'tool_result':
        this.completeToolCall(event.toolUseId, event.result);
        break;
      case 'error':
        this.showError(event.error);
        break;
      case 'usage':
        this.showUsage(event.usage, event.cost);
        break;
    }
  }

  startAssistantMessage(): void {
    this.removeThinkingIndicator();
    this.currentMessageEl = document.createElement('div');
    this.currentMessageEl.className = 'message message--assistant';
    this.rawTextBuffer = '';
    this.messagesEl.appendChild(this.currentMessageEl);
    this.scrollToBottom();
  }

  private showThinkingIndicator(): void {
    this.removeThinkingIndicator();
    this.thinkingIndicator = document.createElement('div');
    this.thinkingIndicator.className = 'thinking-indicator';
    this.thinkingIndicator.innerHTML = '<span class="thinking-indicator__dot"></span><span class="thinking-indicator__dot"></span><span class="thinking-indicator__dot"></span>';
    this.messagesEl.appendChild(this.thinkingIndicator);
    this.scrollToBottom();
  }

  private removeThinkingIndicator(): void {
    if (this.thinkingIndicator) {
      this.thinkingIndicator.remove();
      this.thinkingIndicator = null;
    }
  }

  appendAssistantText(text: string): void {
    if (!this.currentMessageEl) {
      this.startAssistantMessage();
    }
    // Append text to the last text node or create one
    // We need to handle this carefully - there might be tool call elements interspersed
    let textNode = this.currentMessageEl!.querySelector('.message__text:last-of-type');
    if (!textNode) {
      textNode = document.createElement('span');
      textNode.className = 'message__text';
      this.currentMessageEl!.appendChild(textNode);
    }

    // Buffer raw text and recompute display (so partial <terse> tags are handled correctly)
    this.rawTextBuffer += text;
    // Strip complete <terse>...</terse> tags
    let cleaned = this.rawTextBuffer.replace(/<terse>[\s\S]*?<\/terse>/g, '');
    // Strip incomplete <terse>... at the end (still streaming, close tag hasn't arrived yet)
    cleaned = cleaned.replace(/<terse>[\s\S]*$/, '');
    textNode.textContent = cleaned.trimEnd();

    this.scrollToBottom();
  }

  startToolCall(id: string, name: string): void {
    if (!this.currentMessageEl) {
      this.startAssistantMessage();
    }
    const toolEl = document.createElement('details');
    toolEl.className = 'tool-call';
    toolEl.dataset.toolId = id;

    const header = document.createElement('summary');
    header.className = 'tool-call__header';
    header.innerHTML = `<span class="tool-call__name">${this.escapeHtml(name)}</span><span class="tool-call__status tool-call__status--running"><span class="spinner"></span></span>`;
    toolEl.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tool-call__body';

    const inputEl = document.createElement('div');
    inputEl.className = 'tool-call__input';
    inputEl.textContent = '';
    body.appendChild(inputEl);

    toolEl.appendChild(body);

    this.toolCallEls.set(id, toolEl);
    this.currentMessageEl!.appendChild(toolEl);
    this.scrollToBottom();
  }

  updateToolInput(id: string, json: string): void {
    const toolEl = this.toolCallEls.get(id);
    if (!toolEl) return;
    const inputEl = toolEl.querySelector('.tool-call__input');
    if (inputEl) {
      inputEl.textContent += json;
    }
    this.scrollToBottom();
  }

  completeToolCall(id: string, result: ToolResult): void {
    const toolEl = this.toolCallEls.get(id);
    if (!toolEl) return;

    // Update status indicator
    const statusEl = toolEl.querySelector('.tool-call__status');
    if (statusEl) {
      statusEl.classList.remove('tool-call__status--running');
      statusEl.classList.add(result.is_error ? 'tool-call__status--error' : 'tool-call__status--success');
      statusEl.textContent = result.is_error ? '\u2717' : '\u2713';
    }

    const body = toolEl.querySelector('.tool-call__body');
    if (body) {
      const resultEl = document.createElement('div');
      resultEl.className = `tool-call__result ${result.is_error ? 'tool-call__result--error' : 'tool-call__result--success'}`;
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      resultEl.textContent = content;
      body.appendChild(resultEl);
    }
    this.scrollToBottom();
  }

  private showBudgetExceeded(reason: string, message: string): void {
    const el = document.createElement('div');
    el.className = 'message message--budget-exceeded';
    el.textContent = message || `Budget exceeded (${reason})`;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  showError(error: string): void {
    this.removeThinkingIndicator();
    const errorEl = document.createElement('div');
    errorEl.className = 'message message--error';
    errorEl.textContent = error;
    this.messagesEl.appendChild(errorEl);
    this.scrollToBottom();
  }

  /** Show a UI-only info message in the conversation (not sent to the LLM). */
  showInfo(text: string): void {
    const infoEl = document.createElement('div');
    infoEl.className = 'message message--info';
    infoEl.textContent = text;
    this.messagesEl.appendChild(infoEl);
    this.scrollToBottom();
  }

  /** Show an intervention notification as a collapsed details block. */
  addInterventionBlock(text: string): void {
    const details = document.createElement('details');
    details.className = 'intervention-block';

    const summary = document.createElement('summary');
    summary.className = 'intervention-block__header';
    summary.innerHTML = '<span class="intervention-block__icon">\u2709</span> User intervention';
    details.appendChild(summary);

    const body = document.createElement('pre');
    body.className = 'intervention-block__body';
    body.textContent = text;
    details.appendChild(body);

    this.messagesEl.appendChild(details);
    // Reset current message so the next text_delta creates a new assistant block
    // below the intervention, not appended to the previous assistant message.
    this.currentMessageEl = null;
    this.scrollToBottom();
  }

  setAgentId(agentId: string): void {
    this.agentId = agentId;
  }

  showUsage(usage: TokenUsage, cost: CostEstimate): void {
    // Dispatch custom event for status bar to pick up
    this.container.dispatchEvent(new CustomEvent('usage-update', {
      bubbles: true,
      detail: { usage, cost, agentId: this.agentId },
    }));
  }

  addUserMessage(text: string): void {
    const msgEl = document.createElement('div');
    msgEl.className = 'message message--user';
    msgEl.textContent = text;
    this.messagesEl.appendChild(msgEl);
    // Reset current message element so next assistant response creates new one
    this.currentMessageEl = null;

    // Track turns and prune old ones
    this.turnCount++;
    this.pruneOldTurns();

    // Show thinking indicator while waiting for response
    this.showThinkingIndicator();

    this.scrollToBottom();
  }

  onUserMessage(callback: (text: string) => void): void {
    this.userMessageCallback = callback;
  }

  onSkillInvocation(cb: (name: string, args: string) => SkillInvocationResult | null): void {
    this.skillInvocationCallback = cb;
  }

  /**
   * Clear all rendered messages and tool calls
   */
  clear(): void {
    this.messagesEl.innerHTML = '';
    this.currentMessageEl = null;
    this.rawTextBuffer = '';
    this.toolCallEls.clear();
    this.turnCount = 0;
  }

  /**
   * Render conversation history from stored messages.
   * Messages follow the Anthropic API format: [{role, content: [...blocks]}]
   * Only renders the last MAX_VISIBLE_TURNS turns.
   */
  renderHistory(messages: Array<{role?: string, type?: string, content: Array<Record<string, unknown>>}>): void {
    this.clear();

    // Count turns (user messages = turns)
    const userMsgIndices: number[] = [];
    messages.forEach((msg, idx) => {
      if (msg.role === 'user') userMsgIndices.push(idx);
    });

    // If we have more turns than MAX_VISIBLE_TURNS, skip older ones
    let startIdx = 0;
    if (userMsgIndices.length > MAX_VISIBLE_TURNS) {
      const skipCount = userMsgIndices.length - MAX_VISIBLE_TURNS;
      startIdx = userMsgIndices[skipCount];
    }

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];
      // Normalize content: accept both string and Anthropic block format
      const content: Array<Record<string, unknown>> = typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : msg.content;
      // Check type field first (new format), then role (legacy)
      if ((msg as any).type === 'announcement' || msg.role === 'system') {
        // UI-only info messages (announcements, legacy system messages)
        for (const block of content) {
          if (block.type === 'text') {
            this.showInfo(block.text as string);
          }
        }
      } else if ((msg as any).type === 'intervention') {
        // Intervention notifications — collapsed details block
        for (const block of content) {
          if (block.type === 'text') {
            this.addInterventionBlock(block.text as string);
          }
        }
      } else if (msg.role === 'user') {
        // User messages: look for text blocks or tool_result blocks
        for (const block of content) {
          if (block.type === 'text') {
            this.addUserMessageWithoutPrune(block.text as string);
          }
          // tool_result blocks in user messages are tool results
          // They'll be matched to tool_use blocks from the assistant message above
          if (block.type === 'tool_result') {
            const toolEl = this.toolCallEls.get(block.tool_use_id as string);
            if (toolEl) {
              const body = toolEl.querySelector('.tool-call__body');
              if (body) {
                const resultEl = document.createElement('div');
                const isError = block.is_error;
                resultEl.className = `tool-call__result ${isError ? 'tool-call__result--error' : 'tool-call__result--success'}`;
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                resultEl.textContent = content;
                body.appendChild(resultEl);

                // Update status indicator
                const statusEl = toolEl.querySelector('.tool-call__status');
                if (statusEl) {
                  statusEl.classList.remove('tool-call__status--running');
                  statusEl.classList.add(isError ? 'tool-call__status--error' : 'tool-call__status--success');
                  statusEl.textContent = isError ? '\u2717' : '\u2713';
                }
              }
            }
          }
        }
        this.turnCount++;
      } else if (msg.role === 'assistant') {
        // Start a new assistant message
        this.startAssistantMessage();

        for (const block of content) {
          if (block.type === 'text') {
            this.appendAssistantText(block.text as string);
          } else if (block.type === 'tool_use') {
            this.startToolCall(block.id as string, block.name as string);
            // Show the input as formatted JSON
            if (block.input) {
              const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
              this.updateToolInput(block.id as string, inputStr);
            }
          }
        }
      }
    }
  }

  /**
   * Add user message without triggering prune (for history rendering)
   */
  private addUserMessageWithoutPrune(text: string): void {
    const msgEl = document.createElement('div');
    msgEl.className = 'message message--user';
    msgEl.textContent = text;
    this.messagesEl.appendChild(msgEl);
    this.currentMessageEl = null;
  }

  /**
   * Remove old turns to keep DOM size manageable.
   * Removes entire user+assistant pairs from the beginning.
   */
  private pruneOldTurns(): void {
    if (this.turnCount <= MAX_VISIBLE_TURNS) return;

    // Count messages to remove (aim to keep MAX_VISIBLE_TURNS turns)
    const turnsToRemove = this.turnCount - MAX_VISIBLE_TURNS;
    let removedTurns = 0;
    let lastRemovedIndex = -1;

    const children = Array.from(this.messagesEl.children);
    for (let i = 0; i < children.length && removedTurns < turnsToRemove; i++) {
      const child = children[i] as HTMLElement;
      if (child.classList.contains('message--user')) {
        removedTurns++;
      }
      lastRemovedIndex = i;
    }

    // Also remove any assistant messages after the last user message we're removing
    for (let i = lastRemovedIndex + 1; i < children.length; i++) {
      const child = children[i] as HTMLElement;
      if (child.classList.contains('message--user')) {
        break;
      }
      lastRemovedIndex = i;
    }

    // Remove all elements up to and including lastRemovedIndex
    for (let i = 0; i <= lastRemovedIndex && i < children.length; i++) {
      children[i].remove();
    }

    this.turnCount = MAX_VISIBLE_TURNS;
  }

  scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private setupDragHandle(handle: HTMLElement): void {
    let startY = 0;
    let startHeight = 0;

    const updateHeight = (clientY: number) => {
      const delta = startY - clientY;
      const newHeight = Math.max(40, Math.min(startHeight + delta, window.innerHeight * 0.5));
      this.textarea.style.height = newHeight + 'px';
    };

    // Mouse events
    const onMouseMove = (e: MouseEvent) => {
      updateHeight(e.clientY);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = this.textarea.offsetHeight;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });

    // Touch events
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      e.preventDefault(); // Prevent scrolling during drag
      updateHeight(e.touches[0].clientY);
    };

    const onTouchEnd = () => {
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };

    handle.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      startY = e.touches[0].clientY;
      startHeight = this.textarea.offsetHeight;
      document.addEventListener('touchmove', onTouchMove, { passive: false });
      document.addEventListener('touchend', onTouchEnd);
      document.addEventListener('touchcancel', onTouchEnd);
    }, { passive: false });
  }

  setInputEnabled(enabled: boolean): void {
    this.textarea.disabled = !enabled;
    this.sendBtn.disabled = !enabled;
    if (this.micBtn) {
      this.micBtn.disabled = !enabled;
    }
    if (!enabled) {
      this.stopMic();
    }
  }

  showStartingIndicator(): void {
    this.removeStartingIndicator();
    this.startingIndicator = document.createElement('div');
    this.startingIndicator.className = 'starting-indicator';
    this.startingIndicator.innerHTML =
      '<span class="thinking-indicator__dot"></span>' +
      '<span class="thinking-indicator__dot"></span>' +
      '<span class="thinking-indicator__dot"></span>' +
      '<span class="starting-indicator__text">Agent starting\u2026</span>';
    this.messagesEl.appendChild(this.startingIndicator);
    this.scrollToBottom();
  }

  removeStartingIndicator(): void {
    if (this.startingIndicator) {
      this.startingIndicator.remove();
      this.startingIndicator = null;
    }
  }

  /**
   * Show or hide the hub offline banner and disable/enable input accordingly.
   */
  setHubOffline(offline: boolean): void {
    if (this._hubOffline === offline) return;
    this._hubOffline = offline;

    if (offline) {
      if (!this.hubOfflineBanner) {
        this.hubOfflineBanner = document.createElement('div');
        this.hubOfflineBanner.className = 'hub-offline-banner';
        this.hubOfflineBanner.textContent = 'Hub offline \u2014 reconnecting\u2026';
      }
      // Insert before the input area
      this.container.insertBefore(this.hubOfflineBanner, this.inputEl);
      this.hubOfflineBanner.style.display = 'flex';
      this.sendBtn.disabled = true;
      this.textarea.disabled = true;
      if (this.micBtn) this.micBtn.disabled = true;
    } else {
      if (this.hubOfflineBanner) {
        this.hubOfflineBanner.style.display = 'none';
      }
      this.sendBtn.disabled = false;
      this.textarea.disabled = false;
      if (this.micBtn) this.micBtn.disabled = false;
    }
  }

  private toggleMic(): void {
    if (this.isMicRecording) {
      this.stopMic();
      return;
    }

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;

    // Stop any agent speech sessions first — Chrome only allows one active instance
    stopAllSpeechSessions();

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
          // Append final results to textarea immediately
          this.textarea.value = finalTranscript;
        } else {
          interim += transcript;
        }
      }
      // Show interim in textarea (final + interim)
      this.textarea.value = finalTranscript + interim;
    };

    recognition.onerror = (event: any) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      console.warn('[ConversationView] Speech recognition error:', event.error);
      this.stopMic();
    };

    recognition.onend = () => {
      // Auto-restart on iOS (stops after silence)
      if (this.isMicRecording && this.micRecognition === recognition) {
        try {
          recognition.start();
        } catch (_e) {
          this.stopMic();
        }
      }
    };

    this.micRecognition = recognition;
    this.isMicRecording = true;
    if (this.micBtn) {
      this.micBtn.classList.add('user-input__mic--recording');
    }

    try {
      recognition.start();
    } catch (_e) {
      this.stopMic();
    }
  }

  private stopMic(): void {
    if (this.micRecognition) {
      this.isMicRecording = false;
      // Null handlers first to prevent onend auto-restart, then abort
      this.micRecognition.onresult = null;
      this.micRecognition.onerror = null;
      this.micRecognition.onend = null;
      try {
        this.micRecognition.abort();
      } catch (_e) { /* ignore */ }
      this.micRecognition = null;
    }
    if (this.micBtn) {
      this.micBtn.classList.remove('user-input__mic--recording');
    }
  }

  private handleSend(): void {
    const text = this.textarea.value.trim();
    if (!text) return;

    // Intercept slash commands
    if (text.startsWith('/')) {
      const match = text.match(/^\/([a-z][a-z0-9-]*)\s*(.*)/);
      if (match && this.skillInvocationCallback) {
        const [, skillName, args] = match;
        // Callback returns null if skill not found
        const result = this.skillInvocationCallback(skillName, args.trim());
        if (result) {
          this.textarea.value = '';
          this.addUserMessage(text);  // Show original slash command in UI
          this.userMessageCallback?.(result.modifiedPrompt);  // Send transformed prompt to agent
          return;
        }
        // If skill not found (result is null), fall through to send as normal message
      }
    }

    // Normal flow
    this.textarea.value = '';
    this.addUserMessage(text);
    if (this.userMessageCallback) {
      this.userMessageCallback(text);
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
