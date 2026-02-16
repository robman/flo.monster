/**
 * Tests for version section in settings panel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock sw-registration before importing version-section
vi.mock('../../../shell/sw-registration.js', () => ({
  requestForceRefresh: vi.fn(),
}));

import { createVersionSection } from '../version-section.js';
import { requestForceRefresh } from '../../../shell/sw-registration.js';

describe('createVersionSection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders the section container', () => {
    // Mock fetch for version.txt
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    expect(el.className).toBe('settings-version');
  });

  it('shows version row with label and placeholder', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    const label = el.querySelector('.settings-version__label');
    const value = el.querySelector('.settings-version__value');

    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('Version:');
    expect(value).not.toBeNull();
    expect(value!.textContent).toBe('...');
  });

  it('loads and displays version from /version.txt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();

    // Wait for async fetch to resolve
    await new Promise(resolve => setTimeout(resolve, 10));

    const value = el.querySelector('.settings-version__value');
    expect(value!.textContent).toBe('0.1.0');
  });

  it('shows "unknown" when version fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const el = createVersionSection();

    // Wait for async fetch to resolve
    await new Promise(resolve => setTimeout(resolve, 10));

    const value = el.querySelector('.settings-version__value');
    expect(value!.textContent).toBe('unknown');
  });

  it('renders check for updates button', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    const checkBtn = el.querySelector('.settings-version__check-btn') as HTMLButtonElement;

    expect(checkBtn).not.toBeNull();
    expect(checkBtn.textContent).toBe('Check for Updates');
    expect(checkBtn.className).toContain('btn');
  });

  it('renders force refresh button', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    const forceBtn = el.querySelector('.settings-version__force-btn') as HTMLButtonElement;

    expect(forceBtn).not.toBeNull();
    expect(forceBtn.textContent).toBe('Force Refresh');
    expect(forceBtn.className).toContain('btn');
  });

  it('renders safety note', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    const note = el.querySelector('.settings-version__note');

    expect(note).not.toBeNull();
    expect(note!.textContent).toContain('not affected by updates or force refresh');
  });

  it('check button shows "Checking..." while updating', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    // Mock service worker registration
    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update: mockUpdate }),
      },
    });

    const el = createVersionSection();
    const checkBtn = el.querySelector('.settings-version__check-btn') as HTMLButtonElement;

    checkBtn.click();

    expect(checkBtn.disabled).toBe(true);
    expect(checkBtn.textContent).toBe('Checking...');
  });

  it('check button shows "Up to date" after successful check', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update: mockUpdate }),
      },
    });

    const el = createVersionSection();
    const checkBtn = el.querySelector('.settings-version__check-btn') as HTMLButtonElement;

    checkBtn.click();

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockUpdate).toHaveBeenCalled();
    expect(checkBtn.textContent).toBe('Up to date');
  });

  it('check button shows "Check failed" on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockRejectedValue(new Error('SW error')),
      },
    });

    const el = createVersionSection();
    const checkBtn = el.querySelector('.settings-version__check-btn') as HTMLButtonElement;

    checkBtn.click();

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(checkBtn.textContent).toBe('Check failed');
  });

  it('check button re-enables after timeout', async () => {
    vi.useFakeTimers();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({ update: mockUpdate }),
      },
    });

    const el = createVersionSection();
    const checkBtn = el.querySelector('.settings-version__check-btn') as HTMLButtonElement;

    checkBtn.click();

    // Let the async handler resolve
    await vi.advanceTimersByTimeAsync(10);

    expect(checkBtn.textContent).toBe('Up to date');

    // Advance past the 3s re-enable timeout
    vi.advanceTimersByTime(3000);

    expect(checkBtn.disabled).toBe(false);
    expect(checkBtn.textContent).toBe('Check for Updates');

    vi.useRealTimers();
  });

  it('force refresh button calls requestForceRefresh after confirmation', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const el = createVersionSection();
    const forceBtn = el.querySelector('.settings-version__force-btn') as HTMLButtonElement;

    forceBtn.click();

    expect(confirmSpy).toHaveBeenCalledWith(
      'This will reload the app. Your agents and data are safe.'
    );
    expect(requestForceRefresh).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('force refresh button does nothing when confirmation is cancelled', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const el = createVersionSection();
    const forceBtn = el.querySelector('.settings-version__force-btn') as HTMLButtonElement;

    forceBtn.click();

    expect(confirmSpy).toHaveBeenCalled();
    expect(requestForceRefresh).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('has correct button container structure', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      text: () => Promise.resolve('0.1.0\n'),
    }));

    const el = createVersionSection();
    const buttonRow = el.querySelector('.settings-version__buttons');

    expect(buttonRow).not.toBeNull();
    expect(buttonRow!.children.length).toBe(2);
  });
});
