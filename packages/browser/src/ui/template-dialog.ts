/**
 * Dialog for spawning an agent from a template
 */

import { MODEL_INFO, type StoredTemplate } from '@flo-monster/core';

export interface TemplateDialogResult {
  templateName: string;
  agentName: string;
  overrides: {
    model?: string;
    maxTokens?: number;
  };
}

export class TemplateDialog {
  private overlay: HTMLElement | null = null;

  show(template: StoredTemplate): Promise<TemplateDialogResult | null> {
    return new Promise((resolve) => {
      // Create overlay
      this.overlay = document.createElement('div');
      this.overlay.className = 'overlay';

      const card = document.createElement('div');
      card.className = 'overlay__card template-dialog';

      // Header
      const header = document.createElement('h2');
      header.textContent = 'Create from Template';
      card.appendChild(header);

      // Template info
      const info = document.createElement('div');
      info.className = 'template-dialog__info';

      const nameEl = document.createElement('h3');
      nameEl.className = 'template-dialog__template-name';
      nameEl.textContent = template.manifest.name;
      info.appendChild(nameEl);

      const descEl = document.createElement('p');
      descEl.className = 'template-dialog__template-desc';
      descEl.textContent = template.manifest.description;
      info.appendChild(descEl);

      const versionEl = document.createElement('span');
      versionEl.className = 'template-dialog__template-version';
      versionEl.textContent = `v${template.manifest.version}`;
      info.appendChild(versionEl);

      card.appendChild(info);

      // Form
      const form = document.createElement('form');
      form.className = 'template-dialog__form';

      // Agent name field
      const nameField = document.createElement('div');
      nameField.className = 'form-field';

      const nameLabel = document.createElement('label');
      nameLabel.className = 'form-field__label';
      nameLabel.textContent = 'Agent Name';
      nameLabel.setAttribute('for', 'template-agent-name');
      nameField.appendChild(nameLabel);

      const nameInput = document.createElement('input');
      nameInput.className = 'form-field__input';
      nameInput.type = 'text';
      nameInput.id = 'template-agent-name';
      nameInput.name = 'agentName';
      nameInput.value = template.manifest.name;
      nameInput.required = true;
      nameField.appendChild(nameInput);

      form.appendChild(nameField);

      // Model field
      const modelField = document.createElement('div');
      modelField.className = 'form-field';

      const modelLabel = document.createElement('label');
      modelLabel.className = 'form-field__label';
      modelLabel.textContent = 'Model (optional override)';
      modelLabel.setAttribute('for', 'template-model');
      modelField.appendChild(modelLabel);

      const modelSelect = document.createElement('select');
      modelSelect.className = 'form-field__select';
      modelSelect.id = 'template-model';
      modelSelect.name = 'model';

      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = 'Use template default';
      modelSelect.appendChild(defaultOption);

      for (const [id, modelInfo] of Object.entries(MODEL_INFO)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = modelInfo.displayName;
        modelSelect.appendChild(option);
      }
      modelField.appendChild(modelSelect);

      form.appendChild(modelField);

      // Actions
      const actions = document.createElement('div');
      actions.className = 'form-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.id = 'template-dialog-cancel';
      cancelBtn.textContent = 'Cancel';
      actions.appendChild(cancelBtn);

      const createBtn = document.createElement('button');
      createBtn.type = 'submit';
      createBtn.className = 'btn btn--primary';
      createBtn.textContent = 'Create Agent';
      actions.appendChild(createBtn);

      form.appendChild(actions);
      card.appendChild(form);

      this.overlay.appendChild(card);
      document.body.appendChild(this.overlay);

      const cleanup = () => {
        if (this.overlay) {
          this.overlay.remove();
          this.overlay = null;
        }
      };

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();

        const result: TemplateDialogResult = {
          templateName: template.manifest.name,
          agentName: nameInput.value.trim() || template.manifest.name,
          overrides: {},
        };

        const model = modelSelect.value;
        if (model) {
          result.overrides.model = model;
        }

        cleanup();
        resolve(result);
      });

      // Focus name input
      nameInput.focus();
      nameInput.select();
    });
  }

  hide(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}
