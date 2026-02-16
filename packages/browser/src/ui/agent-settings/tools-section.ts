import type { AgentConfig, ToolDef } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import { getBuiltinToolDefinitions } from '../../agent/tools/builtin-tools.js';
import type { HubClient } from '../../shell/hub-client.js';
import type { AgentSettingsCallbacks } from './panel.js';

/**
 * Create the Tools section content for the agent settings panel.
 * Contains tool checkboxes for builtin and hub tools with restart warning.
 */
export function createToolsSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
  hubClient: HubClient | null,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-tools';

  // Track the original enabled tools at panel open time
  const originalToolNames = new Set(agent.config.tools.map(t => t.name));
  // Current enabled tools (modified as user clicks)
  const currentToolNames = new Set(originalToolNames);

  // Get all builtin tools
  const builtinTools = getBuiltinToolDefinitions();

  // Get hub tools if available
  const hubTools: ToolDef[] = [];
  if (hubClient) {
    const connections = hubClient.getConnections();
    for (const conn of connections) {
      for (const tool of conn.tools) {
        // Avoid duplicates
        if (!hubTools.some(t => t.name === tool.name)) {
          hubTools.push(tool);
        }
      }
    }
  }

  // Warning message container (initially hidden)
  const warningContainer = document.createElement('div');
  warningContainer.className = 'settings-tools__warning';
  warningContainer.style.display = 'none';

  const warningText = document.createElement('span');
  warningText.className = 'settings-tools__warning-text';
  warningText.textContent = 'Tools changed (requires restart)';

  const restartBtn = document.createElement('button');
  restartBtn.className = 'btn btn--small settings-tools__restart-btn';
  restartBtn.textContent = 'Restart Now';
  restartBtn.addEventListener('click', () => {
    callbacks.onRestartAgent?.(agent.id);
  });

  warningContainer.appendChild(warningText);
  warningContainer.appendChild(restartBtn);
  el.appendChild(warningContainer);

  // Helper to check if tools have changed from original
  const updateWarningVisibility = () => {
    const hasChanged =
      currentToolNames.size !== originalToolNames.size ||
      ![...currentToolNames].every(name => originalToolNames.has(name));

    warningContainer.style.display = hasChanged ? 'flex' : 'none';
  };

  // Helper to create a tool checkbox
  const createToolCheckbox = (tool: ToolDef, isHub: boolean) => {
    const label = document.createElement('label');
    label.className = 'tool-checkbox';
    if (isHub) {
      label.classList.add('tool-checkbox--hub');
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tool-checkbox__input';
    checkbox.dataset.toolName = tool.name;
    checkbox.checked = currentToolNames.has(tool.name);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        currentToolNames.add(tool.name);
      } else {
        currentToolNames.delete(tool.name);
      }

      // Update the agent config tools array
      const allAvailableTools = [...builtinTools, ...hubTools];
      const newTools = allAvailableTools.filter(t => currentToolNames.has(t.name));
      const changes = { tools: newTools };
      // Update agent config directly for persistence
      (agent.config as AgentConfig).tools = newTools;
      callbacks.onConfigChange?.(agent.id, changes);

      updateWarningVisibility();
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'tool-checkbox__name';
    nameSpan.textContent = tool.name;

    label.appendChild(checkbox);
    label.appendChild(nameSpan);

    if (isHub) {
      const hubBadge = document.createElement('span');
      hubBadge.className = 'tool-checkbox__badge';
      hubBadge.textContent = 'hub';
      label.appendChild(hubBadge);
    }

    return label;
  };

  // Builtin tools section
  const builtinSection = document.createElement('div');
  builtinSection.className = 'settings-tools__group';

  const builtinLabel = document.createElement('div');
  builtinLabel.className = 'settings-tools__group-label';
  builtinLabel.textContent = 'Builtin Tools';
  builtinSection.appendChild(builtinLabel);

  const builtinCheckboxes = document.createElement('div');
  builtinCheckboxes.className = 'tool-checkboxes';
  for (const tool of builtinTools) {
    builtinCheckboxes.appendChild(createToolCheckbox(tool, false));
  }
  builtinSection.appendChild(builtinCheckboxes);
  el.appendChild(builtinSection);

  // Hub tools section (only if there are any)
  if (hubTools.length > 0) {
    const hubSection = document.createElement('div');
    hubSection.className = 'settings-tools__group settings-tools__group--hub';

    const hubLabel = document.createElement('div');
    hubLabel.className = 'settings-tools__group-label';
    hubLabel.textContent = 'Hub Tools';
    hubSection.appendChild(hubLabel);

    const hubCheckboxes = document.createElement('div');
    hubCheckboxes.className = 'tool-checkboxes tool-checkboxes--hub';
    for (const tool of hubTools) {
      hubCheckboxes.appendChild(createToolCheckbox(tool, true));
    }
    hubSection.appendChild(hubCheckboxes);
    el.appendChild(hubSection);
  }

  return el;
}
