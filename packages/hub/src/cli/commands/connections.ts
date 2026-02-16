/**
 * Connections command - manage client connections
 */

import { createAdminClient } from '../client.js';
import { output, formatTable, error, success } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

const connectionColumns = [
  { header: 'ID', key: 'id', width: 15 },
  { header: 'Address', key: 'remoteAddress', width: 20 },
  { header: 'Auth', key: 'authenticated', width: 6 },
  { header: 'Subscribed Agents', key: 'subscribedAgents', width: 40 },
];

export async function connectionsCommand(options: CommandOptions, args: string[]): Promise<void> {
  const subcommand = args[0] || 'list';
  const connectionId = args[1];

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    switch (subcommand) {
      case 'list': {
        const response = await client.request({ type: 'list_connections' }, 'connections_list');
        if (options.json) {
          output(response.connections, null, { json: true });
        } else if (response.connections.length === 0) {
          console.log('No connections found');
        } else {
          console.log(formatTable(connectionColumns, response.connections));
        }
        break;
      }

      case 'disconnect': {
        if (!connectionId) {
          error('Usage: hub-admin connections disconnect <connection-id>');
          process.exit(1);
        }
        await client.send({ type: 'disconnect', connectionId });
        const response = await client.waitForMessage('ok');
        success(response.message || `Connection ${connectionId} disconnected`);
        break;
      }

      default:
        error(`Unknown subcommand: ${subcommand}`);
        console.log('Available: list, disconnect');
        process.exit(1);
    }
  } finally {
    client.close();
  }
}
