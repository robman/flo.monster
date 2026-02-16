export interface SaveTemplateResult {
  name: string;
  description: string;
  version: string;
  includeConversation: boolean;
  includeStorage: boolean;
}

export class SaveAsTemplateDialog {
  private overlay: HTMLElement | null = null;

  show(defaultName: string): Promise<SaveTemplateResult | null> {
    return new Promise((resolve) => {
      // Create overlay
      this.overlay = document.createElement('div');
      this.overlay.className = 'overlay';

      const card = document.createElement('div');
      card.className = 'overlay__card';

      // Build the header
      const header = document.createElement('h2');
      header.textContent = 'Save as Template';
      card.appendChild(header);

      // Generate default name with timestamp in ms
      const nameWithTimestamp = `${defaultName}-${Date.now()}`;

      // Create form
      const form = document.createElement('form');

      // Name field (required)
      const nameField = document.createElement('div');
      nameField.className = 'form-field';

      const nameLabel = document.createElement('label');
      nameLabel.className = 'form-field__label';
      nameLabel.htmlFor = 'template-name';
      nameLabel.textContent = 'Name';
      nameField.appendChild(nameLabel);

      const nameInput = document.createElement('input');
      nameInput.className = 'form-field__input';
      nameInput.id = 'template-name';
      nameInput.type = 'text';
      nameInput.value = nameWithTimestamp;
      nameInput.required = true;
      nameField.appendChild(nameInput);

      form.appendChild(nameField);

      // Description field (optional)
      const descField = document.createElement('div');
      descField.className = 'form-field';

      const descLabel = document.createElement('label');
      descLabel.className = 'form-field__label';
      descLabel.htmlFor = 'template-description';
      descLabel.textContent = 'Description';
      descField.appendChild(descLabel);

      const descTextarea = document.createElement('textarea');
      descTextarea.className = 'form-field__textarea';
      descTextarea.id = 'template-description';
      descTextarea.rows = 3;
      descField.appendChild(descTextarea);

      form.appendChild(descField);

      // Version field
      const versionField = document.createElement('div');
      versionField.className = 'form-field';

      const versionLabel = document.createElement('label');
      versionLabel.className = 'form-field__label';
      versionLabel.htmlFor = 'template-version';
      versionLabel.textContent = 'Version';
      versionField.appendChild(versionLabel);

      const versionInput = document.createElement('input');
      versionInput.className = 'form-field__input';
      versionInput.id = 'template-version';
      versionInput.type = 'text';
      versionInput.value = '1.0.0';
      versionField.appendChild(versionInput);

      form.appendChild(versionField);

      // Include conversation checkbox
      const checkboxField = document.createElement('div');
      checkboxField.className = 'form-field';

      const checkboxLabel = document.createElement('label');
      checkboxLabel.className = 'form-field__label';
      checkboxLabel.style.display = 'flex';
      checkboxLabel.style.alignItems = 'center';
      checkboxLabel.style.gap = '0.5rem';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = 'template-include-conversation';
      checkbox.checked = false;
      checkboxLabel.appendChild(checkbox);

      const checkboxText = document.createElement('span');
      checkboxText.textContent = 'Include conversation history';
      checkboxLabel.appendChild(checkboxText);

      checkboxField.appendChild(checkboxLabel);
      form.appendChild(checkboxField);

      // Include storage checkbox
      const storageField = document.createElement('div');
      storageField.className = 'form-field';

      const storageLabel = document.createElement('label');
      storageLabel.className = 'form-field__label';
      storageLabel.style.display = 'flex';
      storageLabel.style.alignItems = 'center';
      storageLabel.style.gap = '0.5rem';

      const storageCheckbox = document.createElement('input');
      storageCheckbox.type = 'checkbox';
      storageCheckbox.id = 'template-include-storage';
      storageCheckbox.checked = false;
      storageLabel.appendChild(storageCheckbox);

      const storageText = document.createElement('span');
      storageText.textContent = 'Include saved data (storage)';
      storageLabel.appendChild(storageText);

      // Add a small warning about sensitive data
      const storageHint = document.createElement('small');
      storageHint.style.color = 'var(--text-muted, #888)';
      storageHint.style.marginLeft = '0.5rem';
      storageHint.textContent = '(may contain sensitive data)';
      storageLabel.appendChild(storageHint);

      storageField.appendChild(storageLabel);
      form.appendChild(storageField);

      // Form actions
      const actions = document.createElement('div');
      actions.className = 'form-actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel';
      actions.appendChild(cancelBtn);

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'btn btn--primary';
      saveBtn.textContent = 'Save';
      actions.appendChild(saveBtn);

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

        const result: SaveTemplateResult = {
          name: nameInput.value.trim(),
          description: descTextarea.value.trim(),
          version: versionInput.value.trim() || '1.0.0',
          includeConversation: checkbox.checked,
          includeStorage: storageCheckbox.checked,
        };

        cleanup();
        resolve(result);
      });

      // Focus the name input
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
