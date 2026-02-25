/**
 * Tests for hub configuration management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  getDefaultConfig,
  validateConfig,
  DEFAULT_RESTRICTED_BLOCKLIST,
  type HubConfig,
  type BrowseToolConfig,
} from '../config.js';

describe('config', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `hub-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('getConfigPath', () => {
    it('should use HOME env var for config path', () => {
      const originalHome = process.env.HOME;
      try {
        process.env.HOME = '/home/flo-test-user';
        const configPath = getConfigPath();
        expect(configPath).toBe('/home/flo-test-user/.flo-monster/hub.json');
      } finally {
        process.env.HOME = originalHome;
      }
    });
  });

  describe('getDefaultConfig', () => {
    it('should return valid default configuration', () => {
      const config = getDefaultConfig();

      expect(config.port).toBe(8765);
      expect(config.host).toBe('127.0.0.1');
      expect(config.name).toBe('Local Hub');
      expect(config.localhostBypassAuth).toBe(true);
      expect(config.tools.bash.enabled).toBe(true);
      expect(config.tools.filesystem.enabled).toBe(true);
      expect(config.fetchProxy.enabled).toBe(true);
    });

    it('should have restricted mode by default', () => {
      const config = getDefaultConfig();
      expect(config.tools.bash.mode).toBe('restricted');
      expect(config.tools.bash.blockedCommands).toBeUndefined();
    });

    it('should have blocked paths for filesystem', () => {
      const config = getDefaultConfig();

      expect(config.tools.filesystem.blockedPaths).toBeDefined();
      expect(config.tools.filesystem.blockedPaths!.length).toBeGreaterThan(0);
    });

    it('should have browse enabled by default', () => {
      const config = getDefaultConfig();
      expect(config.tools.browse).toBeDefined();
      expect(config.tools.browse!.enabled).toBe(true);
      expect(config.tools.browse!.maxConcurrentSessions).toBe(3);
      expect(config.tools.browse!.sessionTimeoutMinutes).toBe(30);
      expect(config.tools.browse!.blockPrivateIPs).toBe(true);
      expect(config.tools.browse!.viewport).toEqual({ width: 1419, height: 813 });
    });
  });

  describe('DEFAULT_RESTRICTED_BLOCKLIST', () => {
    it('should contain scheduling commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('crontab');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('at');
    });

    it('should contain service management commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('systemctl');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('service');
    });

    it('should contain process management commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('kill');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('pkill');
    });

    it('should contain package manager commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('apt');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('apt-get');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('npm install -g');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('pip install');
    });

    it('should contain destructive commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('rm -rf /');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('mkfs');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('dd if=/dev/zero');
    });

    it('should contain kernel/firewall commands', () => {
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('iptables');
      expect(DEFAULT_RESTRICTED_BLOCKLIST).toContain('ufw');
    });
  });

  describe('validateConfig', () => {
    it('should validate a correct config', () => {
      const config = getDefaultConfig();
      expect(validateConfig(config)).toBe(true);
    });

    it('should reject null', () => {
      expect(validateConfig(null)).toBe(false);
    });

    it('should reject non-object', () => {
      expect(validateConfig('string')).toBe(false);
      expect(validateConfig(123)).toBe(false);
    });

    it('should reject invalid port', () => {
      const config = { ...getDefaultConfig(), port: -1 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject port out of range', () => {
      const config = { ...getDefaultConfig(), port: 70000 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject empty host', () => {
      const config = { ...getDefaultConfig(), host: '' };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject empty name', () => {
      const config = { ...getDefaultConfig(), name: '' };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject invalid authToken type', () => {
      const config = { ...getDefaultConfig(), authToken: 123 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should accept config with authToken', () => {
      const config = { ...getDefaultConfig(), authToken: 'secret-token' };
      expect(validateConfig(config)).toBe(true);
    });

    it('should accept valid cliProviders config', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: {
          anthropic: { command: 'claude', timeout: 120000 },
        },
      };
      expect(validateConfig(config)).toBe(true);
    });

    it('should accept cliProviders with minimal config', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: {} },
      };
      expect(validateConfig(config)).toBe(true);
    });

    it('should reject cliProviders that is not an object', () => {
      const config = { ...getDefaultConfig(), cliProviders: 'invalid' };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject cliProviders that is an array', () => {
      const config = { ...getDefaultConfig(), cliProviders: [] };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject cliProviders with invalid command type', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: { command: 123 } },
      };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject cliProviders with invalid args type', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: { args: 'not-array' } },
      };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject cliProviders with invalid timeout', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: { timeout: -1 } },
      };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject cliProviders with non-object provider entry', () => {
      const config = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: 'invalid' },
      };
      expect(validateConfig(config)).toBe(false);
    });

    it('should accept bash mode restricted', () => {
      const config = getDefaultConfig();
      config.tools.bash.mode = 'restricted';
      expect(validateConfig(config)).toBe(true);
    });

    it('should accept bash mode unrestricted', () => {
      const config = getDefaultConfig();
      config.tools.bash.mode = 'unrestricted';
      expect(validateConfig(config)).toBe(true);
    });

    it('should reject invalid bash mode', () => {
      const config = { ...getDefaultConfig() };
      (config.tools.bash as any).mode = 'foo';
      expect(validateConfig(config)).toBe(false);
    });

    it('should accept valid runAsUser', () => {
      const config = getDefaultConfig();
      config.tools.bash.runAsUser = 'flo-agent';
      expect(validateConfig(config)).toBe(true);
    });

    it('should accept runAsUser with underscore prefix', () => {
      const config = getDefaultConfig();
      config.tools.bash.runAsUser = '_www';
      expect(validateConfig(config)).toBe(true);
    });

    it('should reject runAsUser with uppercase', () => {
      const config = { ...getDefaultConfig() };
      config.tools.bash.runAsUser = 'FLO';
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject runAsUser starting with digit', () => {
      const config = { ...getDefaultConfig() };
      config.tools.bash.runAsUser = '123user';
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject runAsUser with spaces', () => {
      const config = { ...getDefaultConfig() };
      config.tools.bash.runAsUser = 'has spaces';
      expect(validateConfig(config)).toBe(false);
    });

    it('should accept config without browse section (backward compat)', () => {
      const config = getDefaultConfig();
      delete (config.tools as any).browse;
      expect(validateConfig(config)).toBe(true);
    });

    it('should accept valid browse config', () => {
      const config = getDefaultConfig();
      config.tools.browse = {
        enabled: true,
        maxConcurrentSessions: 5,
        sessionTimeoutMinutes: 60,
        allowedDomains: ['*.example.com'],
        blockedDomains: ['*.evil.com'],
        blockPrivateIPs: true,
        rateLimitPerDomain: 20,
        viewport: { width: 1920, height: 1080 },
      };
      expect(validateConfig(config)).toBe(true);
    });

    it('should reject browse with invalid maxConcurrentSessions', () => {
      const config = getDefaultConfig();
      config.tools.browse = { ...config.tools.browse!, maxConcurrentSessions: 0 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject browse with invalid sessionTimeoutMinutes', () => {
      const config = getDefaultConfig();
      config.tools.browse = { ...config.tools.browse!, sessionTimeoutMinutes: -1 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject browse with invalid viewport', () => {
      const config = getDefaultConfig();
      config.tools.browse = { ...config.tools.browse!, viewport: { width: 0, height: 720 } };
      expect(validateConfig(config)).toBe(false);
    });

    it('should reject browse with negative rateLimitPerDomain', () => {
      const config = getDefaultConfig();
      config.tools.browse = { ...config.tools.browse!, rateLimitPerDomain: -1 };
      expect(validateConfig(config)).toBe(false);
    });

    it('should accept browse with rateLimitPerDomain of 0 (unlimited)', () => {
      const config = getDefaultConfig();
      config.tools.browse = { ...config.tools.browse!, rateLimitPerDomain: 0 };
      expect(validateConfig(config)).toBe(true);
    });

    it('should validate allowedOrigins as array of strings', () => {
      const config = getDefaultConfig();

      // Valid
      expect(validateConfig({ ...config, allowedOrigins: ['https://flo.monster'] })).toBe(true);
      expect(validateConfig({ ...config, allowedOrigins: [] })).toBe(true);
      expect(validateConfig({ ...config, allowedOrigins: ['https://flo.monster', 'https://app.flo.monster'] })).toBe(true);

      // Invalid
      expect(validateConfig({ ...config, allowedOrigins: 'not-array' })).toBe(false);
      expect(validateConfig({ ...config, allowedOrigins: [123] })).toBe(false);
      expect(validateConfig({ ...config, allowedOrigins: [''] })).toBe(false);
      expect(validateConfig({ ...config, allowedOrigins: ['https://flo.monster', ''] })).toBe(false);
    });
  });

  describe('loadConfig', () => {
    it('should return defaults when file does not exist', async () => {
      const configPath = join(testDir, 'nonexistent', 'hub.json');
      const config = await loadConfig(configPath);

      expect(config).toEqual(getDefaultConfig());
    });

    it('should load config from file', async () => {
      const configPath = join(testDir, 'hub.json');
      const customConfig: HubConfig = {
        ...getDefaultConfig(),
        port: 9999,
        name: 'Custom Hub',
      };

      await writeFile(configPath, JSON.stringify(customConfig), 'utf-8');

      const loaded = await loadConfig(configPath);

      expect(loaded.port).toBe(9999);
      expect(loaded.name).toBe('Custom Hub');
    });

    it('should merge partial config with defaults', async () => {
      const configPath = join(testDir, 'hub.json');
      const partialConfig = { port: 8888 };

      await writeFile(configPath, JSON.stringify(partialConfig), 'utf-8');

      const loaded = await loadConfig(configPath);

      expect(loaded.port).toBe(8888);
      expect(loaded.host).toBe('127.0.0.1'); // default
      expect(loaded.tools.bash.enabled).toBe(true); // default
    });

    it('should merge cliProviders from loaded config', async () => {
      const configPath = join(testDir, 'hub.json');
      const configWithCli = {
        ...getDefaultConfig(),
        cliProviders: { anthropic: { command: 'claude', timeout: 60000 } },
      };

      await writeFile(configPath, JSON.stringify(configWithCli), 'utf-8');

      const loaded = await loadConfig(configPath);

      expect(loaded.cliProviders).toEqual({ anthropic: { command: 'claude', timeout: 60000 } });
    });

    it('should return defaults for invalid JSON', async () => {
      const configPath = join(testDir, 'hub.json');
      await writeFile(configPath, 'not valid json', 'utf-8');

      const config = await loadConfig(configPath);

      expect(config).toEqual(getDefaultConfig());
    });

    it('should merge browse config from loaded file', async () => {
      const configPath = join(testDir, 'hub.json');
      const configWithBrowse = {
        ...getDefaultConfig(),
        tools: {
          ...getDefaultConfig().tools,
          browse: {
            enabled: true,
            maxConcurrentSessions: 10,
            sessionTimeoutMinutes: 60,
            allowedDomains: ['*.test.com'],
            blockedDomains: [],
            blockPrivateIPs: true,
            rateLimitPerDomain: 5,
            viewport: { width: 1920, height: 1080 },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(configWithBrowse), 'utf-8');
      const loaded = await loadConfig(configPath);
      expect(loaded.tools.browse?.enabled).toBe(true);
      expect(loaded.tools.browse?.maxConcurrentSessions).toBe(10);
      expect(loaded.tools.browse?.viewport).toEqual({ width: 1920, height: 1080 });
    });

    it('should use default browse config when not in loaded file', async () => {
      const configPath = join(testDir, 'hub.json');
      // Config without browse section
      const configNoBrowse = {
        ...getDefaultConfig(),
      };
      delete (configNoBrowse.tools as any).browse;
      await writeFile(configPath, JSON.stringify(configNoBrowse), 'utf-8');
      const loaded = await loadConfig(configPath);
      expect(loaded.tools.browse).toBeDefined();
      expect(loaded.tools.browse!.enabled).toBe(true);
    });
  });

  describe('saveConfig', () => {
    it('should create config file', async () => {
      const configPath = join(testDir, 'subdir', 'hub.json');
      const config = getDefaultConfig();

      await saveConfig(config, configPath);

      const content = await readFile(configPath, 'utf-8');
      const saved = JSON.parse(content) as HubConfig;

      expect(saved.port).toBe(config.port);
      expect(saved.name).toBe(config.name);
    });

    it('should write config file with restrictive permissions (0o600)', async () => {
      const configPath = join(testDir, 'hub.json');
      const config = getDefaultConfig();

      await saveConfig(config, configPath);

      const fileStat = await stat(configPath);
      // 0o600 = owner read/write only (octal 600 = decimal 384)
      const mode = fileStat.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('should overwrite existing config', async () => {
      const configPath = join(testDir, 'hub.json');

      await saveConfig({ ...getDefaultConfig(), name: 'First' }, configPath);
      await saveConfig({ ...getDefaultConfig(), name: 'Second' }, configPath);

      const content = await readFile(configPath, 'utf-8');
      const saved = JSON.parse(content) as HubConfig;

      expect(saved.name).toBe('Second');
    });
  });
});
