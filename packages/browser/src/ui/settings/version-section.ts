/**
 * Version & Updates settings section
 */

import { requestForceRefresh } from '../../shell/sw-registration.js';

export function createVersionSection(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-version';

  // Version display row
  const versionRow = document.createElement('div');
  versionRow.className = 'settings-version__row';
  const versionLabel = document.createElement('span');
  versionLabel.className = 'settings-version__label';
  versionLabel.textContent = 'Version:';
  const versionValue = document.createElement('span');
  versionValue.className = 'settings-version__value';
  versionValue.textContent = '...';
  versionRow.append(versionLabel, versionValue);
  el.appendChild(versionRow);

  // Load version from version.txt
  fetch('/version.txt').then(r => r.text()).then(v => {
    versionValue.textContent = v.trim();
  }).catch(() => {
    versionValue.textContent = 'unknown';
  });

  // Button row
  const buttonRow = document.createElement('div');
  buttonRow.className = 'settings-version__buttons';

  // Check for updates button
  const checkBtn = document.createElement('button');
  checkBtn.className = 'btn settings-version__check-btn';
  checkBtn.textContent = 'Check for Updates';
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking...';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
      }
      checkBtn.textContent = 'Up to date';
    } catch {
      checkBtn.textContent = 'Check failed';
    }
    setTimeout(() => {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check for Updates';
    }, 3000);
  });
  buttonRow.appendChild(checkBtn);

  // Force refresh button
  const forceBtn = document.createElement('button');
  forceBtn.className = 'btn settings-version__force-btn';
  forceBtn.textContent = 'Force Refresh';
  forceBtn.addEventListener('click', () => {
    if (confirm('This will reload the app. Your agents and data are safe.')) {
      requestForceRefresh();
    }
  });
  buttonRow.appendChild(forceBtn);

  el.appendChild(buttonRow);

  // Safety note
  const note = document.createElement('p');
  note.className = 'settings-version__note';
  note.textContent = 'Your agents, conversations, and settings are not affected by updates or force refresh.';
  el.appendChild(note);

  return el;
}
