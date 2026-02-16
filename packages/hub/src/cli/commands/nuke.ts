/**
 * Nuke command - emergency operations
 */

import { createAdminClient } from '../client.js';
import { error, success, warn } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

type NukeTarget = 'agents' | 'clients' | 'all';

export async function nukeCommand(options: CommandOptions, args: string[]): Promise<void> {
  // Parse target
  let target: NukeTarget | undefined;
  if (args.includes('--agents')) {
    target = 'agents';
  } else if (args.includes('--clients')) {
    target = 'clients';
  } else if (args.includes('--all')) {
    target = 'all';
  }

  if (!target) {
    error('Usage: hub-admin nuke <--agents|--clients|--all> --confirm');
    console.log('\nOptions:');
    console.log('  --agents    Kill all running agents');
    console.log('  --clients   Disconnect all client connections');
    console.log('  --all       Kill agents and disconnect clients');
    console.log('  --confirm   Required to execute (safety check)');
    process.exit(1);
  }

  // Require --confirm for safety
  if (!args.includes('--confirm')) {
    warn(`This will ${describeNuke(target)}. Add --confirm to proceed.`);
    process.exit(1);
  }

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    await client.send({ type: 'nuke', target });
    const response = await client.waitForMessage('ok');

    if (options.json) {
      console.log(JSON.stringify({ success: true, message: response.message }));
    } else {
      success(response.message || `Nuke operation completed`);
    }
  } finally {
    client.close();
  }
}

function describeNuke(target: NukeTarget): string {
  switch (target) {
    case 'agents':
      return 'kill all running agents';
    case 'clients':
      return 'disconnect all client connections';
    case 'all':
      return 'kill all agents and disconnect all clients';
  }
}
