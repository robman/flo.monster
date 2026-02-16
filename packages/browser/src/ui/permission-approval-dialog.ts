/**
 * Dialog for approving permission requests from agents.
 * Shows when an agent requests a permission that isn't pre-enabled in its config.
 */

export interface PermissionApprovalResult {
  approved: boolean;
  persistent: boolean;  // "Allow Always" vs "Allow Once"
}

const PERMISSION_LABELS: Record<string, { label: string; description: string }> = {
  camera: { label: 'Camera', description: 'Access to the device camera for photos and video' },
  microphone: { label: 'Microphone', description: 'Access to the device microphone for audio recording' },
  geolocation: { label: 'Location', description: 'Access to your geographic location' },
};

export class PermissionApprovalDialog {
  private overlay: HTMLElement | null = null;

  show(agentName: string, permission: string): Promise<PermissionApprovalResult> {
    return new Promise((resolve) => {
      this.overlay = document.createElement('div');
      this.overlay.className = 'permission-approval-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'permission-approval-dialog';

      // Title
      const title = document.createElement('h3');
      title.className = 'permission-approval-dialog__title';
      title.textContent = 'Permission Request';
      dialog.appendChild(title);

      // Info
      const info = document.createElement('div');
      info.className = 'permission-approval-dialog__info';

      const permInfo = PERMISSION_LABELS[permission] || { label: permission, description: '' };

      const agentLabel = document.createElement('div');
      agentLabel.className = 'permission-approval-dialog__label';
      agentLabel.textContent = 'Agent:';
      const agentValue = document.createElement('div');
      agentValue.className = 'permission-approval-dialog__value';
      agentValue.textContent = agentName;

      const permLabel = document.createElement('div');
      permLabel.className = 'permission-approval-dialog__label';
      permLabel.textContent = 'Permission:';
      const permValue = document.createElement('div');
      permValue.className = 'permission-approval-dialog__value';
      permValue.textContent = permInfo.label;

      info.appendChild(agentLabel);
      info.appendChild(agentValue);
      info.appendChild(permLabel);
      info.appendChild(permValue);

      if (permInfo.description) {
        const descLabel = document.createElement('div');
        descLabel.className = 'permission-approval-dialog__label';
        descLabel.textContent = 'Details:';
        const descValue = document.createElement('div');
        descValue.className = 'permission-approval-dialog__value';
        descValue.textContent = permInfo.description;
        info.appendChild(descLabel);
        info.appendChild(descValue);
      }

      dialog.appendChild(info);

      // Warning
      const warning = document.createElement('div');
      warning.className = 'permission-approval-dialog__warning';
      warning.textContent = 'This agent is requesting a browser permission that is not pre-enabled in its settings.';
      dialog.appendChild(warning);

      // Buttons
      const buttons = document.createElement('div');
      buttons.className = 'permission-approval-dialog__buttons';

      const denyBtn = document.createElement('button');
      denyBtn.className = 'permission-approval-dialog__btn permission-approval-dialog__btn--deny';
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => {
        this.close();
        resolve({ approved: false, persistent: false });
      });

      const allowOnceBtn = document.createElement('button');
      allowOnceBtn.className = 'permission-approval-dialog__btn permission-approval-dialog__btn--allow-once';
      allowOnceBtn.textContent = 'Allow Once';
      allowOnceBtn.addEventListener('click', () => {
        this.close();
        resolve({ approved: true, persistent: false });
      });

      const allowAlwaysBtn = document.createElement('button');
      allowAlwaysBtn.className = 'permission-approval-dialog__btn permission-approval-dialog__btn--allow-always';
      allowAlwaysBtn.textContent = 'Allow Always';
      allowAlwaysBtn.addEventListener('click', () => {
        this.close();
        resolve({ approved: true, persistent: true });
      });

      buttons.appendChild(denyBtn);
      buttons.appendChild(allowOnceBtn);
      buttons.appendChild(allowAlwaysBtn);
      dialog.appendChild(buttons);

      this.overlay.appendChild(dialog);
      document.body.appendChild(this.overlay);

      denyBtn.focus();
    });
  }

  private close(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }
}
