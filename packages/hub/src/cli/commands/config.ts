/**
 * Config command - configuration management
 */

import { createAdminClient } from '../client.js';
import { output, success, error, warn } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

export async function configCommand(options: CommandOptions, args: string[]): Promise<void> {
  const subcommand = args[0] || 'show';

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    switch (subcommand) {
      case 'show': {
        const response = await client.request({ type: 'get_config' }, 'config');
        output(response.config, null, { json: options.json });
        break;
      }

      case 'reload': {
        await client.send({ type: 'reload_config' });
        const response = await client.waitForMessage('config_reloaded');
        if (response.success) {
          success('Configuration reloaded');
        } else {
          warn(response.error || 'Failed to reload configuration');
        }
        break;
      }

      default:
        error(`Unknown subcommand: ${subcommand}`);
        console.log('Available: show, reload');
        process.exit(1);
    }
  } finally {
    client.close();
  }
}
