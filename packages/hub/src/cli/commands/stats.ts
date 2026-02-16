/**
 * Stats command - show server statistics
 */

import { createAdminClient } from '../client.js';
import { output, formatDuration } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

export async function statsCommand(options: CommandOptions, _args: string[]): Promise<void> {
  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    const response = await client.request({ type: 'get_stats' }, 'stats');

    if (options.json) {
      output(response, null, { json: true });
    } else {
      console.log('Hub Server Statistics');
      console.log('─'.repeat(30));
      console.log(`Uptime:           ${formatDuration(response.uptime)}`);
      console.log(`Connections:      ${response.connections}`);
      console.log(`Active Agents:    ${response.agents}`);
      console.log(`Total Requests:   ${response.totalRequests.toLocaleString()}`);
    }
  } finally {
    client.close();
  }
}
