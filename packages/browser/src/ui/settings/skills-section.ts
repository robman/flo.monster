/**
 * Skills settings section - allows users to install, view, and remove skills
 */

import type { StoredSkill } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { SkillManager } from '../../shell/skill-manager.js';
import { createEmptyState, createFormField, createLoadingIndicator } from '../dom-helpers.js';

export function createSkillsSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  skillManager: SkillManager,
  onRerender: () => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-skills';

  const skills = skillManager.listSkills();

  if (skills.length === 0) {
    el.appendChild(createEmptyState('No skills installed', 'settings-skills__empty'));
  } else {
    const list = document.createElement('div');
    list.className = 'settings-skills__list';

    for (const skill of skills) {
      const item = createSkillItem(skill, skillManager, persistence, onRerender);
      list.appendChild(item);
    }

    el.appendChild(list);
  }

  // Install from URL button
  const installBtn = document.createElement('button');
  installBtn.className = 'btn settings-skills__add';
  installBtn.textContent = 'Install from URL';
  installBtn.addEventListener('click', () => {
    showInstallDialog(skillManager, persistence, el, onRerender);
  });
  el.appendChild(installBtn);

  return el;
}

function createSkillItem(
  skill: StoredSkill,
  skillManager: SkillManager,
  persistence: PersistenceLayer,
  onRerender: () => void,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'settings-skills__item';

  const info = document.createElement('div');
  info.className = 'settings-skills__info';

  // Name and description
  const nameEl = document.createElement('div');
  nameEl.className = 'settings-skills__name';
  nameEl.textContent = `/${skill.name}`;
  if (skill.manifest.argumentHint) {
    nameEl.textContent += ` ${skill.manifest.argumentHint}`;
  }
  info.appendChild(nameEl);

  const descEl = document.createElement('div');
  descEl.className = 'settings-skills__desc';
  descEl.textContent = skill.manifest.description;
  info.appendChild(descEl);

  // Source info
  const sourceEl = document.createElement('div');
  sourceEl.className = 'settings-skills__source';
  if (skill.source.type === 'builtin') {
    sourceEl.textContent = 'Built-in';
  } else if (skill.source.type === 'url') {
    sourceEl.textContent = `From: ${skill.source.url}`;
  } else {
    sourceEl.textContent = 'Local';
  }
  info.appendChild(sourceEl);

  // Optional: Show allowed tools
  if (skill.manifest.allowedTools && skill.manifest.allowedTools.length > 0) {
    const toolsEl = document.createElement('div');
    toolsEl.className = 'settings-skills__tools';
    toolsEl.textContent = `Allowed tools: ${skill.manifest.allowedTools.join(', ')}`;
    info.appendChild(toolsEl);
  }

  const actions = document.createElement('div');
  actions.className = 'settings-skills__actions';

  // View button
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn';
  viewBtn.textContent = 'View';
  viewBtn.addEventListener('click', () => {
    showViewDialog(skill);
  });
  actions.appendChild(viewBtn);

  // Remove button (not for builtins)
  if (skill.source.type !== 'builtin') {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      if (!window.confirm(`Remove skill "${skill.name}"?`)) {
        return;
      }

      skillManager.removeSkill(skill.name);

      // Save to persistence
      const current = await persistence.getSettings();
      current.installedSkills = skillManager.exportEntries();
      await persistence.saveSettings(current);

      onRerender();
    });
    actions.appendChild(removeBtn);
  }

  item.appendChild(info);
  item.appendChild(actions);

  return item;
}

function showInstallDialog(
  skillManager: SkillManager,
  persistence: PersistenceLayer,
  container: HTMLElement,
  onRerender: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'settings-skills__dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'settings-skills__dialog';

  // Title
  const title = document.createElement('h3');
  title.textContent = 'Install Skill from URL';
  dialog.appendChild(title);

  // URL input
  const { field: urlField, input: urlInput } = createFormField({
    label: 'SKILL.md URL',
    type: 'input',
    inputType: 'url',
    placeholder: 'https://example.com/my-skill/SKILL.md',
  });

  const urlHelp = document.createElement('div');
  urlHelp.className = 'settings-skills__help';
  urlHelp.textContent = 'Enter the URL to a SKILL.md file';
  urlField.appendChild(urlHelp);

  dialog.appendChild(urlField);

  // Error display
  const errorEl = document.createElement('div');
  errorEl.className = 'settings-skills__dialog-error';
  errorEl.style.display = 'none';
  dialog.appendChild(errorEl);

  // Loading indicator
  const loadingEl = createLoadingIndicator('Installing...', 'settings-skills__dialog-loading');
  loadingEl.style.display = 'none';
  dialog.appendChild(loadingEl);

  // Actions
  const actionsEl = document.createElement('div');
  actionsEl.className = 'settings-skills__dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';

  const installBtn = document.createElement('button');
  installBtn.className = 'btn btn--primary';
  installBtn.textContent = 'Install';

  actionsEl.appendChild(cancelBtn);
  actionsEl.appendChild(installBtn);
  dialog.appendChild(actionsEl);

  overlay.appendChild(dialog);
  container.appendChild(overlay);

  const closeDialog = () => {
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  cancelBtn.addEventListener('click', closeDialog);

  installBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) {
      errorEl.textContent = 'Please enter a URL';
      errorEl.style.display = 'block';
      return;
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      errorEl.textContent = 'Invalid URL format';
      errorEl.style.display = 'block';
      return;
    }

    errorEl.style.display = 'none';
    loadingEl.style.display = 'block';
    installBtn.disabled = true;
    cancelBtn.disabled = true;

    try {
      await skillManager.installFromUrl(url);

      // Save to persistence
      const current = await persistence.getSettings();
      current.installedSkills = skillManager.exportEntries();
      await persistence.saveSettings(current);

      closeDialog();
      onRerender();
    } catch (err) {
      loadingEl.style.display = 'none';
      installBtn.disabled = false;
      cancelBtn.disabled = false;
      errorEl.textContent = err instanceof Error ? err.message : 'Failed to install skill';
      errorEl.style.display = 'block';
    }
  });
}

function showViewDialog(skill: StoredSkill): void {
  const overlay = document.createElement('div');
  overlay.className = 'settings-skills__dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'settings-skills__dialog settings-skills__dialog--wide';

  // Title
  const title = document.createElement('h3');
  title.textContent = `Skill: ${skill.name}`;
  dialog.appendChild(title);

  // Manifest section
  const manifestSection = document.createElement('div');
  manifestSection.className = 'settings-skills__view-section';

  const manifestTitle = document.createElement('h4');
  manifestTitle.textContent = 'Manifest';
  manifestSection.appendChild(manifestTitle);

  const manifestPre = document.createElement('pre');
  manifestPre.className = 'settings-skills__view-content';
  manifestPre.textContent = JSON.stringify(skill.manifest, null, 2);
  manifestSection.appendChild(manifestPre);

  dialog.appendChild(manifestSection);

  // Instructions section
  const instructionsSection = document.createElement('div');
  instructionsSection.className = 'settings-skills__view-section';

  const instructionsTitle = document.createElement('h4');
  instructionsTitle.textContent = 'Instructions';
  instructionsSection.appendChild(instructionsTitle);

  const instructionsPre = document.createElement('pre');
  instructionsPre.className = 'settings-skills__view-content';
  instructionsPre.textContent = skill.instructions;
  instructionsSection.appendChild(instructionsPre);

  dialog.appendChild(instructionsSection);

  // Close button
  const actionsEl = document.createElement('div');
  actionsEl.className = 'settings-skills__dialog-actions';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn--primary';
  closeBtn.textContent = 'Close';

  actionsEl.appendChild(closeBtn);
  dialog.appendChild(actionsEl);

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const closeDialog = () => {
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  closeBtn.addEventListener('click', closeDialog);
}
