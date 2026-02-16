import type { AgentConfig } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { HubClient } from '../../shell/hub-client.js';
import type { AgentSettingsCallbacks } from './panel.js';
import { createFormField } from '../dom-helpers.js';

/**
 * Create the Hub section content for the agent settings panel.
 * Contains hub connection selector, sandbox path, and tools display.
 */
export function createHubSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
  hubClient: HubClient | null,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-hub';

  if (!hubClient) {
    const notice = document.createElement('p');
    notice.textContent = 'No hub client available.';
    el.appendChild(notice);
    return el;
  }

  const connections = hubClient.getConnections();

  // Hub selector
  const { field: selectField, input: hubSelect } = createFormField({
    label: 'Hub Connection',
    type: 'select',
    className: 'agent-settings__hub-select',
  });

  // Add "None" option
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'None (first available)';
  hubSelect.appendChild(noneOption);

  // Add connection options
  for (const conn of connections) {
    const option = document.createElement('option');
    option.value = conn.id;
    option.textContent = conn.name + (conn.connected ? '' : ' (disconnected)');
    if (conn.id === agent.config.hubConnectionId) {
      option.selected = true;
    }
    hubSelect.appendChild(option);
  }

  // Sandbox path input (editable)
  const { field: sandboxField, input: sandboxInput } = createFormField({
    label: 'Sandbox Path',
    type: 'input',
    className: 'settings-hub__sandbox-path',
    placeholder: '(uses hub default)',
    value: agent.config.hubSandboxPath || '',
  });

  const sandboxNote = document.createElement('small');
  sandboxNote.className = 'settings-hub__note';
  sandboxNote.textContent = 'Working directory for hub tools';

  // Save handler for sandbox path
  sandboxInput.addEventListener('change', () => {
    const changes: Partial<AgentConfig> = {
      hubSandboxPath: sandboxInput.value.trim() || undefined,
    };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  });

  sandboxField.appendChild(sandboxNote);

  // Hub tools display
  const toolsField = document.createElement('div');
  toolsField.className = 'form-field';
  const toolsLabel = document.createElement('label');
  toolsLabel.className = 'form-field__label';
  toolsLabel.textContent = 'Hub Tools';

  const toolsList = document.createElement('div');
  toolsList.className = 'settings-hub__tools';

  const updateToolsList = () => {
    toolsList.innerHTML = '';
    const selectedId = hubSelect.value;
    if (selectedId && hubClient) {
      const conn = hubClient.getConnection(selectedId);
      if (conn && conn.tools.length > 0) {
        for (const tool of conn.tools) {
          const toolItem = document.createElement('span');
          toolItem.className = 'settings-hub__tool-item';
          toolItem.textContent = tool.name;
          toolsList.appendChild(toolItem);
        }
      } else {
        toolsList.textContent = '(no tools)';
      }
    } else {
      toolsList.textContent = '(select a hub to see tools)';
    }
  };

  updateToolsList();

  toolsField.appendChild(toolsLabel);
  toolsField.appendChild(toolsList);

  // Save handler
  hubSelect.addEventListener('change', () => {
    const changes: Partial<AgentConfig> = {
      hubConnectionId: hubSelect.value || undefined,
    };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
    updateToolsList();
  });

  el.appendChild(selectField);
  el.appendChild(sandboxField);
  el.appendChild(toolsField);
  return el;
}
