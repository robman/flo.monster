/**
 * Dialog utilities for skill operations (approval and confirmation)
 */

export interface SkillApprovalInfo {
  name: string;
  description: string;
  content: string;
}

/**
 * Show a dialog asking for approval to install a skill.
 * Returns true if the user approved, false if rejected.
 */
export function showSkillApprovalDialog(skill: SkillApprovalInfo): Promise<boolean> {
  return new Promise((resolve) => {
    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'skill-approval-dialog';

    // Title
    const title = document.createElement('h2');
    title.className = 'skill-approval-dialog__title';
    title.textContent = 'Install Skill?';
    dialog.appendChild(title);

    // Skill info
    const info = document.createElement('div');
    info.className = 'skill-approval-dialog__info';

    const nameEl = document.createElement('div');
    nameEl.className = 'skill-approval-dialog__field';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'skill-approval-dialog__label';
    nameLabel.textContent = 'Name: ';
    const nameValue = document.createElement('span');
    nameValue.className = 'skill-approval-dialog__value';
    nameValue.textContent = skill.name;
    nameEl.appendChild(nameLabel);
    nameEl.appendChild(nameValue);
    info.appendChild(nameEl);

    const descEl = document.createElement('div');
    descEl.className = 'skill-approval-dialog__field';
    const descLabel = document.createElement('span');
    descLabel.className = 'skill-approval-dialog__label';
    descLabel.textContent = 'Description: ';
    const descValue = document.createElement('span');
    descValue.className = 'skill-approval-dialog__value';
    descValue.textContent = skill.description;
    descEl.appendChild(descLabel);
    descEl.appendChild(descValue);
    info.appendChild(descEl);

    dialog.appendChild(info);

    // Content preview (collapsible)
    const previewSection = document.createElement('details');
    previewSection.className = 'skill-approval-dialog__preview';
    const summary = document.createElement('summary');
    summary.textContent = 'View skill content';
    previewSection.appendChild(summary);

    const contentPre = document.createElement('pre');
    contentPre.className = 'skill-approval-dialog__content';
    contentPre.textContent = skill.content;
    previewSection.appendChild(contentPre);

    dialog.appendChild(previewSection);

    // Warning
    const warning = document.createElement('p');
    warning.className = 'skill-approval-dialog__warning';
    warning.textContent = 'This skill will be installed and available for use. Review the content before approving.';
    dialog.appendChild(warning);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'skill-approval-dialog__buttons';

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'skill-approval-dialog__btn skill-approval-dialog__btn--reject';
    rejectBtn.textContent = 'Reject';

    const approveBtn = document.createElement('button');
    approveBtn.className = 'skill-approval-dialog__btn skill-approval-dialog__btn--approve';
    approveBtn.textContent = 'Approve';

    buttons.appendChild(rejectBtn);
    buttons.appendChild(approveBtn);
    dialog.appendChild(buttons);

    // Event handlers
    const cleanup = () => {
      backdrop.remove();
      dialog.remove();
    };

    rejectBtn.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    approveBtn.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });

    backdrop.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    // Add to DOM
    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    // Focus the approve button for keyboard accessibility
    approveBtn.focus();
  });
}

/**
 * Show a simple confirmation dialog.
 * Returns true if the user confirmed, false if cancelled.
 */
export function showConfirmDialog(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Create backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'dialog-backdrop';

    // Create dialog
    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    // Message
    const messageEl = document.createElement('p');
    messageEl.className = 'confirm-dialog__message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    // Buttons
    const buttons = document.createElement('div');
    buttons.className = 'confirm-dialog__buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'confirm-dialog__btn confirm-dialog__btn--cancel';
    cancelBtn.textContent = 'Cancel';

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'confirm-dialog__btn confirm-dialog__btn--confirm';
    confirmBtn.textContent = 'Confirm';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);

    // Event handlers
    const cleanup = () => {
      backdrop.remove();
      dialog.remove();
    };

    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    confirmBtn.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });

    backdrop.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    // Add to DOM
    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);

    // Focus the confirm button for keyboard accessibility
    confirmBtn.focus();
  });
}
