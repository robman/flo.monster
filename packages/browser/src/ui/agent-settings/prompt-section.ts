import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentSettingsCallbacks } from './panel.js';

/**
 * Create the System Prompt section content for the agent settings panel.
 * Contains a textarea for editing the system prompt.
 */
export function createPromptSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
): HTMLElement {
  const el = document.createElement('div');

  const textarea = document.createElement('textarea');
  textarea.className = 'form-field__textarea agent-settings__prompt';
  textarea.rows = 6;
  textarea.value = agent.config.systemPrompt || '';
  textarea.placeholder = 'Enter system prompt...';

  // Save on blur
  textarea.addEventListener('blur', () => {
    const changes = { systemPrompt: textarea.value };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  });

  el.appendChild(textarea);
  return el;
}
