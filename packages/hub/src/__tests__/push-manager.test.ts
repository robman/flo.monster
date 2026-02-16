/**
 * Tests for PushManager: VAPID keys, subscriptions, PIN verification,
 * device state tracking, and push delivery.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Mock web-push module (default export — CJS module used via default import)
const mockWebPush = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({
    publicKey: 'test-public-key-base64',
    privateKey: 'test-private-key-base64',
  })),
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn().mockResolvedValue({}),
}));
vi.mock('web-push', () => ({ default: mockWebPush }));

import { PushManager, type PushConfig } from '../push-manager.js';

describe('PushManager', () => {
  let tmpDir: string;
  let pushManager: PushManager;
  const defaultConfig: PushConfig = {
    enabled: true,
    vapidEmail: 'test@flo.monster',
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create a temporary directory for test data
    tmpDir = path.join('/tmp', `push-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });

    pushManager = new PushManager(tmpDir, defaultConfig);
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('init', () => {
    it('generates VAPID keys on first init', async () => {
      await pushManager.init();

      expect(mockWebPush.generateVAPIDKeys).toHaveBeenCalled();
      expect(mockWebPush.setVapidDetails).toHaveBeenCalledWith(
        'mailto:test@flo.monster',
        'test-public-key-base64',
        'test-private-key-base64',
      );
    });

    it('loads existing VAPID keys from disk', async () => {
      // Write keys to disk first
      const pushDir = path.join(tmpDir, 'push');
      await fs.promises.mkdir(pushDir, { recursive: true });
      const existingKeys = { publicKey: 'existing-pub', privateKey: 'existing-priv' };
      await fs.promises.writeFile(
        path.join(pushDir, 'vapid-keys.json'),
        JSON.stringify(existingKeys),
      );

      await pushManager.init();

      // Should NOT have generated new keys
      expect(mockWebPush.generateVAPIDKeys).not.toHaveBeenCalled();
      expect(mockWebPush.setVapidDetails).toHaveBeenCalledWith(
        'mailto:test@flo.monster',
        'existing-pub',
        'existing-priv',
      );
    });

    it('skips initialization when disabled', async () => {
      const disabledManager = new PushManager(tmpDir, { enabled: false, vapidEmail: '' });
      await disabledManager.init();

      expect(mockWebPush.generateVAPIDKeys).not.toHaveBeenCalled();
      expect(mockWebPush.setVapidDetails).not.toHaveBeenCalled();
      expect(disabledManager.isEnabled).toBe(false);
    });

    it('creates push directory on init', async () => {
      await pushManager.init();

      const pushDir = path.join(tmpDir, 'push');
      const stat = await fs.promises.stat(pushDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('saves VAPID keys with 0o600 permissions', async () => {
      await pushManager.init();

      const keysPath = path.join(tmpDir, 'push', 'vapid-keys.json');
      const stat = await fs.promises.stat(keysPath);
      // Check owner read/write only (0o600)
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe('isEnabled', () => {
    it('returns true when config enabled and keys loaded', async () => {
      await pushManager.init();
      expect(pushManager.isEnabled).toBe(true);
    });

    it('returns false when config disabled', async () => {
      const disabled = new PushManager(tmpDir, { enabled: false, vapidEmail: '' });
      await disabled.init();
      expect(disabled.isEnabled).toBe(false);
    });
  });

  describe('getVapidPublicKey', () => {
    it('returns public key after init', async () => {
      await pushManager.init();
      expect(pushManager.getVapidPublicKey()).toBe('test-public-key-base64');
    });

    it('returns null before init', () => {
      expect(pushManager.getVapidPublicKey()).toBeNull();
    });
  });

  describe('subscribe', () => {
    const testSubscription = {
      endpoint: 'https://push.example.com/send/abc123',
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    };

    it('creates subscription with PIN', async () => {
      await pushManager.init();
      const result = await pushManager.subscribe('device-1', testSubscription);

      expect('pin' in result).toBe(true);
      if ('pin' in result) {
        expect(result.pin).toMatch(/^\d{4}$/);
      }
    });

    it('sends test notification with PIN', async () => {
      await pushManager.init();
      await pushManager.subscribe('device-1', testSubscription);

      expect(mockWebPush.sendNotification).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(mockWebPush.sendNotification).mock.calls[0];
      expect(callArgs[0]).toEqual({
        endpoint: testSubscription.endpoint,
        keys: testSubscription.keys,
      });
      const payload = JSON.parse(callArgs[1] as string);
      expect(payload.title).toBe('flo.monster');
      expect(payload.body).toContain('verification PIN');
      expect(payload.tag).toBe('pin-verification');
    });

    it('returns error when push not enabled', async () => {
      const disabled = new PushManager(tmpDir, { enabled: false, vapidEmail: '' });
      await disabled.init();
      const result = await disabled.subscribe('device-1', testSubscription);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('not enabled');
      }
    });

    it('returns error when sendNotification fails', async () => {
      vi.mocked(mockWebPush.sendNotification).mockRejectedValueOnce(new Error('Network error'));
      await pushManager.init();

      const result = await pushManager.subscribe('device-1', testSubscription);

      expect('error' in result).toBe(true);
      if ('error' in result) {
        expect(result.error).toContain('Network error');
      }
    });

    it('cleans up subscription when sendNotification fails', async () => {
      vi.mocked(mockWebPush.sendNotification).mockRejectedValueOnce(new Error('Network error'));
      await pushManager.init();

      await pushManager.subscribe('device-1', testSubscription);

      // Subscription should have been cleaned up - verify by trying to verify a PIN
      const verifyResult = await pushManager.verifyPin('device-1', '0000');
      expect(verifyResult).toBe(false);
    });
  });

  describe('verifyPin', () => {
    const testSubscription = {
      endpoint: 'https://push.example.com/send/abc123',
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    };

    it('succeeds with correct PIN', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      expect('pin' in subResult).toBe(true);
      if (!('pin' in subResult)) return;

      const verified = await pushManager.verifyPin('device-1', subResult.pin);
      expect(verified).toBe(true);
    });

    it('fails with wrong PIN', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      expect('pin' in subResult).toBe(true);

      const verified = await pushManager.verifyPin('device-1', '0000');
      expect(verified).toBe(false);
    });

    it('fails for unknown device', async () => {
      await pushManager.init();
      const verified = await pushManager.verifyPin('unknown-device', '1234');
      expect(verified).toBe(false);
    });

    it('fails after PIN expiry', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      expect('pin' in subResult).toBe(true);
      if (!('pin' in subResult)) return;

      // Advance time past expiry (5 minutes)
      const originalNow = Date.now;
      Date.now = () => originalNow() + 6 * 60 * 1000;

      try {
        const verified = await pushManager.verifyPin('device-1', subResult.pin);
        expect(verified).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });

    it('fails if already verified', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      expect('pin' in subResult).toBe(true);
      if (!('pin' in subResult)) return;

      // First verify succeeds
      const first = await pushManager.verifyPin('device-1', subResult.pin);
      expect(first).toBe(true);

      // Second verify fails (already verified, PIN cleared)
      const second = await pushManager.verifyPin('device-1', subResult.pin);
      expect(second).toBe(false);
    });
  });

  describe('unsubscribe', () => {
    it('removes subscription', async () => {
      const testSubscription = {
        endpoint: 'https://push.example.com/send/abc123',
        keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
      };
      await pushManager.init();
      await pushManager.subscribe('device-1', testSubscription);

      await pushManager.unsubscribe('device-1');

      // Verify PIN should fail after unsubscribe
      const verified = await pushManager.verifyPin('device-1', '1234');
      expect(verified).toBe(false);
    });

    it('is safe to call for unknown device', async () => {
      await pushManager.init();
      await pushManager.unsubscribe('unknown-device');
      // Should not throw
    });
  });

  describe('device visibility tracking', () => {
    it('setDeviceVisibility updates state', () => {
      pushManager.setDeviceVisibility('device-1', true);
      // isAnyDeviceActive requires both connected AND visible
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });

    it('setDeviceConnected updates state', () => {
      pushManager.setDeviceConnected('device-1', true);
      // isAnyDeviceActive requires both connected AND visible
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });
  });

  describe('isAnyDeviceActive', () => {
    it('returns true when device is both connected and visible', () => {
      pushManager.setDeviceConnected('device-1', true);
      pushManager.setDeviceVisibility('device-1', true);
      expect(pushManager.isAnyDeviceActive()).toBe(true);
    });

    it('returns false when device is connected but not visible', () => {
      pushManager.setDeviceConnected('device-1', true);
      pushManager.setDeviceVisibility('device-1', false);
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });

    it('returns false when device is visible but not connected', () => {
      pushManager.setDeviceConnected('device-1', false);
      pushManager.setDeviceVisibility('device-1', true);
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });

    it('returns false when no devices tracked', () => {
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });

    it('returns true if at least one device is active among multiple', () => {
      pushManager.setDeviceConnected('device-1', true);
      pushManager.setDeviceVisibility('device-1', false);

      pushManager.setDeviceConnected('device-2', true);
      pushManager.setDeviceVisibility('device-2', true);

      expect(pushManager.isAnyDeviceActive()).toBe(true);
    });

    it('returns false after device disconnects', () => {
      pushManager.setDeviceConnected('device-1', true);
      pushManager.setDeviceVisibility('device-1', true);
      expect(pushManager.isAnyDeviceActive()).toBe(true);

      pushManager.setDeviceConnected('device-1', false);
      expect(pushManager.isAnyDeviceActive()).toBe(false);
    });
  });

  describe('sendPush', () => {
    const testSubscription = {
      endpoint: 'https://push.example.com/send/abc123',
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    };

    it('skips when device is active', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      // Mark device as active
      pushManager.setDeviceConnected('device-1', true);
      pushManager.setDeviceVisibility('device-1', true);

      vi.mocked(mockWebPush.sendNotification).mockClear();

      await pushManager.sendPush({ title: 'Test', body: 'Hello' });

      // Should NOT have sent a push (device is active)
      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('sends to verified subscriptions when no device active', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      vi.mocked(mockWebPush.sendNotification).mockClear();

      await pushManager.sendPush({ title: 'Test', body: 'Hello' });

      expect(mockWebPush.sendNotification).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(mockWebPush.sendNotification).mock.calls[0];
      const payload = JSON.parse(callArgs[1] as string);
      expect(payload.title).toBe('Test');
      expect(payload.body).toBe('Hello');
    });

    it('skips unverified subscriptions', async () => {
      await pushManager.init();
      // Subscribe but do NOT verify
      await pushManager.subscribe('device-1', testSubscription);

      vi.mocked(mockWebPush.sendNotification).mockClear();

      await pushManager.sendPush({ title: 'Test', body: 'Hello' });

      // Should NOT have sent (subscription not verified)
      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('does nothing when push not enabled', async () => {
      const disabled = new PushManager(tmpDir, { enabled: false, vapidEmail: '' });
      await disabled.init();

      await disabled.sendPush({ title: 'Test', body: 'Hello' });
      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('removes expired subscriptions (410 Gone)', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      // Mock 410 response on push
      vi.mocked(mockWebPush.sendNotification).mockClear();
      const gone = new Error('Gone') as any;
      gone.statusCode = 410;
      vi.mocked(mockWebPush.sendNotification).mockRejectedValueOnce(gone);

      await pushManager.sendPush({ title: 'Test', body: 'Hello' });

      // Clear and try to push again - should not attempt since subscription was removed
      vi.mocked(mockWebPush.sendNotification).mockClear();
      vi.mocked(mockWebPush.sendNotification).mockResolvedValue({} as any);

      await pushManager.sendPush({ title: 'Test2', body: 'Hello2' });

      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('removes expired subscriptions (404 Not Found)', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      vi.mocked(mockWebPush.sendNotification).mockClear();
      const notFound = new Error('Not Found') as any;
      notFound.statusCode = 404;
      vi.mocked(mockWebPush.sendNotification).mockRejectedValueOnce(notFound);

      await pushManager.sendPush({ title: 'Test', body: 'Hello' });

      // Subscription should be removed
      vi.mocked(mockWebPush.sendNotification).mockClear();
      vi.mocked(mockWebPush.sendNotification).mockResolvedValue({} as any);

      await pushManager.sendPush({ title: 'Test2', body: 'Hello2' });
      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('keeps subscription on transient error (non-410/404)', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      vi.mocked(mockWebPush.sendNotification).mockClear();
      const tempError = new Error('Temporary') as any;
      tempError.statusCode = 500;
      vi.mocked(mockWebPush.sendNotification).mockRejectedValueOnce(tempError);

      // Suppress console.error for expected error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await pushManager.sendPush({ title: 'Test', body: 'Hello' });
      consoleSpy.mockRestore();

      // Subscription should still be there
      vi.mocked(mockWebPush.sendNotification).mockClear();
      vi.mocked(mockWebPush.sendNotification).mockResolvedValue({} as any);

      await pushManager.sendPush({ title: 'Test2', body: 'Hello2' });
      expect(mockWebPush.sendNotification).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscription persistence', () => {
    const testSubscription = {
      endpoint: 'https://push.example.com/send/abc123',
      keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
    };

    it('verified subscriptions survive reload', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      // Create a new PushManager with same data dir
      const newManager = new PushManager(tmpDir, defaultConfig);
      await newManager.init();

      // Should be able to send push to the restored subscription
      vi.mocked(mockWebPush.sendNotification).mockClear();
      await newManager.sendPush({ title: 'Test', body: 'Hello' });
      expect(mockWebPush.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('unverified subscriptions are not loaded on restart', async () => {
      await pushManager.init();
      // Subscribe but do NOT verify
      await pushManager.subscribe('device-1', testSubscription);

      // Create a new PushManager
      const newManager = new PushManager(tmpDir, defaultConfig);
      await newManager.init();

      vi.mocked(mockWebPush.sendNotification).mockClear();
      await newManager.sendPush({ title: 'Test', body: 'Hello' });
      // Should not send — unverified subscription not loaded
      expect(mockWebPush.sendNotification).not.toHaveBeenCalled();
    });

    it('subscriptions file has 0o600 permissions', async () => {
      await pushManager.init();
      const subResult = await pushManager.subscribe('device-1', testSubscription);
      if ('pin' in subResult) {
        await pushManager.verifyPin('device-1', subResult.pin);
      }

      const subsPath = path.join(tmpDir, 'push', 'subscriptions.json');
      const stat = await fs.promises.stat(subsPath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});
