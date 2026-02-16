/**
 * Usage command - show usage statistics
 */

import { createAdminClient } from '../client.js';
import { output, formatTable, formatCost, error } from '../output.js';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

type UsageScope = 'agent' | 'connection' | 'provider' | 'global';

const usageColumns = [
  { header: 'ID', key: 'id', width: 40 },
  { header: 'Name', key: 'name', width: 20 },
  { header: 'Tokens', key: 'tokens', align: 'right' as const },
  { header: 'Cost', key: 'cost', align: 'right' as const, format: formatCost },
  { header: 'Requests', key: 'requests', align: 'right' as const },
];

function parseScope(args: string[]): UsageScope {
  const idx = args.indexOf('--scope');
  if (idx >= 0 && args[idx + 1]) {
    const scope = args[idx + 1] as UsageScope;
    if (['agent', 'connection', 'provider', 'global'].includes(scope)) {
      return scope;
    }
  }
  return 'global';
}

export async function usageCommand(options: CommandOptions, args: string[]): Promise<void> {
  const scope = parseScope(args);

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    const response = await client.request({ type: 'get_usage', scope }, 'usage');

    if (options.json) {
      output(response.data, null, { json: true });
    } else {
      console.log(`Usage Statistics (scope: ${response.data.scope})`);
      console.log('─'.repeat(50));

      if (response.data.entries.length === 0) {
        console.log('No usage data available');
      } else {
        console.log(formatTable(usageColumns, response.data.entries));

        // Show totals
        const totalTokens = response.data.entries.reduce((sum, e) => sum + e.tokens, 0);
        const totalCost = response.data.entries.reduce((sum, e) => sum + e.cost, 0);
        const totalRequests = response.data.entries.reduce((sum, e) => sum + e.requests, 0);

        console.log('─'.repeat(50));
        console.log(
          `Total: ${totalTokens.toLocaleString()} tokens, ${formatCost(totalCost)}, ${totalRequests} requests`,
        );
      }
    }
  } finally {
    client.close();
  }
}
