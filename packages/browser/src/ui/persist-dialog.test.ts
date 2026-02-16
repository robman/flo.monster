/**
 * Tests for PersistDialog
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersistDialog } from './persist-dialog.js';

describe('PersistDialog', () => {
  let dialog: PersistDialog;

  beforeEach(() => {
    dialog = new PersistDialog();
  });

  afterEach(() => {
    dialog.hide();
    // Clean up any remaining DOM elements
    document.body.innerHTML = '';
  });

  describe('show', () => {
    it('should render dialog elements', () => {
      const onPersist = vi.fn();
      const onCancel = vi.fn();

      dialog.show({
        hubs: [{ id: 'h1', name: 'Hub 1' }],
        onPersist,
        onCancel,
      });

      expect(document.querySelector('.persist-dialog')).not.toBeNull();
      expect(document.querySelector('.dialog-backdrop')).not.toBeNull();
      expect(document.querySelector('.persist-dialog__title')).not.toBeNull();
      expect(document.querySelector('.persist-dialog__select')).not.toBeNull();
      expect(document.querySelector('#persist-include-files')).not.toBeNull();
    });

    it('should populate hub selector with options', () => {
      dialog.show({
        hubs: [
          { id: 'h1', name: 'Hub 1' },
          { id: 'h2', name: 'Hub 2' },
        ],
        onPersist: vi.fn(),
        onCancel: vi.fn(),
      });

      const select = document.querySelector('.persist-dialog__select') as HTMLSelectElement;
      expect(select.options).toHaveLength(2);
      expect(select.options[0].value).toBe('h1');
      expect(select.options[0].textContent).toBe('Hub 1');
      expect(select.options[1].value).toBe('h2');
    });

    it('should disable persist button when no hubs available', () => {
      dialog.show({
        hubs: [],
        onPersist: vi.fn(),
        onCancel: vi.fn(),
      });

      const persistBtn = document.querySelector('.persist-dialog__btn--persist') as HTMLButtonElement;
      expect(persistBtn.disabled).toBe(true);

      const select = document.querySelector('.persist-dialog__select') as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });

    it('should call onCancel when cancel button clicked', () => {
      const onCancel = vi.fn();

      dialog.show({
        hubs: [{ id: 'h1', name: 'Hub 1' }],
        onPersist: vi.fn(),
        onCancel,
      });

      const cancelBtn = document.querySelector('.persist-dialog__btn--cancel') as HTMLButtonElement;
      cancelBtn.click();

      expect(onCancel).toHaveBeenCalled();
    });

    it('should call onPersist with correct arguments when persist button clicked', async () => {
      const onPersist = vi.fn().mockResolvedValue(undefined);

      dialog.show({
        hubs: [{ id: 'h1', name: 'Hub 1' }],
        onPersist,
        onCancel: vi.fn(),
      });

      // Check the include files checkbox
      const checkbox = document.querySelector('#persist-include-files') as HTMLInputElement;
      checkbox.checked = true;

      const persistBtn = document.querySelector('.persist-dialog__btn--persist') as HTMLButtonElement;
      persistBtn.click();

      // Wait for async handler
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(onPersist).toHaveBeenCalledWith('h1', true);
    });

    it('should show success state after successful persist', async () => {
      vi.useFakeTimers();
      const onPersist = vi.fn().mockResolvedValue(undefined);

      dialog.show({
        hubs: [{ id: 'h1', name: 'Hub 1' }],
        onPersist,
        onCancel: vi.fn(),
      });

      const persistBtn = document.querySelector('.persist-dialog__btn--persist') as HTMLButtonElement;
      persistBtn.click();

      // Wait for async handler to complete
      await vi.advanceTimersByTimeAsync(0);

      // Loading element should show success message
      const loading = document.querySelector('.persist-dialog__loading') as HTMLElement;
      expect(loading.textContent).toBe('\u2713 Agent persisted!');
      expect(loading.classList.contains('persist-dialog__loading--success')).toBe(true);
      expect(loading.style.display).toBe('block');

      // Dialog should still be visible
      expect(dialog.isVisible()).toBe(true);

      // After 1.5s delay, dialog should hide
      vi.advanceTimersByTime(1500);
      expect(dialog.isVisible()).toBe(false);

      vi.useRealTimers();
    });
  });

  describe('hide', () => {
    it('should remove dialog from DOM', () => {
      dialog.show({
        hubs: [{ id: 'h1', name: 'Hub 1' }],
        onPersist: vi.fn(),
        onCancel: vi.fn(),
      });

      expect(document.querySelector('.persist-dialog')).not.toBeNull();

      dialog.hide();

      expect(document.querySelector('.persist-dialog')).toBeNull();
      expect(document.querySelector('.dialog-backdrop')).toBeNull();
    });
  });

  describe('isVisible', () => {
    it('should return false when hidden', () => {
      expect(dialog.isVisible()).toBe(false);
    });

    it('should return true when shown', () => {
      dialog.show({
        hubs: [],
        onPersist: vi.fn(),
        onCancel: vi.fn(),
      });

      expect(dialog.isVisible()).toBe(true);
    });
  });
});
