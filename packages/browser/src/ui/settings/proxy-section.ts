/**
 * Proxy settings section
 */

import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import { createFormField } from '../dom-helpers.js';

export function createProxySection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  onProxySettingsChange?: (settings: { corsProxyUrl?: string; useBuiltinProxy?: boolean }) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-proxy';

  // Use built-in proxy toggle
  const toggleField = document.createElement('div');
  toggleField.className = 'settings-proxy__toggle-field';

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'settings-proxy__toggle-label';
  toggleLabel.textContent = 'Use built-in proxy';

  const toggle = document.createElement('label');
  toggle.className = 'settings-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'settings-proxy__builtin-checkbox';
  checkbox.checked = settings.useBuiltinProxy !== false; // Default true
  const slider = document.createElement('span');
  slider.className = 'settings-toggle__slider';
  toggle.appendChild(checkbox);
  toggle.appendChild(slider);

  toggleField.appendChild(toggleLabel);
  toggleField.appendChild(toggle);

  // Custom proxy URL input
  const { field: urlField, input: urlInput } = createFormField({
    label: 'Custom Proxy URL',
    type: 'input',
    inputType: 'url',
    className: 'settings-proxy__url',
    wrapperClassName: 'settings-proxy__url-field',
    placeholder: 'https://proxy.flo.monster',
    value: settings.corsProxyUrl || '',
  });

  // Error display
  const errorEl = document.createElement('div');
  errorEl.className = 'settings-proxy__error';
  errorEl.style.display = 'none';
  urlField.appendChild(errorEl);

  // Update visibility based on toggle state
  const updateUrlFieldVisibility = () => {
    if (checkbox.checked) {
      urlField.style.display = 'none';
    } else {
      urlField.style.display = 'block';
    }
  };

  updateUrlFieldVisibility();

  // Validate URL format
  const isValidProxyUrl = (url: string): boolean => {
    if (!url) return true; // Empty is valid (will use default)
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  };

  // Save handler
  const saveProxySettings = async () => {
    const useBuiltinProxy = checkbox.checked;
    const corsProxyUrl = urlInput.value.trim();

    // Validate URL if custom proxy is being used
    if (!useBuiltinProxy && corsProxyUrl && !isValidProxyUrl(corsProxyUrl)) {
      errorEl.textContent = 'Invalid URL format. Must be http:// or https://';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';

    const current = await persistence.getSettings();
    current.useBuiltinProxy = useBuiltinProxy;
    current.corsProxyUrl = corsProxyUrl || undefined;
    await persistence.saveSettings(current);

    // Notify listener
    onProxySettingsChange?.({
      corsProxyUrl: corsProxyUrl || undefined,
      useBuiltinProxy,
    });
  };

  checkbox.addEventListener('change', () => {
    updateUrlFieldVisibility();
    saveProxySettings();
  });

  urlInput.addEventListener('blur', saveProxySettings);
  urlInput.addEventListener('change', saveProxySettings);

  el.appendChild(toggleField);
  el.appendChild(urlField);

  // === Advanced: API Base URL ===
  const advancedToggle = document.createElement('button');
  advancedToggle.type = 'button';
  advancedToggle.className = 'settings-proxy__advanced-toggle';
  advancedToggle.textContent = 'Advanced';

  const advancedSection = document.createElement('div');
  advancedSection.className = 'settings-proxy__advanced';
  advancedSection.style.display = 'none';

  advancedToggle.addEventListener('click', () => {
    const isShown = advancedSection.style.display !== 'none';
    advancedSection.style.display = isShown ? 'none' : 'block';
    advancedToggle.textContent = isShown ? 'Advanced' : 'Advanced (hide)';
  });

  const { field: apiBaseField, input: apiBaseInput } = createFormField({
    label: 'API Base URL',
    type: 'input',
    inputType: 'url',
    className: 'settings-proxy__api-base-url',
    wrapperClassName: 'settings-proxy__api-base-field',
    placeholder: 'https://api.flo.monster',
    value: settings.apiBaseUrl || '',
    hint: 'Routes API requests to an external domain instead of same-origin. Leave empty for default behavior.',
  });

  const apiBaseErrorEl = document.createElement('div');
  apiBaseErrorEl.className = 'settings-proxy__error';
  apiBaseErrorEl.style.display = 'none';
  apiBaseField.appendChild(apiBaseErrorEl);

  const saveApiBaseUrl = async () => {
    const apiBaseUrl = apiBaseInput.value.trim();

    // Validate URL if not empty
    if (apiBaseUrl && !isValidProxyUrl(apiBaseUrl)) {
      apiBaseErrorEl.textContent = 'Invalid URL format. Must be http:// or https://';
      apiBaseErrorEl.style.display = 'block';
      return;
    }

    // Strip trailing slash for consistency
    const normalizedUrl = apiBaseUrl.replace(/\/+$/, '');

    apiBaseErrorEl.style.display = 'none';

    const current = await persistence.getSettings();
    current.apiBaseUrl = normalizedUrl || undefined;
    await persistence.saveSettings(current);

    // Send to service worker
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'configure_api_base',
        apiBaseUrl: normalizedUrl,
      });
    }
  };

  apiBaseInput.addEventListener('blur', saveApiBaseUrl);
  apiBaseInput.addEventListener('change', saveApiBaseUrl);

  advancedSection.appendChild(apiBaseField);
  el.appendChild(advancedToggle);
  el.appendChild(advancedSection);

  return el;
}
