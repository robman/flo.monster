/**
 * Dialog for persisting agents to hub servers
 */

export interface HubInfo {
  id: string;
  name: string;
}

export interface PersistDialogOptions {
  hubs: HubInfo[];
  onPersist: (hubId: string, includeFiles: boolean) => Promise<void>;
  onCancel: () => void;
}

export class PersistDialog {
  private element: HTMLElement | null = null;
  private backdrop: HTMLElement | null = null;
  private isLoading = false;

  /**
   * Show the persist dialog
   */
  show(options: PersistDialogOptions): void {
    if (this.element) {
      this.hide();
    }

    // Create backdrop
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'dialog-backdrop';
    this.backdrop.addEventListener('click', () => {
      if (!this.isLoading) {
        options.onCancel();
        this.hide();
      }
    });

    // Create dialog
    this.element = document.createElement('div');
    this.element.className = 'persist-dialog';

    // Title
    const title = document.createElement('h2');
    title.className = 'persist-dialog__title';
    title.textContent = 'Persist Agent to Hub';
    this.element.appendChild(title);

    // Hub selector
    const selectGroup = document.createElement('div');
    selectGroup.className = 'persist-dialog__group';

    const selectLabel = document.createElement('label');
    selectLabel.className = 'persist-dialog__label';
    selectLabel.textContent = 'Select Hub:';
    selectLabel.setAttribute('for', 'persist-hub-select');

    const select = document.createElement('select');
    select.id = 'persist-hub-select';
    select.className = 'persist-dialog__select';

    if (options.hubs.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No hubs connected';
      option.disabled = true;
      option.selected = true;
      select.appendChild(option);
      select.disabled = true;
    } else {
      for (const hub of options.hubs) {
        const option = document.createElement('option');
        option.value = hub.id;
        option.textContent = hub.name;
        select.appendChild(option);
      }
    }

    selectGroup.appendChild(selectLabel);
    selectGroup.appendChild(select);
    this.element.appendChild(selectGroup);

    // Include files checkbox
    const checkboxGroup = document.createElement('div');
    checkboxGroup.className = 'persist-dialog__group persist-dialog__checkbox-group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'persist-include-files';
    checkbox.className = 'persist-dialog__checkbox';
    checkbox.checked = true;

    const checkboxLabel = document.createElement('label');
    checkboxLabel.setAttribute('for', 'persist-include-files');
    checkboxLabel.textContent = 'Include files';

    checkboxGroup.appendChild(checkbox);
    checkboxGroup.appendChild(checkboxLabel);
    this.element.appendChild(checkboxGroup);

    // Loading indicator (hidden by default)
    const loading = document.createElement('div');
    loading.className = 'persist-dialog__loading';
    loading.style.display = 'none';
    loading.textContent = 'Persisting agent...';
    this.element.appendChild(loading);

    // Error message (hidden by default)
    const error = document.createElement('div');
    error.className = 'persist-dialog__error';
    error.style.display = 'none';
    this.element.appendChild(error);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'persist-dialog__buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'persist-dialog__btn persist-dialog__btn--cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      if (!this.isLoading) {
        options.onCancel();
        this.hide();
      }
    });

    const persistBtn = document.createElement('button');
    persistBtn.className = 'persist-dialog__btn persist-dialog__btn--persist';
    persistBtn.textContent = 'Persist';
    persistBtn.disabled = options.hubs.length === 0;

    persistBtn.addEventListener('click', async () => {
      const hubId = select.value;
      if (!hubId) return;

      const includeFiles = checkbox.checked;

      // Show loading state
      this.isLoading = true;
      loading.style.display = 'block';
      error.style.display = 'none';
      persistBtn.disabled = true;
      cancelBtn.disabled = true;
      select.disabled = true;
      checkbox.disabled = true;

      try {
        await options.onPersist(hubId, includeFiles);
        // Show success state
        loading.textContent = '\u2713 Agent persisted!';
        loading.classList.add('persist-dialog__loading--success');
        // Auto-hide after brief delay
        setTimeout(() => this.hide(), 1500);
      } catch (err) {
        // Show error
        error.textContent = String(err);
        error.style.display = 'block';
        loading.style.display = 'none';
        persistBtn.disabled = false;
        cancelBtn.disabled = false;
        select.disabled = false;
        checkbox.disabled = false;
        this.isLoading = false;
      }
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(persistBtn);
    this.element.appendChild(buttons);

    // Add to DOM
    document.body.appendChild(this.backdrop);
    document.body.appendChild(this.element);
  }

  /**
   * Hide the dialog
   */
  hide(): void {
    if (this.backdrop) {
      this.backdrop.remove();
      this.backdrop = null;
    }
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
    this.isLoading = false;
  }

  /**
   * Check if the dialog is currently visible
   */
  isVisible(): boolean {
    return this.element !== null;
  }
}
