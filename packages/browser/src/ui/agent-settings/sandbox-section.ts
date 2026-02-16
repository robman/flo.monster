import type { AgentConfig, SandboxPermissions } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { AgentSettingsCallbacks } from './panel.js';

/**
 * Create the Sandbox Permissions section content for the agent settings panel.
 * Contains toggle checkboxes for camera, microphone, and geolocation.
 */
export function createSandboxSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-sandbox-permissions';

  const note = document.createElement('div');
  note.className = 'settings-sandbox-permissions__note';
  note.textContent = 'Enable to allow agent page JS to request these browser permissions. The browser will still show its own permission prompt.';
  el.appendChild(note);

  const permissions: Array<{ key: keyof SandboxPermissions; label: string }> = [
    { key: 'camera', label: 'Camera' },
    { key: 'microphone', label: 'Microphone' },
    { key: 'geolocation', label: 'Geolocation' },
  ];

  for (const perm of permissions) {
    const row = document.createElement('label');
    row.className = 'settings-sandbox-permissions__toggle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'settings-sandbox-permissions__checkbox';
    checkbox.checked = agent.config.sandboxPermissions?.[perm.key] ?? false;
    checkbox.addEventListener('change', () => {
      if (!agent.config.sandboxPermissions) {
        (agent.config as AgentConfig).sandboxPermissions = {};
      }
      agent.config.sandboxPermissions![perm.key] = checkbox.checked;
      const changes: Partial<AgentConfig> = {
        sandboxPermissions: { ...agent.config.sandboxPermissions },
      };
      callbacks.onConfigChange?.(agent.id, changes);
    });

    const label = document.createElement('span');
    label.className = 'settings-sandbox-permissions__label';
    label.textContent = perm.label;

    row.appendChild(checkbox);
    row.appendChild(label);
    el.appendChild(row);
  }

  return el;
}
