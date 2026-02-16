import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PermissionApprovalDialog } from './permission-approval-dialog.js';

describe('PermissionApprovalDialog', () => {
  let dialog: PermissionApprovalDialog;

  beforeEach(() => {
    dialog = new PermissionApprovalDialog();
  });

  afterEach(() => {
    document.querySelectorAll('.permission-approval-overlay').forEach(el => el.remove());
  });

  it('should render the dialog with correct info', () => {
    dialog.show('Test Agent', 'camera');

    const overlay = document.querySelector('.permission-approval-overlay');
    expect(overlay).not.toBeNull();

    const title = overlay?.querySelector('.permission-approval-dialog__title');
    expect(title?.textContent).toBe('Permission Request');

    const values = overlay?.querySelectorAll('.permission-approval-dialog__value');
    expect(values?.[0]?.textContent).toBe('Test Agent');
    expect(values?.[1]?.textContent).toBe('Camera');
  });

  it('should show permission description', () => {
    dialog.show('Test Agent', 'microphone');

    const values = document.querySelectorAll('.permission-approval-dialog__value');
    expect(values?.[1]?.textContent).toBe('Microphone');
    expect(values?.[2]?.textContent).toContain('audio recording');
  });

  it('should resolve with deny when deny clicked', async () => {
    const promise = dialog.show('Agent', 'camera');

    const denyBtn = document.querySelector('.permission-approval-dialog__btn--deny') as HTMLButtonElement;
    expect(denyBtn).not.toBeNull();
    denyBtn.click();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.persistent).toBe(false);
  });

  it('should resolve with allow once when allow once clicked', async () => {
    const promise = dialog.show('Agent', 'camera');

    const allowOnceBtn = document.querySelector('.permission-approval-dialog__btn--allow-once') as HTMLButtonElement;
    expect(allowOnceBtn).not.toBeNull();
    allowOnceBtn.click();

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.persistent).toBe(false);
  });

  it('should resolve with allow always when allow always clicked', async () => {
    const promise = dialog.show('Agent', 'geolocation');

    const allowAlwaysBtn = document.querySelector('.permission-approval-dialog__btn--allow-always') as HTMLButtonElement;
    expect(allowAlwaysBtn).not.toBeNull();
    allowAlwaysBtn.click();

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.persistent).toBe(true);
  });

  it('should remove overlay after closing', async () => {
    const promise = dialog.show('Agent', 'camera');

    const denyBtn = document.querySelector('.permission-approval-dialog__btn--deny') as HTMLButtonElement;
    denyBtn.click();

    await promise;

    expect(document.querySelector('.permission-approval-overlay')).toBeNull();
  });

  it('should display warning message about permission settings', () => {
    dialog.show('Agent', 'camera');

    const warning = document.querySelector('.permission-approval-dialog__warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('not pre-enabled');
  });

  it('should have three buttons: Deny, Allow Once, Allow Always', () => {
    dialog.show('Agent', 'camera');

    const buttons = document.querySelectorAll('.permission-approval-dialog__btn');
    expect(buttons.length).toBe(3);
    expect(buttons[0].textContent).toBe('Deny');
    expect(buttons[1].textContent).toBe('Allow Once');
    expect(buttons[2].textContent).toBe('Allow Always');
  });

  it('should handle unknown permission type gracefully', () => {
    dialog.show('Agent', 'unknown_perm');

    const values = document.querySelectorAll('.permission-approval-dialog__value');
    expect(values?.[1]?.textContent).toBe('unknown_perm');
  });
});
