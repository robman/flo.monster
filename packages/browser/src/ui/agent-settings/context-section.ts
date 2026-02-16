import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentSettingsCallbacks } from './panel.js';

export function createContextSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
): HTMLElement {
  const container = document.createElement('div');

  // Context mode toggle
  const modeRow = document.createElement('div');
  modeRow.className = 'settings-row';

  const modeLabel = document.createElement('label');
  modeLabel.textContent = 'Context Strategy';
  modeLabel.className = 'settings-label';

  const modeSelect = document.createElement('select');
  modeSelect.className = 'settings-select';
  const slimOpt = document.createElement('option');
  slimOpt.value = 'slim';
  slimOpt.textContent = 'Slim (terse + recent turns)';
  const fullOpt = document.createElement('option');
  fullOpt.value = 'full';
  fullOpt.textContent = 'Full (all messages)';
  modeSelect.appendChild(slimOpt);
  modeSelect.appendChild(fullOpt);
  modeSelect.value = agent.config.contextMode || 'slim';

  modeSelect.addEventListener('change', () => {
    callbacks.onConfigChange?.(agent.id, { contextMode: modeSelect.value as 'slim' | 'full' });
  });

  modeRow.appendChild(modeLabel);
  modeRow.appendChild(modeSelect);
  container.appendChild(modeRow);

  // Full context turns
  const turnsRow = document.createElement('div');
  turnsRow.className = 'settings-row';

  const turnsLabel = document.createElement('label');
  turnsLabel.textContent = 'Recent turns (full detail)';
  turnsLabel.className = 'settings-label';

  const turnsInput = document.createElement('input');
  turnsInput.type = 'number';
  turnsInput.className = 'settings-input';
  turnsInput.min = '1';
  turnsInput.max = '10';
  turnsInput.value = String(agent.config.fullContextTurns ?? 3);

  turnsInput.addEventListener('change', () => {
    const val = Math.max(1, Math.min(10, parseInt(turnsInput.value, 10) || 3));
    turnsInput.value = String(val);
    callbacks.onConfigChange?.(agent.id, { fullContextTurns: val });
  });

  turnsRow.appendChild(turnsLabel);
  turnsRow.appendChild(turnsInput);
  container.appendChild(turnsRow);

  // Description
  const desc = document.createElement('div');
  desc.className = 'settings-help';
  desc.textContent = 'Slim mode sends a terse activity log plus the last N full turns to the LLM. Full mode sends all messages. Both modes support context_search for retrieving details.';
  container.appendChild(desc);

  return container;
}
