/**
 * Push notification subscription flow.
 * Handles VAPID key exchange, browser push subscription,
 * PIN verification overlay, and hub coordination.
 */

import type { HubClient } from '../shell/hub-client.js';
import { showToast } from './toast.js';

/**
 * Get or create a persistent device ID for this browser.
 */
export function getDeviceId(): string {
  const KEY = 'flo-device-id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export type PushFlowState =
  | 'idle'
  | 'requesting-permission'
  | 'subscribing'
  | 'waiting-pin'
  | 'verifying'
  | 'verified'
  | 'error';

export class PushSubscribeFlow {
  private overlayEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private pinInput: HTMLInputElement | null = null;
  private verifyBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private state: PushFlowState = 'idle';
  private hubClient: HubClient;
  private hubConnectionId: string;
  private deviceId: string;
  private cleanupHandlers: (() => void)[] = [];

  constructor(hubClient: HubClient, hubConnectionId: string) {
    this.hubClient = hubClient;
    this.hubConnectionId = hubConnectionId;
    this.deviceId = getDeviceId();
  }

  /**
   * Start the push subscription flow.
   * Shows the PIN overlay, requests permission, subscribes, and waits for PIN.
   */
  async start(): Promise<void> {
    // Show overlay immediately
    this.showOverlay();
    this.setStatus('Setting up notifications...');

    try {
      // 1. Get VAPID public key (cached from hub auth)
      const vapidKey = this.hubClient.getVapidKey(this.hubConnectionId);
      if (!vapidKey) {
        this.setStatus('Push notifications are not enabled on this hub.');
        this.setState('error');
        return;
      }

      // 2. Request notification permission
      this.setState('requesting-permission');
      this.setStatus('Requesting notification permission...');

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.setStatus('Notification permission denied. Please allow notifications and try again.');
        this.setState('error');
        return;
      }

      // 3. Subscribe to push
      this.setState('subscribing');
      this.setStatus('Setting up push subscription...');

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.urlBase64ToUint8Array(vapidKey) as BufferSource,
      });

      // 4. Send subscription to hub
      const subJSON = subscription.toJSON();
      this.hubClient.sendPushSubscribe(this.hubConnectionId, this.deviceId, subJSON);

      // 5. Wait for hub response + PIN
      this.setState('waiting-pin');
      this.setStatus('Check your notifications for a 4-digit PIN');
      this.enablePinInput(true);

    } catch (err) {
      console.error('[push] Subscription flow error:', err);
      this.setStatus(`Error: ${(err as Error).message}`);
      this.setState('error');
    }
  }

  /**
   * Handle PIN verification submission.
   */
  private async verifyPin(): Promise<void> {
    const pin = this.pinInput?.value?.trim() || '';
    if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
      this.setStatus('Please enter a 4-digit PIN');
      return;
    }

    this.setState('verifying');
    this.setStatus('Verifying PIN...');
    this.enablePinInput(false);

    // Listen for verify result
    const resultPromise = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 15000);
      const unsub = this.hubClient.onPushEvent((msg) => {
        if (msg.type === 'push_verify_result' && msg.deviceId === this.deviceId) {
          clearTimeout(timeout);
          unsub();
          resolve(msg.verified);
        }
      });
      this.cleanupHandlers.push(unsub);
    });

    this.hubClient.sendPushVerifyPin(this.hubConnectionId, this.deviceId, pin);

    const verified = await resultPromise;
    if (verified) {
      this.setState('verified');
      this.showSuccessState();
      showToast({ message: 'Push notifications enabled', type: 'info' });
    } else {
      this.setState('waiting-pin');
      this.setStatus('Invalid or expired PIN. Check your notifications and try again.');
      this.enablePinInput(true);
      if (this.pinInput) {
        this.pinInput.value = '';
        this.pinInput.focus();
      }
    }
  }

  /**
   * Handle subscribe result from hub (success or error).
   */
  handleSubscribeResult(result: { deviceId: string; success: boolean; error?: string }): void {
    if (result.deviceId !== this.deviceId) return;
    if (!result.success) {
      this.setStatus(`Subscription failed: ${result.error || 'Unknown error'}`);
      this.setState('error');
      this.enablePinInput(false);
    }
    // Success is implicit — the hub sends a test push with the PIN
  }

  /**
   * Show the PIN entry overlay.
   */
  private showOverlay(): void {
    if (this.overlayEl) return;

    this.overlayEl = document.createElement('div');
    this.overlayEl.className = 'push-overlay';

    const card = document.createElement('div');
    card.className = 'push-overlay__card';

    const title = document.createElement('h2');
    title.textContent = 'Enable Push Notifications';
    card.appendChild(title);

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'push-overlay__status';
    this.statusEl.textContent = 'Initializing...';
    card.appendChild(this.statusEl);

    const pinGroup = document.createElement('div');
    pinGroup.className = 'push-overlay__pin-group';

    this.pinInput = document.createElement('input');
    this.pinInput.type = 'tel';
    this.pinInput.maxLength = 4;
    this.pinInput.pattern = '[0-9]*';
    this.pinInput.inputMode = 'numeric';
    this.pinInput.className = 'push-overlay__pin-input';
    this.pinInput.placeholder = '0000';
    this.pinInput.disabled = true;
    this.pinInput.autocomplete = 'off';
    this.pinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.verifyPin();
      }
    });
    pinGroup.appendChild(this.pinInput);
    card.appendChild(pinGroup);

    const actions = document.createElement('div');
    actions.className = 'push-overlay__actions';

    this.cancelBtn = document.createElement('button');
    this.cancelBtn.className = 'btn';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.addEventListener('click', () => this.hideOverlay());
    actions.appendChild(this.cancelBtn);

    this.verifyBtn = document.createElement('button');
    this.verifyBtn.className = 'btn btn--primary';
    this.verifyBtn.textContent = 'Verify PIN';
    this.verifyBtn.disabled = true;
    this.verifyBtn.addEventListener('click', () => this.verifyPin());
    actions.appendChild(this.verifyBtn);

    card.appendChild(actions);
    this.overlayEl.appendChild(card);
    document.body.appendChild(this.overlayEl);
  }

  /**
   * Hide and clean up the overlay.
   */
  hideOverlay(): void {
    if (this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
    this.statusEl = null;
    this.pinInput = null;
    this.verifyBtn = null;
    this.cancelBtn = null;
    this.state = 'idle';

    // Clean up event listeners
    for (const cleanup of this.cleanupHandlers) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this.cleanupHandlers = [];
  }

  /**
   * Check if the overlay is currently shown.
   */
  isVisible(): boolean {
    return this.overlayEl !== null;
  }

  /**
   * Get current flow state.
   */
  getState(): PushFlowState {
    return this.state;
  }

  /**
   * Replace overlay content with a success message and close button.
   */
  private showSuccessState(): void {
    const card = this.overlayEl?.querySelector('.push-overlay__card');
    if (!card) return;

    card.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Push Notifications Enabled';
    card.appendChild(title);

    const msg = document.createElement('p');
    msg.className = 'push-overlay__status';
    msg.textContent = 'Push notifications are now set up. Your agents can notify you when they need your attention or want to share updates — even when flo.monster isn\'t focused.';
    card.appendChild(msg);

    const actions = document.createElement('div');
    actions.className = 'push-overlay__actions';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn--primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => this.hideOverlay());
    actions.appendChild(closeBtn);

    card.appendChild(actions);
  }

  private setState(state: PushFlowState): void {
    this.state = state;
  }

  private setStatus(text: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = text;
    }
  }

  private enablePinInput(enabled: boolean): void {
    if (this.pinInput) {
      this.pinInput.disabled = !enabled;
      if (enabled) {
        this.pinInput.focus();
      }
    }
    if (this.verifyBtn) {
      this.verifyBtn.disabled = !enabled;
    }
  }

  /**
   * Convert a URL-safe base64 string to a Uint8Array (for applicationServerKey).
   */
  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
}
