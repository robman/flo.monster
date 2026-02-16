import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NetworkApprovalDialog } from './network-approval-dialog.js';

describe('NetworkApprovalDialog', () => {
  let dialog: NetworkApprovalDialog;

  beforeEach(() => {
    dialog = new NetworkApprovalDialog();
  });

  afterEach(() => {
    // Clean up any dialogs
    document.querySelectorAll('.network-approval-overlay').forEach(el => el.remove());
  });

  it('should render the dialog with correct info', () => {
    // Don't await - we'll check the DOM before resolving
    dialog.show('Test Agent', 'fetch', 'https://example.com');

    const overlay = document.querySelector('.network-approval-overlay');
    expect(overlay).not.toBeNull();

    const title = overlay?.querySelector('.network-approval-dialog__title');
    expect(title?.textContent).toBe('Network Access Request');

    const values = overlay?.querySelectorAll('.network-approval-dialog__value');
    expect(values?.[0]?.textContent).toBe('Test Agent');
    expect(values?.[1]?.textContent).toBe('fetch');
    expect(values?.[2]?.textContent).toBe('https://example.com');
  });

  it('should resolve with deny when deny clicked', async () => {
    const promise = dialog.show('Agent', 'fetch', 'https://example.com');

    const denyBtn = document.querySelector('.network-approval-dialog__btn--deny') as HTMLButtonElement;
    expect(denyBtn).not.toBeNull();
    denyBtn.click();

    const result = await promise;
    expect(result.approved).toBe(false);
    expect(result.persistent).toBe(false);
  });

  it('should resolve with allow once when allow once clicked', async () => {
    const promise = dialog.show('Agent', 'fetch', 'https://example.com');

    const allowOnceBtn = document.querySelector('.network-approval-dialog__btn--allow-once') as HTMLButtonElement;
    expect(allowOnceBtn).not.toBeNull();
    allowOnceBtn.click();

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.persistent).toBe(false);
  });

  it('should resolve with allow always when allow always clicked', async () => {
    const promise = dialog.show('Agent', 'fetch', 'https://example.com');

    const allowAlwaysBtn = document.querySelector('.network-approval-dialog__btn--allow-always') as HTMLButtonElement;
    expect(allowAlwaysBtn).not.toBeNull();
    allowAlwaysBtn.click();

    const result = await promise;
    expect(result.approved).toBe(true);
    expect(result.persistent).toBe(true);
  });

  it('should remove overlay after closing', async () => {
    const promise = dialog.show('Agent', 'fetch', 'https://example.com');

    const denyBtn = document.querySelector('.network-approval-dialog__btn--deny') as HTMLButtonElement;
    denyBtn.click();

    await promise;

    expect(document.querySelector('.network-approval-overlay')).toBeNull();
  });

  it('should display warning message about srcdoc origin', () => {
    dialog.show('Agent', 'fetch', 'https://example.com');

    const warning = document.querySelector('.network-approval-dialog__warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('page JavaScript');
    expect(warning?.textContent).toContain('not the AI agent itself');
  });

  it('should have three buttons: Deny, Allow Once, Allow Always', () => {
    dialog.show('Agent', 'web_search', 'test query');

    const buttons = document.querySelectorAll('.network-approval-dialog__btn');
    expect(buttons.length).toBe(3);
    expect(buttons[0].textContent).toBe('Deny');
    expect(buttons[1].textContent).toBe('Allow Once');
    expect(buttons[2].textContent).toBe('Allow Always');
  });
});
