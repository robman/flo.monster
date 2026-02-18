/**
 * Agents command - manage hub agents
 */

import { createAdminClient, AdminClientError } from '../client.js';
import { output, formatTable, formatTimestamp, formatCost, truncate, error, success } from '../output.js';
import type { AdminAgentInfo, AdminScheduleInfo } from '@flo-monster/core';

interface CommandOptions {
  host: string;
  port: number;
  token?: string;
  json: boolean;
}

const agentColumns = [
  { header: 'ID', key: 'id', width: 60 },
  { header: 'Name', key: 'name', width: 20 },
  { header: 'State', key: 'state', width: 10 },
  { header: 'Model', key: 'model', width: 20 },
  { header: 'Messages', key: 'messageCount', align: 'right' as const },
  { header: 'Tokens', key: 'totalTokens', align: 'right' as const },
  { header: 'Cost', key: 'totalCost', align: 'right' as const, format: formatCost },
];

const scheduleColumns = [
  { header: 'ID', key: 'id', width: 12 },
  { header: 'Agent', key: 'hubAgentId', width: 24 },
  { header: 'Type', key: 'type', width: 6 },
  { header: 'Expression/Event', key: '_trigger', width: 20 },
  { header: 'Message', key: '_message', width: 20 },
  { header: 'Runs', key: 'runCount', align: 'right' as const },
  { header: 'Enabled', key: 'enabled' },
  { header: 'Last Run', key: '_lastRun', width: 20 },
];

function formatScheduleRows(schedules: AdminScheduleInfo[]): Record<string, unknown>[] {
  return schedules.map(s => ({
    ...s,
    _trigger: s.type === 'cron' ? s.cronExpression : `${s.eventName}${s.eventCondition ? ' ' + s.eventCondition : ''}`,
    _message: s.tool ? `[tool: ${s.tool}]` : truncate(s.message || '', 20),
    _lastRun: s.lastRunAt ? formatTimestamp(s.lastRunAt) : '-',
    enabled: s.enabled ? 'yes' : 'no',
  }));
}

export async function agentsCommand(options: CommandOptions, args: string[]): Promise<void> {
  const subcommand = args[0] || 'list';
  const agentId = args[1];

  // Parse --limit from remaining args
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
    }
  }

  const client = await createAdminClient({
    host: options.host,
    port: options.port,
    token: options.token,
  });

  try {
    switch (subcommand) {
      case 'list': {
        const response = await client.request({ type: 'list_agents' }, 'agents_list');
        if (options.json) {
          output(response.agents, null, { json: true });
        } else if (response.agents.length === 0) {
          console.log('No agents found');
        } else {
          console.log(formatTable(agentColumns, response.agents));
        }
        break;
      }

      case 'inspect': {
        if (!agentId) {
          error('Usage: hub-admin agents inspect <agent-id>');
          process.exit(1);
        }
        const response = await client.request(
          { type: 'inspect_agent', agentId },
          'agent_info',
        );
        if (!response.agent) {
          error(`Agent not found: ${agentId}`);
          process.exit(1);
        }
        if (options.json) {
          // Include schedules and recent messages in JSON output
          const schedResp = await client.request(
            { type: 'get_agent_schedules', agentId },
            'agent_schedules',
          );
          const logResp = await client.request(
            { type: 'get_agent_log', agentId, limit: 5 },
            'agent_log',
          );
          output({
            ...response.agent,
            schedules: schedResp.schedules,
            recentMessages: logResp.messages,
          }, null, { json: true });
        } else {
          const agent = response.agent;
          console.log('Agent Details');
          console.log('─'.repeat(60));
          console.log(`ID:           ${agent.id}`);
          console.log(`Name:         ${agent.name}`);
          console.log(`State:        ${agent.state}${agent.busy ? ' (busy)' : ''}`);
          console.log(`Model:        ${agent.model || '-'}`);
          console.log(`Provider:     ${agent.provider || '-'}`);
          console.log(`Created:      ${formatTimestamp(agent.createdAt)}`);
          if (agent.lastActivity) {
            console.log(`Last active:  ${formatTimestamp(agent.lastActivity)}`);
          }
          console.log(`Messages:     ${agent.messageCount}`);
          console.log(`Tokens:       ${agent.totalTokens.toLocaleString()}`);
          console.log(`Cost:         ${formatCost(agent.totalCost)}`);

          // Fetch and display schedules
          try {
            const schedResp = await client.request(
              { type: 'get_agent_schedules', agentId },
              'agent_schedules',
            );
            if (schedResp.schedules.length > 0) {
              console.log('');
              console.log('Schedules');
              console.log('─'.repeat(60));
              for (const s of schedResp.schedules) {
                const trigger = s.type === 'cron' ? s.cronExpression : `${s.eventName}${s.eventCondition ? ' ' + s.eventCondition : ''}`;
                const status = s.enabled ? 'enabled' : 'disabled';
                const desc = s.tool ? `[tool: ${s.tool}]` : `"${truncate(s.message || '', 30)}"`;
                console.log(`  ${s.id}  ${s.type}  ${trigger}  ${desc}  runs:${s.runCount}  ${status}`);
              }
            }
          } catch {
            // Schedules not available — skip
          }

          // Fetch and display recent messages
          try {
            const logResp = await client.request(
              { type: 'get_agent_log', agentId, limit: 5 },
              'agent_log',
            );
            if (logResp.messages.length > 0) {
              console.log('');
              console.log('Recent Messages');
              console.log('─'.repeat(60));
              for (const msg of logResp.messages) {
                const ts = formatTimestamp(msg.timestamp);
                const text = msg.content
                  .filter(b => b.type === 'text')
                  .map(b => (b as { type: 'text'; text: string }).text)
                  .join('') || (msg.role === 'assistant' ? '[tool calls]' : '[tool results]');
                console.log(`  [${ts}] ${msg.role}: ${truncate(text.replace(/\n/g, ' '), 80)}`);
              }
            }
          } catch {
            // Log not available — skip
          }
        }
        break;
      }

      case 'schedules': {
        const response = await client.request(
          { type: 'get_agent_schedules', agentId: agentId || undefined },
          'agent_schedules',
        );
        if (options.json) {
          output(response.schedules, null, { json: true });
        } else if (response.schedules.length === 0) {
          console.log(agentId ? `No schedules for agent ${agentId}` : 'No schedules found');
        } else {
          console.log(formatTable(scheduleColumns, formatScheduleRows(response.schedules)));
        }
        break;
      }

      case 'log': {
        if (!agentId) {
          error('Usage: hub-admin agents log <agent-id> [--limit N]');
          process.exit(1);
        }
        const logLimit = limit !== undefined ? limit : 20;
        const response = await client.request(
          { type: 'get_agent_log', agentId, limit: logLimit },
          'agent_log',
        );
        if (options.json) {
          output(response.messages, null, { json: true });
        } else if (response.messages.length === 0) {
          console.log('No messages found');
        } else {
          for (const msg of response.messages) {
            const ts = formatTimestamp(msg.timestamp);
            console.log(`[${ts}] ${msg.role}:`);
            for (const block of msg.content) {
              if (block.type === 'text') {
                for (const line of block.text.split('\n')) {
                  console.log(`  ${line}`);
                }
              } else if (block.type === 'tool_use') {
                console.log(`  [tool call] ${block.name}(${JSON.stringify(block.input)})`);
              } else if (block.type === 'tool_result') {
                const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                const prefix = block.is_error ? '[tool error]' : '[tool result]';
                console.log(`  ${prefix} ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
              }
            }
            console.log('');
          }
        }
        break;
      }

      case 'dom': {
        if (!agentId) {
          error('Usage: hub-admin agents dom <agent-id>');
          process.exit(1);
        }
        const response = await client.request(
          { type: 'get_agent_dom', agentId },
          'agent_dom',
        );
        if (!response.domState) {
          console.log('No DOM state available for this agent');
        } else if (options.json) {
          output(response.domState, null, { json: true });
        } else {
          console.log('DOM State');
          console.log('\u2500'.repeat(80));
          console.log(`Captured: ${new Date(response.domState.capturedAt).toISOString()}`);
          if (response.domState.htmlAttrs && Object.keys(response.domState.htmlAttrs).length > 0) {
            console.log(`HTML attrs: ${JSON.stringify(response.domState.htmlAttrs)}`);
          }
          if (response.domState.bodyAttrs && Object.keys(response.domState.bodyAttrs).length > 0) {
            console.log(`Body attrs: ${JSON.stringify(response.domState.bodyAttrs)}`);
          }
          if (response.domState.headHtml) {
            console.log('');
            console.log('Head:');
            console.log(response.domState.headHtml);
          }
          console.log('');
          console.log('Body:');
          console.log(response.domState.viewportHtml || '(empty)');
        }
        break;
      }

      case 'runjs-log': {
        if (!agentId) {
          error('Usage: hub-admin agents runjs-log <agent-id> [--limit N]');
          process.exit(1);
        }
        const rjsLimit = limit !== undefined ? limit : 20;
        const rjsResponse = await client.request(
          { type: 'get_agent_runjs_log', agentId, limit: rjsLimit },
          'agent_runjs_log',
        );
        if (options.json) {
          output(rjsResponse.entries, null, { json: true });
        } else if (rjsResponse.entries.length === 0) {
          console.log('No runjs executions logged for this agent');
        } else {
          for (const entry of rjsResponse.entries) {
            const ts = formatTimestamp(entry.ts);
            const status = entry.error ? '\x1b[31mERROR\x1b[0m' : '\x1b[32mOK\x1b[0m';
            const duration = `${entry.durationMs}ms`;
            console.log(`[${ts}] ${status} (${duration})`);
            console.log(`  Code: ${entry.code}`);
            if (entry.consoleOutput && entry.consoleOutput.length > 0) {
              console.log(`  Console: ${entry.consoleOutput.join(' | ')}`);
            }
            if (entry.error) {
              console.log(`  Error: ${truncate(entry.error, 200)}`);
            } else if (entry.result) {
              const resultStr = typeof entry.result === 'string' ? entry.result : JSON.stringify(entry.result);
              console.log(`  Result: ${truncate(resultStr, 200)}`);
            }
            console.log('');
          }
        }
        break;
      }

      case 'pause': {
        if (!agentId) {
          error('Usage: hub-admin agents pause <agent-id>');
          process.exit(1);
        }
        await client.send({ type: 'pause_agent', agentId });
        const response = await client.waitForMessage('ok');
        success(response.message || `Agent ${agentId} paused`);
        break;
      }

      case 'stop': {
        if (!agentId) {
          error('Usage: hub-admin agents stop <agent-id>');
          process.exit(1);
        }
        await client.send({ type: 'stop_agent', agentId });
        const response = await client.waitForMessage('ok');
        success(response.message || `Agent ${agentId} stopped`);
        break;
      }

      case 'kill': {
        if (!agentId) {
          error('Usage: hub-admin agents kill <agent-id>');
          process.exit(1);
        }
        await client.send({ type: 'kill_agent', agentId });
        const response = await client.waitForMessage('ok');
        success(response.message || `Agent ${agentId} killed`);
        break;
      }

      case 'remove': {
        if (!agentId) {
          error('Usage: hub-admin agents remove <agent-id>');
          process.exit(1);
        }
        await client.send({ type: 'remove_agent', agentId });
        const response = await client.waitForMessage('ok');
        success(response.message || `Agent ${agentId} removed`);
        break;
      }

      default:
        error(`Unknown subcommand: ${subcommand}`);
        console.log('Available: list, inspect, schedules, log, dom, runjs-log, pause, stop, kill, remove');
        process.exit(1);
    }
  } finally {
    client.close();
  }
}
