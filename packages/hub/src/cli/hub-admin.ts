#!/usr/bin/env node
/**
 * Hub Admin CLI
 *
 * Command-line interface for managing the hub server
 */

import { agentsCommand } from './commands/agents.js';
import { connectionsCommand } from './commands/connections.js';
import { configCommand } from './commands/config.js';
import { authCommand } from './commands/auth.js';
import { logsCommand } from './commands/logs.js';
import { statsCommand } from './commands/stats.js';
import { usageCommand } from './commands/usage.js';
import { nukeCommand } from './commands/nuke.js';
import { error } from './output.js';
import { loadConfig } from '../config.js';

interface GlobalOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

function parseGlobalOptions(
  args: string[],
  defaults: { host: string; port: number; token?: string },
): { options: GlobalOptions; args: string[] } {
  const options: GlobalOptions = {
    host: defaults.host,
    port: defaults.port,
    token: defaults.token,
    json: false,
  };

  const remaining: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--host' || arg === '-H') {
      options.host = args[++i];
    } else if (arg === '--port' || arg === '-p') {
      options.port = parseInt(args[++i], 10);
    } else if (arg === '--token' || arg === '-t') {
      options.token = args[++i];
    } else if (arg === '--json') {
      options.json = true;
    } else if (!arg.startsWith('-')) {
      remaining.push(arg);
    } else {
      remaining.push(arg);
    }
    i++;
  }

  // Check for token in environment (overrides config file)
  if (process.env.FLO_ADMIN_TOKEN) {
    options.token = process.env.FLO_ADMIN_TOKEN;
  }

  return { options, args: remaining };
}

function showHelp(): void {
  console.log(`
flo-admin - Hub server administration CLI

Usage:
  flo-admin [global options] <command> [subcommand] [options]

Global Options:
  --host, -H <host>   Admin server host (from config or 127.0.0.1)
  --port, -p <port>   Admin server port (from config or 8766)
  --token, -t <token> Admin authentication token (from config)
  --json              Output in JSON format

  Defaults are read from ~/.flo-monster/hub.json

Commands:
  agents              Manage agents
    list              List all agents
    inspect <id>      Show agent details (with schedules + recent messages)
    schedules [id]    Show schedules (all or per-agent)
    log <id>          Show conversation history (--limit N, default 20)
    dom <id>          Show agent DOM state (HTML + attrs)
    pause <id>        Pause an agent
    stop <id>         Stop an agent gracefully
    kill <id>         Force kill an agent

  connections         Manage client connections
    list              List all connections
    disconnect <id>   Disconnect a client

  config              Configuration management
    show              Show current configuration
    reload            Reload configuration (if supported)

  auth                Authentication management
    show-token        Show the current auth token
    rotate-token      Rotate the auth token (if supported)

  logs                View hub logs
    [--follow]        Follow log output in real-time

  stats               Show server statistics

  usage               Show usage statistics
    [--scope <s>]     Scope: agent, connection, provider, global

  nuke                Emergency operations
    --agents          Kill all agents
    --clients         Disconnect all clients
    --all             Kill agents and disconnect clients
    --confirm         Required for destructive operations

  setup               Set up OS user isolation (requires sudo)
    [--user <name>]   Custom username (default: flo-agent)

Environment:
  FLO_ADMIN_TOKEN     Admin authentication token

Examples:
  flo-admin agents list
  flo-admin agents list --json
  flo-admin agents kill agent-123
  flo-admin agents remove agent-123
  flo-admin logs --follow
  flo-admin nuke --all --confirm
`);
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === 'help') {
    showHelp();
    return;
  }

  // 'setup' is a local command — doesn't need admin WebSocket
  if (rawArgs[0] === 'setup') {
    const { setupCommand } = await import('./commands/setup.js');
    await setupCommand(rawArgs.slice(1));
    return;
  }

  // Load config to get defaults (host, adminPort, adminToken)
  const config = await loadConfig();
  const defaults = {
    host: config.host,
    port: config.adminPort,
    token: config.adminToken,
  };

  const { options, args } = parseGlobalOptions(rawArgs, defaults);

  if (args.length === 0) {
    showHelp();
    return;
  }

  const command = args[0];
  const subArgs = args.slice(1);

  try {
    switch (command) {
      case 'agents':
        await agentsCommand(options, subArgs);
        break;

      case 'connections':
        await connectionsCommand(options, subArgs);
        break;

      case 'config':
        await configCommand(options, subArgs);
        break;

      case 'auth':
        await authCommand(options, subArgs);
        break;

      case 'logs':
        await logsCommand(options, subArgs);
        break;

      case 'stats':
        await statsCommand(options, subArgs);
        break;

      case 'usage':
        await usageCommand(options, subArgs);
        break;

      case 'nuke':
        await nukeCommand(options, subArgs);
        break;

      default:
        error(`Unknown command: ${command}`);
        console.log('Run "flo-admin --help" for usage information.');
        process.exit(1);
    }
  } catch (err) {
    error((err as Error).message);
    process.exit(1);
  }
}

main().catch((err) => {
  error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
