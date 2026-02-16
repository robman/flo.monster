/**
 * Web tool routing settings section
 */

import type { PersistenceLayer, AppSettings, WebToolRouting } from '../../shell/persistence.js';
import { createFormField, populateSelect } from '../dom-helpers.js';

export function createWebToolRoutingSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-web-tool-routing';

  const currentRouting = settings.defaultWebToolRouting || 'auto';

  // Description
  const desc = document.createElement('p');
  desc.className = 'settings-web-tool-routing__desc';
  desc.textContent = 'Choose how web_fetch and web_search tools route requests by default.';
  el.appendChild(desc);

  // Routing selector
  const { field: selectField, input: select } = createFormField({
    label: 'Default Routing',
    type: 'select',
    className: 'settings-web-tool-routing__select',
  });

  populateSelect(
    select,
    [
      { value: 'auto', label: 'Auto - Try hub first, fall back to browser' },
      { value: 'hub', label: 'Hub - Route through connected hub proxy' },
      { value: 'browser', label: 'Browser - Direct fetch (CORS limited)' },
      { value: 'api', label: 'API (Not implemented) - Use Anthropic native tools' },
    ],
    currentRouting,
  );

  // Help text
  const helpText = document.createElement('div');
  helpText.className = 'settings-web-tool-routing__help';
  helpText.textContent = 'Note: Hub routing requires a connected hub. Browser routing is limited by CORS.';

  // Save handler
  select.addEventListener('change', async () => {
    const current = await persistence.getSettings();
    current.defaultWebToolRouting = select.value as WebToolRouting;
    await persistence.saveSettings(current);
  });

  el.appendChild(selectField);
  el.appendChild(helpText);
  return el;
}
