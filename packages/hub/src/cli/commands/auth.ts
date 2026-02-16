/**
 * Auth command - authentication management
 */

import { createAdminClient } from '../client.js';
import { error, warn } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

export async function authCommand(options: CommandOptions, args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand) {
    error('Usage: hub-admin auth <show-token|rotate-token>');
    process.exit(1);
  }

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    switch (subcommand) {
      case 'show-token': {
        const response = await client.request({ type: 'show_token' }, 'token');
        if (options.json) {
          console.log(JSON.stringify({ token: response.token }));
        } else {
          console.log(response.token);
        }
        break;
      }

      case 'rotate-token': {
        await client.send({ type: 'rotate_token' });
        try {
          const response = await client.waitForMessage('token_rotated');
          if (options.json) {
            console.log(JSON.stringify({ newToken: response.newToken }));
          } else {
            console.log(`New token: ${response.newToken}`);
          }
        } catch {
          // Check for error response
          warn('Token rotation is not supported at runtime. Update config file and restart.');
        }
        break;
      }

      default:
        error(`Unknown subcommand: ${subcommand}`);
        console.log('Available: show-token, rotate-token');
        process.exit(1);
    }
  } finally {
    client.close();
  }
}
