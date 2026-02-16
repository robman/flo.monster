/**
 * Network policy settings section
 */

import type { NetworkPolicy } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import { createFormField, populateSelect } from '../dom-helpers.js';

export function createNetworkPolicySection(
  settings: AppSettings,
  persistence: PersistenceLayer,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-network-policy';

  const policy = settings.defaultNetworkPolicy || { mode: 'allow-all' as const };

  // Mode selector
  const { field: modeField, input: modeSelect } = createFormField({
    label: 'Mode',
    type: 'select',
    className: 'settings-network-policy__mode',
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
  const domainsValue = (() => {
    if (policy.mode === 'allowlist' && policy.allowedDomains) {
      return policy.allowedDomains.join('\n');
    } else if (policy.mode === 'blocklist' && policy.blockedDomains) {
      return policy.blockedDomains.join('\n');
    }
    return '';
  })();

  const { field: domainsField, label: domainsLabel, input: domainsTextarea } = createFormField({
    label: policy.mode === 'allowlist' ? 'Allowed Domains (one per line)' : 'Blocked Domains (one per line)',
    type: 'textarea',
    className: 'settings-network-policy__domains',
    rows: 4,
    placeholder: 'example.com\napi.example.org',
    value: domainsValue,
  });

  domainsLabel.classList.add('settings-network-policy__domains-label');

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

  // Save handler
  const savePolicy = async () => {
    const current = await persistence.getSettings();
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

    current.defaultNetworkPolicy = newPolicy;
    await persistence.saveSettings(current);
  };

  modeSelect.addEventListener('change', () => {
    updateDomainsVisibility();
    savePolicy();
  });
  domainsTextarea.addEventListener('blur', savePolicy);

  el.appendChild(modeField);
  el.appendChild(domainsField);
  return el;
}
