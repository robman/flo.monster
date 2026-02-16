/**
 * Tests for service worker registration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerServiceWorker, updateServiceWorkerKey, configureHubMode, configureProviderKeys } from '../sw-registration.js';

describe('sw-registration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('registerServiceWorker', () => {
    it('should throw when service workers are not supported', async () => {
      vi.stubGlobal('navigator', {});

      await expect(registerServiceWorker('test-api-key')).rejects.toThrow(
        'Service Workers are not supported in this browser'
      );
    });

    it('should register service worker with correct path and scope', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: mockController });

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: vi.fn(),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await registerServiceWorker('test-api-key');

      expect(mockRegister).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    });

    it('should send configure message to controller after registration', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: mockController });

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: vi.fn(),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await registerServiceWorker('my-secret-key');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure',
        apiKey: 'my-secret-key',
      });
    });

    it('should register controllerchange event listener', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: mockController });
      const mockAddEventListener = vi.fn();

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: mockAddEventListener,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await registerServiceWorker('test-key');

      expect(mockAddEventListener).toHaveBeenCalledWith(
        'controllerchange',
        expect.any(Function)
      );
    });

    it('should send configure when controller changes', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: mockController });
      let controllerChangeCallback: (() => void) | null = null;

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: vi.fn((event: string, cb: () => void) => {
          if (event === 'controllerchange') {
            controllerChangeCallback = cb;
          }
        }),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await registerServiceWorker('test-key');

      // Clear previous calls
      mockPostMessage.mockClear();

      // Simulate controller change
      expect(controllerChangeCallback).not.toBeNull();
      controllerChangeCallback!();

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure',
        apiKey: 'test-key',
      });
    });

    it('should wait for controller if not initially present', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: { postMessage: mockPostMessage },
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: { postMessage: mockPostMessage } });

      let controllerChangeCallback: (() => void) | undefined;
      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: null as typeof mockController | null, // No controller initially
        addEventListener: vi.fn((event: string, cb: () => void) => {
          if (event === 'controllerchange') {
            controllerChangeCallback = cb;
          }
        }),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      // Start registration (will wait for controller)
      const registrationPromise = registerServiceWorker('test-key');

      // Simulate controller becoming available
      await new Promise(resolve => setTimeout(resolve, 10));
      mockSW.controller = mockController;
      controllerChangeCallback!();

      await registrationPromise;

      // Should have sent configure after controller became available
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure',
        apiKey: 'test-key',
      });
    });

    it('should return registration object', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
        scope: '/',
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);
      const mockReady = Promise.resolve({ active: mockController });

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: vi.fn(),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      const result = await registerServiceWorker('test-key');

      expect(result).toBe(mockRegistration);
    });

    it('should propagate registration errors', async () => {
      const mockRegister = vi.fn().mockRejectedValue(new Error('Registration failed'));

      const mockSW = {
        register: mockRegister,
        ready: Promise.resolve({ active: null }),
        controller: null,
        addEventListener: vi.fn(),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await expect(registerServiceWorker('test-key')).rejects.toThrow('Registration failed');
    });

    it('should wait for service worker ready before sending configure', async () => {
      const callOrder: string[] = [];
      const mockPostMessage = vi.fn(() => callOrder.push('postMessage'));
      const mockController = { postMessage: mockPostMessage };
      const mockRegistration = {
        active: mockController,
        installing: null,
        waiting: null,
      };

      const mockRegister = vi.fn().mockResolvedValue(mockRegistration);

      // Create a delayed ready promise
      const mockReady = new Promise<{ active: typeof mockController }>((resolve) => {
        setTimeout(() => {
          callOrder.push('ready');
          resolve({ active: mockController });
        }, 10);
      });

      const mockSW = {
        register: mockRegister,
        ready: mockReady,
        controller: mockController,
        addEventListener: vi.fn(),
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await registerServiceWorker('test-key');

      expect(callOrder).toContain('ready');
    });
  });

  describe('updateServiceWorkerKey', () => {
    it('should throw if no active controller', async () => {
      const mockSW = {
        controller: null,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await expect(updateServiceWorkerKey('new-key')).rejects.toThrow(
        'No active service worker controller'
      );
    });

    it('should send update_key message to controller', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await updateServiceWorkerKey('new-api-key');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'update_key',
        apiKey: 'new-api-key',
      });
    });

    it('should handle different API key formats', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      // Test with typical Anthropic API key format
      await updateServiceWorkerKey('sk-ant-api03-xxxxxxxxxxxxx');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'update_key',
        apiKey: 'sk-ant-api03-xxxxxxxxxxxxx',
      });
    });

    it('should handle empty API key', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await updateServiceWorkerKey('');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'update_key',
        apiKey: '',
      });
    });
  });

  describe('configureHubMode', () => {
    it('should throw if no active controller', async () => {
      const mockSW = {
        controller: null,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await expect(configureHubMode(true, 'http://localhost:8765', 'token')).rejects.toThrow(
        'No active service worker controller'
      );
    });

    it('should send configure_hub message with all parameters', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await configureHubMode(true, 'http://localhost:8765', 'my-hub-token');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_hub',
        enabled: true,
        httpUrl: 'http://localhost:8765',
        token: 'my-hub-token',
      });
    });

    it('should send configure_hub message to disable hub mode', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await configureHubMode(false);

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_hub',
        enabled: false,
        httpUrl: undefined,
        token: undefined,
      });
    });

    it('should handle optional parameters', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await configureHubMode(true, 'http://localhost:8765');

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_hub',
        enabled: true,
        httpUrl: 'http://localhost:8765',
        token: undefined,
      });
    });
  });

  describe('configureProviderKeys', () => {
    it('should throw if no active controller', async () => {
      const mockSW = {
        controller: null,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await expect(configureProviderKeys({ anthropic: 'key' })).rejects.toThrow(
        'No active service worker controller'
      );
    });

    it('should send configure_keys message with provider keys', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      const keys = {
        anthropic: 'sk-ant-test',
        openai: 'sk-openai-test',
        gemini: 'AIza-test',
      };

      await configureProviderKeys(keys);

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_keys',
        keys,
      });
    });

    it('should handle empty keys object', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await configureProviderKeys({});

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_keys',
        keys: {},
      });
    });

    it('should handle single provider key', async () => {
      const mockPostMessage = vi.fn();
      const mockController = { postMessage: mockPostMessage };

      const mockSW = {
        controller: mockController,
      };

      vi.stubGlobal('navigator', { serviceWorker: mockSW });

      await configureProviderKeys({ openai: 'sk-openai-only' });

      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'configure_keys',
        keys: { openai: 'sk-openai-only' },
      });
    });
  });
});
