/**
 * Hub server configuration management
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { HubHooksConfig, HubHookRule } from '@flo-monster/core';
import type { PushConfig } from './push-manager.js';

/**
 * Default command blocklist for restricted mode.
 * Defense-in-depth: catches accidental/helpful misuse. OS user isolation (Layer 2) is the real security boundary.
 */
export const DEFAULT_RESTRICTED_BLOCKLIST: string[] = [
  // Scheduling
  'crontab', 'at', 'atq', 'atrm', 'batch',
  // Services
  'systemctl', 'service', 'launchctl', 'chkconfig', 'update-rc.d',
  // Process management
  'kill', 'pkill', 'killall',
  // Package managers
  'apt', 'apt-get', 'dpkg', 'yum', 'dnf', 'rpm', 'pacman', 'snap', 'brew',
  'pip install', 'pip3 install', 'npm install -g', 'gem install',
  // System administration
  'shutdown', 'reboot', 'halt', 'poweroff',
  'mount', 'umount',
  'useradd', 'userdel', 'passwd', 'chown', 'chmod', 'visudo',
  // Network listeners
  'nc -l', 'ncat -l', 'socat LISTEN',
  'python -m http.server', 'python3 -m http.server',
  // Destructive
  'rm -rf /', 'rm -rf /*', 'mkfs', 'fdisk', 'parted', 'wipefs',
  'dd if=/dev/zero', 'dd if=/dev/random',
  ':(){:|:&};:',  // fork bomb
  // Kernel/firewall
  'insmod', 'rmmod', 'modprobe', 'sysctl',
  'iptables', 'ufw', 'nft',
];

export interface HubToolsConfig {
  bash: {
    enabled: boolean;
    allowedCommands?: string[];
    blockedCommands?: string[];
    mode?: 'restricted' | 'unrestricted';
    runAsUser?: string;
  };
  filesystem: {
    enabled: boolean;
    allowedPaths: string[];
    blockedPaths?: string[];
  };
}

export interface FetchProxyConfig {
  enabled: boolean;
  allowedPatterns: string[];
  blockedPatterns: string[];
}

export interface TlsConfig {
  /** Path to certificate file (PEM format) */
  certFile: string;
  /** Path to private key file (PEM format) */
  keyFile: string;
}

export interface HubConfig {
  /** WebSocket server port. Default: 8765 */
  port: number;
  /** Host to bind to. Default: "127.0.0.1" */
  host: string;
  /** Public hostname for HTTP API URL (e.g., "wh.flo.io"). If not set, uses host. */
  publicHost?: string;
  /** User-friendly name for this hub */
  name: string;
  /** Authentication token. Required for remote, optional for localhost */
  authToken?: string;
  /** Bypass auth for localhost connections. Default: true */
  localhostBypassAuth: boolean;
  /** Tool configuration */
  tools: HubToolsConfig;
  /** Fetch proxy configuration */
  fetchProxy: FetchProxyConfig;
  /** TLS configuration for secure WebSocket (wss://) */
  tls?: TlsConfig;
  /** Sandbox directory path for bash cwd validation. Default: ~/.flo-monster/sandbox */
  sandboxPath?: string;
  /** Agent persistence storage path. Default: ~/.flo-monster/agents */
  agentStorePath?: string;
  /** Admin WebSocket server port. Default: 8766 */
  adminPort: number;
  /** Admin authentication token. Required for admin connections. */
  adminToken?: string;
  /** Hooks configuration for pre/post tool execution */
  hooks?: HubHooksConfig;
  /** Shared API keys for connected browsers without their own keys */
  sharedApiKeys?: {
    anthropic?: string;
    openai?: string;
    gemini?: string;
    [key: string]: string | undefined;
  };
  /** Provider-specific configuration (custom endpoints, per-provider API keys) */
  providers?: {
    [name: string]: {
      endpoint: string;
      apiKey?: string;
    };
  };
  /** Rate limiting configuration for failed auth attempts */
  failedAuthConfig?: {
    maxAttempts: number;      // Default: 5
    lockoutMinutes: number;   // Default: 15
  };
  /** Whether to trust X-Forwarded-For header for client IP (only enable behind trusted proxy) */
  trustProxy?: boolean;
  /** Push notification configuration */
  pushConfig?: PushConfig;
  /** CLI provider configuration (e.g., use Claude Code CLI instead of API key) */
  cliProviders?: {
    [provider: string]: {
      command?: string;    // Default: 'claude'
      args?: string[];     // Extra CLI args
      timeout?: number;    // Default: 120000 (ms)
    };
  };
}

/**
 * Validate a regex pattern, returning true if valid
 */
function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and filter hook rules, logging warnings for invalid rules
 * Returns only the valid rules
 */
function validateHookRules(rules: unknown[], hookType: string): HubHookRule[] {
  const validRules: HubHookRule[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (typeof rule !== 'object' || rule === null) {
      console.warn(`hooks.${hookType}[${i}]: rule must be an object, skipping`);
      continue;
    }

    const r = rule as Record<string, unknown>;

    // command is required
    if (typeof r.command !== 'string' || r.command.length === 0) {
      console.warn(`hooks.${hookType}[${i}]: missing or invalid 'command' string, skipping`);
      continue;
    }

    // Validate matcher regex if present
    if (r.matcher !== undefined) {
      if (typeof r.matcher !== 'string') {
        console.warn(`hooks.${hookType}[${i}]: 'matcher' must be a string, skipping`);
        continue;
      }
      if (!isValidRegex(r.matcher)) {
        console.warn(`hooks.${hookType}[${i}]: 'matcher' is not a valid regex pattern: ${r.matcher}, skipping`);
        continue;
      }
    }

    // Validate inputMatchers if present
    if (r.inputMatchers !== undefined) {
      if (typeof r.inputMatchers !== 'object' || r.inputMatchers === null || Array.isArray(r.inputMatchers)) {
        console.warn(`hooks.${hookType}[${i}]: 'inputMatchers' must be an object, skipping`);
        continue;
      }

      const inputMatchers = r.inputMatchers as Record<string, unknown>;
      let inputMatchersValid = true;

      for (const [field, pattern] of Object.entries(inputMatchers)) {
        if (typeof pattern !== 'string') {
          console.warn(`hooks.${hookType}[${i}]: inputMatchers.${field} must be a string, skipping rule`);
          inputMatchersValid = false;
          break;
        }
        if (!isValidRegex(pattern)) {
          console.warn(`hooks.${hookType}[${i}]: inputMatchers.${field} is not a valid regex pattern: ${pattern}, skipping rule`);
          inputMatchersValid = false;
          break;
        }
      }

      if (!inputMatchersValid) {
        continue;
      }
    }

    // Validate optional timeout
    if (r.timeout !== undefined && (typeof r.timeout !== 'number' || r.timeout <= 0)) {
      console.warn(`hooks.${hookType}[${i}]: 'timeout' must be a positive number, skipping`);
      continue;
    }

    // Validate optional continueOnError
    if (r.continueOnError !== undefined && typeof r.continueOnError !== 'boolean') {
      console.warn(`hooks.${hookType}[${i}]: 'continueOnError' must be a boolean, skipping`);
      continue;
    }

    // Rule is valid
    validRules.push({
      command: r.command,
      matcher: r.matcher as string | undefined,
      inputMatchers: r.inputMatchers as Record<string, string> | undefined,
      timeout: r.timeout as number | undefined,
      continueOnError: r.continueOnError as boolean | undefined,
    });
  }

  return validRules;
}

/**
 * Validate and process hooks configuration
 * Returns validated hooks config with invalid rules filtered out
 */
function validateAndProcessHooks(hooks: unknown): HubHooksConfig | undefined {
  if (hooks === undefined) {
    return undefined;
  }

  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    console.warn('hooks: must be an object, ignoring hooks config');
    return undefined;
  }

  const h = hooks as Record<string, unknown>;
  const result: HubHooksConfig = {};

  if (h.PreToolUse !== undefined) {
    if (!Array.isArray(h.PreToolUse)) {
      console.warn('hooks.PreToolUse: must be an array, ignoring');
    } else {
      const validRules = validateHookRules(h.PreToolUse, 'PreToolUse');
      if (validRules.length > 0) {
        result.PreToolUse = validRules;
      }
    }
  }

  if (h.PostToolUse !== undefined) {
    if (!Array.isArray(h.PostToolUse)) {
      console.warn('hooks.PostToolUse: must be an array, ignoring');
    } else {
      const validRules = validateHookRules(h.PostToolUse, 'PostToolUse');
      if (validRules.length > 0) {
        result.PostToolUse = validRules;
      }
    }
  }

  return result;
}

/**
 * Get the default configuration file path
 */
export function getConfigPath(): string {
  return join(homedir(), '.flo-monster', 'hub.json');
}

/**
 * Get the default hub configuration
 */
export function getDefaultConfig(): HubConfig {
  return {
    port: 8765,
    host: '127.0.0.1',
    name: 'Local Hub',
    localhostBypassAuth: true,
    tools: {
      bash: {
        enabled: true,
        mode: 'restricted',
      },
      filesystem: {
        enabled: true,
        allowedPaths: [homedir()],
        blockedPaths: [
          join(homedir(), '.ssh'),
          join(homedir(), '.gnupg'),
          join(homedir(), '.aws'),
          '/etc/passwd',
          '/etc/shadow',
          '/dev',
          '/proc',
          '/sys',
        ],
      },
    },
    fetchProxy: {
      enabled: true,
      allowedPatterns: ['*'],
      blockedPatterns: [
        // Local/private hostnames
        '*.local',
        '*.internal',
        'localhost',
        // Link-local
        '169.254.*',
        // Private IPv4 ranges (RFC 1918)
        '10.*',
        '192.168.*',
        '172.16.*',
        '172.17.*',
        '172.18.*',
        '172.19.*',
        '172.20.*',
        '172.21.*',
        '172.22.*',
        '172.23.*',
        '172.24.*',
        '172.25.*',
        '172.26.*',
        '172.27.*',
        '172.28.*',
        '172.29.*',
        '172.30.*',
        '172.31.*',
        // Loopback
        '127.*',
        // IPv6 local addresses
        '::1',
        'fc00::*',
        'fd00::*',
        'fe80::*',
      ],
    },
    sandboxPath: join(homedir(), '.flo-monster', 'sandbox'),
    agentStorePath: join(homedir(), '.flo-monster', 'agents'),
    adminPort: 8766,
    failedAuthConfig: {
      maxAttempts: 5,
      lockoutMinutes: 15,
    },
  };
}

/**
 * Validate a configuration object
 */
export function validateConfig(config: unknown): config is HubConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Required fields
  if (typeof c.port !== 'number' || c.port < 1 || c.port > 65535) {
    return false;
  }
  if (typeof c.host !== 'string' || c.host.length === 0) {
    return false;
  }
  if (typeof c.name !== 'string' || c.name.length === 0) {
    return false;
  }
  if (typeof c.localhostBypassAuth !== 'boolean') {
    return false;
  }

  // Optional authToken
  if (c.authToken !== undefined && typeof c.authToken !== 'string') {
    return false;
  }

  // Tools config
  if (typeof c.tools !== 'object' || c.tools === null) {
    return false;
  }
  const tools = c.tools as Record<string, unknown>;

  // Bash tool config
  if (typeof tools.bash !== 'object' || tools.bash === null) {
    return false;
  }
  const bash = tools.bash as Record<string, unknown>;
  if (typeof bash.enabled !== 'boolean') {
    return false;
  }
  // Optional bash mode
  if (bash.mode !== undefined && bash.mode !== 'restricted' && bash.mode !== 'unrestricted') {
    return false;
  }
  // Optional runAsUser
  if (bash.runAsUser !== undefined) {
    if (typeof bash.runAsUser !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(bash.runAsUser)) {
      return false;
    }
  }

  // Filesystem tool config
  if (typeof tools.filesystem !== 'object' || tools.filesystem === null) {
    return false;
  }
  const filesystem = tools.filesystem as Record<string, unknown>;
  if (typeof filesystem.enabled !== 'boolean') {
    return false;
  }
  if (!Array.isArray(filesystem.allowedPaths)) {
    return false;
  }

  // Fetch proxy config
  if (typeof c.fetchProxy !== 'object' || c.fetchProxy === null) {
    return false;
  }
  const fetchProxy = c.fetchProxy as Record<string, unknown>;
  if (typeof fetchProxy.enabled !== 'boolean') {
    return false;
  }
  if (!Array.isArray(fetchProxy.allowedPatterns)) {
    return false;
  }
  if (!Array.isArray(fetchProxy.blockedPatterns)) {
    return false;
  }

  // Optional TLS config
  if (c.tls !== undefined) {
    if (typeof c.tls !== 'object' || c.tls === null) {
      return false;
    }
    const tls = c.tls as Record<string, unknown>;
    if (typeof tls.certFile !== 'string' || tls.certFile.length === 0) {
      return false;
    }
    if (typeof tls.keyFile !== 'string' || tls.keyFile.length === 0) {
      return false;
    }
  }

  // Optional sandboxPath
  if (c.sandboxPath !== undefined && typeof c.sandboxPath !== 'string') {
    return false;
  }

  // Optional agentStorePath
  if (c.agentStorePath !== undefined && typeof c.agentStorePath !== 'string') {
    return false;
  }

  // Required adminPort
  if (typeof c.adminPort !== 'number' || c.adminPort < 1 || c.adminPort > 65535) {
    return false;
  }

  // Optional adminToken
  if (c.adminToken !== undefined && typeof c.adminToken !== 'string') {
    return false;
  }

  // Optional hooks - validation is lenient (invalid rules are just skipped with warnings)
  // We only reject if hooks is present but not an object
  if (c.hooks !== undefined) {
    if (typeof c.hooks !== 'object' || c.hooks === null || Array.isArray(c.hooks)) {
      return false;
    }
  }

  // Optional sharedApiKeys
  if (c.sharedApiKeys !== undefined) {
    if (typeof c.sharedApiKeys !== 'object' || c.sharedApiKeys === null || Array.isArray(c.sharedApiKeys)) {
      return false;
    }
    const keys = c.sharedApiKeys as Record<string, unknown>;
    // Validate all values are strings (or undefined)
    for (const [, value] of Object.entries(keys)) {
      if (value !== undefined && typeof value !== 'string') {
        return false;
      }
    }
  }

  // Optional providers config
  if (c.providers !== undefined) {
    if (typeof c.providers !== 'object' || c.providers === null || Array.isArray(c.providers)) {
      return false;
    }
    const providers = c.providers as Record<string, unknown>;
    for (const [, providerConfig] of Object.entries(providers)) {
      if (typeof providerConfig !== 'object' || providerConfig === null || Array.isArray(providerConfig)) {
        return false;
      }
      const pc = providerConfig as Record<string, unknown>;
      if (typeof pc.endpoint !== 'string' || pc.endpoint.length === 0) {
        return false;
      }
      if (pc.apiKey !== undefined && typeof pc.apiKey !== 'string') {
        return false;
      }
    }
  }

  // Optional cliProviders
  if (c.cliProviders !== undefined) {
    if (typeof c.cliProviders !== 'object' || c.cliProviders === null || Array.isArray(c.cliProviders)) {
      return false;
    }
    const cliProviders = c.cliProviders as Record<string, unknown>;
    for (const [, providerConfig] of Object.entries(cliProviders)) {
      if (typeof providerConfig !== 'object' || providerConfig === null || Array.isArray(providerConfig)) {
        return false;
      }
      const pc = providerConfig as Record<string, unknown>;
      if (pc.command !== undefined && typeof pc.command !== 'string') {
        return false;
      }
      if (pc.args !== undefined && !Array.isArray(pc.args)) {
        return false;
      }
      if (pc.timeout !== undefined && (typeof pc.timeout !== 'number' || pc.timeout <= 0)) {
        return false;
      }
    }
  }

  // Optional failedAuthConfig
  if (c.failedAuthConfig !== undefined) {
    if (typeof c.failedAuthConfig !== 'object' || c.failedAuthConfig === null || Array.isArray(c.failedAuthConfig)) {
      return false;
    }
    const authConfig = c.failedAuthConfig as Record<string, unknown>;
    if (typeof authConfig.maxAttempts !== 'number' || authConfig.maxAttempts < 1) {
      return false;
    }
    if (typeof authConfig.lockoutMinutes !== 'number' || authConfig.lockoutMinutes < 1) {
      return false;
    }
  }

  return true;
}

/**
 * Load configuration from file, falling back to defaults
 */
export async function loadConfig(configPath?: string): Promise<HubConfig> {
  const path = configPath ?? getConfigPath();
  const defaults = getDefaultConfig();

  try {
    const content = await readFile(path, 'utf-8');
    const loaded = JSON.parse(content) as unknown;

    // Merge with defaults to ensure all fields are present
    const loadedObj = loaded as Record<string, unknown>;
    const merged = {
      ...defaults,
      ...loadedObj,
      tools: {
        ...defaults.tools,
        ...(loadedObj.tools as Record<string, unknown> || {}),
        bash: {
          ...defaults.tools.bash,
          ...((loadedObj.tools as Record<string, unknown>)?.bash as Record<string, unknown> || {}),
        },
        filesystem: {
          ...defaults.tools.filesystem,
          ...((loadedObj.tools as Record<string, unknown>)?.filesystem as Record<string, unknown> || {}),
        },
      },
      fetchProxy: {
        ...defaults.fetchProxy,
        ...(loadedObj.fetchProxy as Record<string, unknown> || {}),
      },
    };

    if (!validateConfig(merged)) {
      console.warn('Invalid configuration, using defaults');
      return defaults;
    }

    // Process hooks separately - validateAndProcessHooks logs warnings for invalid rules
    // and returns a cleaned config with only valid rules
    const validatedHooks = validateAndProcessHooks(loadedObj.hooks);
    if (validatedHooks !== undefined) {
      merged.hooks = validatedHooks;
    }

    // Merge providers config from loaded file
    if (loadedObj.providers && typeof loadedObj.providers === 'object' && !Array.isArray(loadedObj.providers)) {
      merged.providers = loadedObj.providers as HubConfig['providers'];
    }

    // Merge cliProviders config from loaded file
    if (loadedObj.cliProviders && typeof loadedObj.cliProviders === 'object' && !Array.isArray(loadedObj.cliProviders)) {
      merged.cliProviders = loadedObj.cliProviders as HubConfig['cliProviders'];
    }

    return merged;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, return defaults
      return defaults;
    }
    console.warn('Error loading configuration:', error);
    return defaults;
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: HubConfig, configPath?: string): Promise<void> {
  const path = configPath ?? getConfigPath();

  // Ensure directory exists
  await mkdir(dirname(path), { recursive: true });

  // Write config
  await writeFile(path, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
}
