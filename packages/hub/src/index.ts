/**
 * flo.monster Hub Server
 *
 * A WebSocket server that provides secure access to local system tools
 * (bash, filesystem) for browser-based AI agents.
 */

// Export public APIs
export {
  type HubConfig,
  type HubToolsConfig,
  type FetchProxyConfig,
  type TlsConfig,
  loadConfig,
  saveConfig,
  getDefaultConfig,
  getConfigPath,
  validateConfig,
} from './config.js';

export {
  validateToken,
  isLocalhost,
  generateToken,
} from './auth.js';

export {
  createHubServer,
  type HubServer,
  type HubMessage,
  type ConnectedClient,
  type ToolCallMessage,
  type ToolResultMessage,
  type AuthMessage,
  type ErrorMessage,
} from './server.js';

export {
  getToolDefinitions,
  executeTool,
  bashToolDef,
  executeBash,
  filesystemToolDef,
  executeFilesystem,
  type ToolDef,
  type ToolResult,
  type ToolInput,
  type BashInput,
  type FilesystemInput,
} from './tools/index.js';

export {
  createAdminServer,
  type AdminServer,
  type AdminClient,
} from './admin/server.js';

export {
  SessionHandler,
  type SessionRestoreOptions,
  type SessionRestoreResult,
} from './session-handler.js';

export { HubSkillManager } from './skill-manager.js';

export { BrowserToolRouter } from './browser-tool-router.js';

export {
  HeadlessAgentRunner,
  type RunnerState,
  type RunnerEvent,
  type RunnerDeps,
} from './agent-runner.js';

// CLI entry point
import { loadConfig, saveConfig, getDefaultConfig, getConfigPath } from './config.js';
import { generateToken } from './auth.js';
import { createHubServer } from './server.js';
import { createAdminServer, type AdminServer } from './admin/server.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle CLI commands
  if (args[0] === 'init') {
    const configPath = getConfigPath();
    const config = getDefaultConfig();
    config.authToken = generateToken();
    await saveConfig(config, configPath);
    console.log(`Created default configuration at: ${configPath}`);
    console.log(`Auth token: ${config.authToken}`);
    return;
  }

  if (args[0] === 'token') {
    console.log(generateToken());
    return;
  }

  if (args[0] === '--help' || args[0] === '-h') {
    console.log(`
flo.monster Hub Server

Usage:
  flo-hub          Start the hub server
  flo-hub init     Create default configuration with auth token
  flo-hub token    Generate a new auth token
  flo-hub --help   Show this help message

Configuration:
  Configuration is loaded from ~/.flo-monster/hub.json
  Use 'hub init' to create a default configuration.
`);
    return;
  }

  // Load configuration
  const config = await loadConfig();
  const startTime = Date.now();

  // Start main hub server
  const server = createHubServer(config);

  // Start admin server
  let adminServer: AdminServer | undefined;
  try {
    adminServer = createAdminServer(config, server, startTime);
    console.log(`Admin server started on ws://${config.host}:${config.adminPort}`);
  } catch (err) {
    console.warn(`Failed to start admin server: ${err}`);
  }

  const protocol = config.tls ? 'wss' : 'ws';
  console.log(`Hub server started on ${protocol}://${config.host}:${config.port}`);
  console.log(`Name: ${config.name}`);
  console.log(`TLS: ${config.tls ? 'enabled' : 'disabled'}`);
  console.log(`Localhost auth bypass: ${config.localhostBypassAuth ? 'enabled' : 'disabled'}`);
  console.log(`Auth token: ${config.authToken ? 'configured' : 'not configured'}`);
  console.log(`Admin token: ${config.adminToken ? 'configured' : 'not configured (localhost bypass enabled)'}`);

  // Handle shutdown
  const shutdown = async (): Promise<void> => {
    console.log('\nShutting down...');
    if (adminServer) {
      await adminServer.close();
    }
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run CLI if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
