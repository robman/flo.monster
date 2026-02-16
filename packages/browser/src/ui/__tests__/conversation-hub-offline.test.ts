import { describe, it, expect, beforeEach } from 'vitest';
import { ConversationView } from '../conversation.js';

describe('ConversationView hub offline', () => {
  let container: HTMLElement;
  let view: ConversationView;

  beforeEach(() => {
    container = document.createElement('div');
    view = new ConversationView(container);
  });

  describe('setHubOffline', () => {
    it('creates and shows banner when offline', () => {
      view.setHubOffline(true);

      const banner = container.querySelector('.hub-offline-banner');
      expect(banner).not.toBeNull();
      expect(banner!.textContent).toContain('Hub offline');
      expect((banner as HTMLElement).style.display).toBe('flex');
    });

    it('hides banner when online', () => {
      view.setHubOffline(true);
      view.setHubOffline(false);

      const banner = container.querySelector('.hub-offline-banner');
      expect(banner).not.toBeNull();
      expect((banner as HTMLElement).style.display).toBe('none');
    });

    it('disables send button when offline', () => {
      const sendBtn = container.querySelector('.user-input__send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);

      view.setHubOffline(true);
      expect(sendBtn.disabled).toBe(true);
    });

    it('enables send button when online', () => {
      view.setHubOffline(true);
      view.setHubOffline(false);

      const sendBtn = container.querySelector('.user-input__send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('disables textarea when offline', () => {
      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);

      view.setHubOffline(true);
      expect(textarea.disabled).toBe(true);
    });

    it('enables textarea when online', () => {
      view.setHubOffline(true);
      view.setHubOffline(false);

      const textarea = container.querySelector('.user-input__textarea') as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(false);
    });

    it('is idempotent — same value does not duplicate banner', () => {
      view.setHubOffline(true);
      view.setHubOffline(true);

      const banners = container.querySelectorAll('.hub-offline-banner');
      expect(banners).toHaveLength(1);
    });

    it('places banner before the input area', () => {
      view.setHubOffline(true);

      const banner = container.querySelector('.hub-offline-banner') as HTMLElement;
      const inputEl = container.querySelector('.user-input') as HTMLElement;
      // Banner should come before the input element in the DOM
      expect(banner.compareDocumentPosition(inputEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
