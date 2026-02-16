/**
 * Logs command - view hub logs
 */

import { createAdminClient } from '../client.js';
import { formatTimestamp } from '../output.js';
import type { HubToAdmin } from '@flo-monster/core';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

function formatLogLevel(level: string): string {
  switch (level.toLowerCase()) {
    case 'error':
      return 'ERR';
    case 'warn':
    case 'warning':
      return 'WRN';
    case 'info':
      return 'INF';
    case 'debug':
      return 'DBG';
    default:
      return level.slice(0, 3).toUpperCase();
  }
}

export async function logsCommand(options: CommandOptions, args: string[]): Promise<void> {
  const follow = args.includes('--follow') || args.includes('-f');

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  // Subscribe to logs
  await client.send({ type: 'subscribe_logs', follow: true });

  // Handle log entries
  const unsubscribe = client.onMessage((msg: HubToAdmin) => {
    if (msg.type === 'log_entry') {
      const entry = msg as { timestamp: number; level: string; message: string; source?: string };
      if (options.json) {
        console.log(JSON.stringify(entry));
      } else {
        const time = new Date(entry.timestamp).toISOString().slice(11, 23);
        const level = formatLogLevel(entry.level);
        const source = entry.source ? `[${entry.source}] ` : '';
        console.log(`${time} ${level} ${source}${entry.message}`);
      }
    }
  });

  if (follow) {
    // Keep the process running for streaming
    console.log('Streaming logs... Press Ctrl+C to stop.');

    const cleanup = (): void => {
      unsubscribe();
      client.close();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Keep alive
    await new Promise(() => {});
  } else {
    // Just show recent logs and exit
    // Wait a moment for buffered logs to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));
    unsubscribe();
    client.close();
  }
}
