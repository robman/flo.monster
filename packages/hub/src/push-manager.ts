/**
 * Push notification manager for the hub server.
 * Handles VAPID key management, push subscriptions, PIN verification, and push delivery.
 */

import webPush from 'web-push';
import * as fs from 'fs';
import * as path from 'path';

export interface PushSubscriptionData {
  deviceId: string;
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  verified: boolean;
  pin?: string;
  pinExpiry?: number;
  createdAt: number;
}

export interface DeviceState {
  wsConnected: boolean;
  documentVisible: boolean;
  lastActivity: number;
}

export interface PushConfig {
  enabled: boolean;
  vapidEmail: string;
}

export class PushManager {
  private vapidKeys: { publicKey: string; privateKey: string } | null = null;
  private subscriptions: Map<string, PushSubscriptionData> = new Map();
  private deviceStates: Map<string, DeviceState> = new Map();
  private pushDir: string;
  private config: PushConfig;

  constructor(dataDir: string, config: PushConfig) {
    this.pushDir = path.join(dataDir, 'push');
    this.config = config;
  }

  async init(): Promise<void> {
    if (!this.config.enabled) return;

    // Ensure push directory exists
    await fs.promises.mkdir(this.pushDir, { recursive: true });

    // Load or generate VAPID keys
    await this.loadOrGenerateVapidKeys();

    // Load subscriptions
    await this.loadSubscriptions();

    // Configure web-push
    if (this.vapidKeys) {
      const subject = this.config.vapidEmail.startsWith('mailto:')
        ? this.config.vapidEmail
        : `mailto:${this.config.vapidEmail}`;
      webPush.setVapidDetails(
        subject,
        this.vapidKeys.publicKey,
        this.vapidKeys.privateKey
      );
      console.log('[push] VAPID configured, public key:', this.vapidKeys.publicKey.substring(0, 20) + '...');
    }
  }

  get isEnabled(): boolean {
    return this.config.enabled && this.vapidKeys !== null;
  }

  getVapidPublicKey(): string | null {
    return this.vapidKeys?.publicKey ?? null;
  }

  /**
   * Register a push subscription for a device. Generates a PIN for verification.
   */
  async subscribe(deviceId: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string } }): Promise<{ pin: string } | { error: string }> {
    if (!this.isEnabled) return { error: 'Push notifications not enabled' };

    const pin = this.generatePin();
    const sub: PushSubscriptionData = {
      deviceId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      verified: false,
      pin,
      pinExpiry: Date.now() + 5 * 60 * 1000, // 5 minutes
      createdAt: Date.now(),
    };

    this.subscriptions.set(deviceId, sub);
    await this.saveSubscriptions();

    // Send test notification with PIN
    try {
      await this.sendRawPush(sub, {
        title: 'flo.monster',
        body: `Your verification PIN is: ${pin}`,
        tag: 'pin-verification',
      });
    } catch (err: any) {
      console.error('[push] Test notification failed:', {
        statusCode: err.statusCode,
        headers: err.headers,
        message: err.message,
        body: err.body,
        endpoint: sub.endpoint.substring(0, 60) + '...',
      });
      this.subscriptions.delete(deviceId);
      await this.saveSubscriptions();
      return { error: `Failed to send test notification: ${err.statusCode || ''} ${err.message}` };
    }

    return { pin };
  }

  /**
   * Verify a PIN for a device subscription.
   */
  async verifyPin(deviceId: string, pin: string): Promise<boolean> {
    const sub = this.subscriptions.get(deviceId);
    if (!sub || sub.verified) return false;

    // Check expiry
    if (sub.pinExpiry && Date.now() > sub.pinExpiry) {
      this.subscriptions.delete(deviceId);
      await this.saveSubscriptions();
      return false;
    }

    // Check PIN
    if (sub.pin !== pin) return false;

    // Verify
    sub.verified = true;
    delete sub.pin;
    delete sub.pinExpiry;
    await this.saveSubscriptions();
    return true;
  }

  /**
   * Remove a device's push subscription.
   */
  async unsubscribe(deviceId: string): Promise<void> {
    this.subscriptions.delete(deviceId);
    await this.saveSubscriptions();
  }

  /**
   * Update device visibility state.
   */
  setDeviceVisibility(deviceId: string, visible: boolean): void {
    const state = this.deviceStates.get(deviceId) ?? { wsConnected: false, documentVisible: false, lastActivity: Date.now() };
    state.documentVisible = visible;
    state.lastActivity = Date.now();
    this.deviceStates.set(deviceId, state);
  }

  /**
   * Mark a device as WebSocket connected/disconnected.
   */
  setDeviceConnected(deviceId: string, connected: boolean): void {
    const state = this.deviceStates.get(deviceId) ?? { wsConnected: false, documentVisible: false, lastActivity: Date.now() };
    state.wsConnected = connected;
    state.lastActivity = Date.now();
    this.deviceStates.set(deviceId, state);
  }

  /**
   * Check if ANY device is both connected and document-visible.
   */
  isAnyDeviceActive(): boolean {
    for (const state of this.deviceStates.values()) {
      if (state.wsConnected && state.documentVisible) return true;
    }
    return false;
  }

  /**
   * Send a push notification to all verified subscriptions (if no device is active).
   */
  async sendPush(payload: { title: string; body: string; tag?: string; agentId?: string }): Promise<void> {
    if (!this.isEnabled) return;

    // Only send if no device is active + visible
    if (this.isAnyDeviceActive()) return;

    const failedDevices: string[] = [];
    for (const [deviceId, sub] of this.subscriptions) {
      if (!sub.verified) continue;
      try {
        await this.sendRawPush(sub, payload);
      } catch (err: any) {
        // 410 Gone or 404 Not Found = subscription expired, remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          failedDevices.push(deviceId);
        } else {
          console.error(`[push] Failed to send to device ${deviceId}:`, err.message);
        }
      }
    }

    // Clean up expired subscriptions
    if (failedDevices.length > 0) {
      for (const id of failedDevices) {
        this.subscriptions.delete(id);
      }
      await this.saveSubscriptions();
    }
  }

  // --- Internal ---

  private async sendRawPush(sub: PushSubscriptionData, payload: Record<string, unknown>): Promise<void> {
    await webPush.sendNotification(
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
      },
      JSON.stringify(payload),
      {
        TTL: 3600,
        urgency: 'normal',
      }
    );
  }

  private generatePin(): string {
    const digits = Math.floor(1000 + Math.random() * 9000);
    return digits.toString();
  }

  private async loadOrGenerateVapidKeys(): Promise<void> {
    const keysPath = path.join(this.pushDir, 'vapid-keys.json');
    try {
      const data = await fs.promises.readFile(keysPath, 'utf-8');
      this.vapidKeys = JSON.parse(data);
    } catch {
      // Generate new keys
      const keys = webPush.generateVAPIDKeys();
      this.vapidKeys = keys;
      await fs.promises.writeFile(keysPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
    }
  }

  private async loadSubscriptions(): Promise<void> {
    const subsPath = path.join(this.pushDir, 'subscriptions.json');
    try {
      const data = await fs.promises.readFile(subsPath, 'utf-8');
      const entries: PushSubscriptionData[] = JSON.parse(data);
      this.subscriptions.clear();
      for (const entry of entries) {
        // Only load verified subscriptions (unverified are transient)
        if (entry.verified) {
          this.subscriptions.set(entry.deviceId, entry);
        }
      }
    } catch {
      // No subscriptions file yet
    }
  }

  private async saveSubscriptions(): Promise<void> {
    const subsPath = path.join(this.pushDir, 'subscriptions.json');
    const entries = Array.from(this.subscriptions.values());
    const tmpPath = subsPath + '.tmp';
    await fs.promises.writeFile(tmpPath, JSON.stringify(entries, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmpPath, subsPath);
  }
}
