/**
 * Dialog for approving network access from srcdoc JavaScript.
 * Shows when an agent's srcdoc JS tries to use a prompted-tier tool (fetch, web_fetch, web_search).
 */

export interface NetworkApprovalResult {
  approved: boolean;
  persistent: boolean;  // "Allow Always" vs "Allow Once"
}

export class NetworkApprovalDialog {
  private overlay: HTMLElement | null = null;

  /**
   * Show the approval dialog and wait for user decision.
   */
  show(agentName: string, toolName: string, detail: string): Promise<NetworkApprovalResult> {
    return new Promise((resolve) => {
      // Create overlay
      this.overlay = document.createElement('div');
      this.overlay.className = 'network-approval-overlay';

      const dialog = document.createElement('div');
      dialog.className = 'network-approval-dialog';

      // Title
      const title = document.createElement('h3');
      title.className = 'network-approval-dialog__title';
      title.textContent = 'Network Access Request';
      dialog.appendChild(title);

      // Info
      const info = document.createElement('div');
      info.className = 'network-approval-dialog__info';

      const agentLabel = document.createElement('div');
      agentLabel.className = 'network-approval-dialog__label';
      agentLabel.textContent = 'Agent:';
      const agentValue = document.createElement('div');
      agentValue.className = 'network-approval-dialog__value';
      agentValue.textContent = agentName;

      const toolLabel = document.createElement('div');
      toolLabel.className = 'network-approval-dialog__label';
      toolLabel.textContent = 'Tool:';
      const toolValue = document.createElement('div');
      toolValue.className = 'network-approval-dialog__value';
      toolValue.textContent = toolName;

      const detailLabel = document.createElement('div');
      detailLabel.className = 'network-approval-dialog__label';
      detailLabel.textContent = 'Target:';
      const detailValue = document.createElement('div');
      detailValue.className = 'network-approval-dialog__value';
      detailValue.textContent = detail;

      info.appendChild(agentLabel);
      info.appendChild(agentValue);
      info.appendChild(toolLabel);
      info.appendChild(toolValue);
      info.appendChild(detailLabel);
      info.appendChild(detailValue);
      dialog.appendChild(info);

      // Warning
      const warning = document.createElement('div');
      warning.className = 'network-approval-dialog__warning';
      warning.textContent = 'This action was initiated by the agent\'s page JavaScript, not the AI agent itself.';
      dialog.appendChild(warning);

      // Buttons
      const buttons = document.createElement('div');
      buttons.className = 'network-approval-dialog__buttons';

      const denyBtn = document.createElement('button');
      denyBtn.className = 'network-approval-dialog__btn network-approval-dialog__btn--deny';
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => {
        this.close();
        resolve({ approved: false, persistent: false });
      });

      const allowOnceBtn = document.createElement('button');
      allowOnceBtn.className = 'network-approval-dialog__btn network-approval-dialog__btn--allow-once';
      allowOnceBtn.textContent = 'Allow Once';
      allowOnceBtn.addEventListener('click', () => {
        this.close();
        resolve({ approved: true, persistent: false });
      });

      const allowAlwaysBtn = document.createElement('button');
      allowAlwaysBtn.className = 'network-approval-dialog__btn network-approval-dialog__btn--allow-always';
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

      // Focus the deny button by default for safety
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
