import type { NetworkPolicy } from '@flo-monster/core';
import type { AgentContainer } from '../../agent/agent-container.js';
import type { HubClient } from '../../shell/hub-client.js';
import type { AgentSettingsCallbacks } from './panel.js';
import { createFormField, populateSelect } from '../dom-helpers.js';

/**
 * Create the Network Policy section content for the agent settings panel.
 * Contains mode selector, domain lists, and hub proxy configuration.
 */
export function createNetworkSection(
  agent: AgentContainer,
  callbacks: AgentSettingsCallbacks,
  hubClient: HubClient | null,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-network-policy';

  const policy = agent.config.networkPolicy || { mode: 'allow-all' as const };
  const hasHub = hubClient && hubClient.getConnections().length > 0;

  // Mode selector
  const { field: modeField, input: modeSelect } = createFormField({
    label: 'Mode',
    type: 'select',
    className: 'agent-settings__network-mode',
  });

  populateSelect(
    modeSelect,
    [
      { value: 'allow-all', label: 'Allow All (no restrictions)' },
      { value: 'allowlist', label: 'Allowlist (only specified domains)' },
      { value: 'blocklist', label: 'Blocklist (block specified domains)' },
    ],
    policy.mode,
  );

  // Domains textarea
  const { field: domainsField, label: domainsLabel, input: domainsTextarea } = createFormField({
    label: policy.mode === 'allowlist' ? 'Allowed Domains (one per line)' : 'Blocked Domains (one per line)',
    type: 'textarea',
    className: 'agent-settings__network-domains',
    rows: 4,
    placeholder: 'example.com\napi.example.org',
  });

  domainsLabel.classList.add('agent-settings__network-domains-label');

  // Set initial value based on mode
  if (policy.mode === 'allowlist' && policy.allowedDomains) {
    domainsTextarea.value = policy.allowedDomains.join('\n');
  } else if (policy.mode === 'blocklist' && policy.blockedDomains) {
    domainsTextarea.value = policy.blockedDomains.join('\n');
  }

  // Show/hide domains based on mode
  const updateDomainsVisibility = () => {
    const mode = modeSelect.value as NetworkPolicy['mode'];
    if (mode === 'allow-all') {
      domainsField.style.display = 'none';
    } else {
      domainsField.style.display = 'block';
      domainsLabel.textContent = mode === 'allowlist'
        ? 'Allowed Domains (one per line)'
        : 'Blocked Domains (one per line)';
    }
  };

  updateDomainsVisibility();

  // Hub proxy section (only show if hub is available)
  let hubProxyToggle: HTMLInputElement | null = null;
  let hubProxyPatternsTextarea: HTMLTextAreaElement | null = null;
  let hubProxyContainer: HTMLElement | null = null;

  if (hasHub) {
    hubProxyContainer = document.createElement('div');
    hubProxyContainer.className = 'settings-network-policy__hub-proxy';

    // Toggle: Use hub proxy
    const toggleField = document.createElement('div');
    toggleField.className = 'settings-network-policy__hub-proxy-toggle';

    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'settings-network-policy__hub-proxy-label';
    toggleLabel.textContent = 'Route through hub proxy';

    const toggle = document.createElement('label');
    toggle.className = 'settings-toggle';
    hubProxyToggle = document.createElement('input');
    hubProxyToggle.type = 'checkbox';
    hubProxyToggle.className = 'agent-settings__hub-proxy-toggle';
    hubProxyToggle.checked = policy.useHubProxy === true;
    const slider = document.createElement('span');
    slider.className = 'settings-toggle__slider';
    toggle.appendChild(hubProxyToggle);
    toggle.appendChild(slider);

    toggleField.appendChild(toggleLabel);
    toggleField.appendChild(toggle);

    // Textarea: Hub proxy patterns
    const patternsField = document.createElement('div');
    patternsField.className = 'form-field settings-network-policy__hub-proxy-patterns-field';

    const patternsLabel = document.createElement('label');
    patternsLabel.className = 'form-field__label';
    patternsLabel.textContent = 'Proxy patterns (glob format, one per line)';

    hubProxyPatternsTextarea = document.createElement('textarea');
    hubProxyPatternsTextarea.className = 'form-field__textarea agent-settings__hub-proxy-patterns';
    hubProxyPatternsTextarea.rows = 3;
    hubProxyPatternsTextarea.placeholder = 'https://api.example.com/*\nhttps://*.internal.corp/*';
    hubProxyPatternsTextarea.value = (policy.hubProxyPatterns || []).join('\n');

    // Help text
    const helpText = document.createElement('div');
    helpText.className = 'settings-network-policy__hub-proxy-help';
    helpText.textContent = 'URLs matching these patterns will be routed through the hub. Use * as a wildcard.';

    patternsField.appendChild(patternsLabel);
    patternsField.appendChild(hubProxyPatternsTextarea);
    patternsField.appendChild(helpText);

    // Show/hide patterns based on toggle
    const updatePatternsVisibility = () => {
      if (hubProxyToggle!.checked) {
        patternsField.style.display = 'block';
      } else {
        patternsField.style.display = 'none';
      }
    };

    updatePatternsVisibility();

    hubProxyToggle.addEventListener('change', updatePatternsVisibility);

    hubProxyContainer.appendChild(toggleField);
    hubProxyContainer.appendChild(patternsField);
  }

  // Save handler
  const savePolicy = () => {
    const mode = modeSelect.value as NetworkPolicy['mode'];
    const domains = domainsTextarea.value
      .split('\n')
      .map(d => d.trim())
      .filter(d => d.length > 0);

    const newPolicy: NetworkPolicy = { mode };
    if (mode === 'allowlist') {
      newPolicy.allowedDomains = domains;
    } else if (mode === 'blocklist') {
      newPolicy.blockedDomains = domains;
    }

    // Include hub proxy settings if available
    if (hubProxyToggle) {
      newPolicy.useHubProxy = hubProxyToggle.checked;
    }
    if (hubProxyPatternsTextarea) {
      const patterns = hubProxyPatternsTextarea.value
        .split('\n')
        .map(p => p.trim())
        .filter(p => p.length > 0);
      if (patterns.length > 0) {
        newPolicy.hubProxyPatterns = patterns;
      }
    }

    const changes = { networkPolicy: newPolicy };
    agent.updateConfig(changes);
    callbacks.onConfigChange?.(agent.id, changes);
  };

  modeSelect.addEventListener('change', () => {
    updateDomainsVisibility();
    savePolicy();
  });
  domainsTextarea.addEventListener('blur', savePolicy);

  if (hubProxyToggle) {
    hubProxyToggle.addEventListener('change', savePolicy);
  }
  if (hubProxyPatternsTextarea) {
    hubProxyPatternsTextarea.addEventListener('blur', savePolicy);
  }

  el.appendChild(modeField);
  el.appendChild(domainsField);
  if (hubProxyContainer) {
    el.appendChild(hubProxyContainer);
  }
  return el;
}
