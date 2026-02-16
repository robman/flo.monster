/**
 * CLI proxy for routing API requests through Claude Code CLI
 * Instead of proxying to api.anthropic.com, spawns `claude -p` and translates
 * the streaming output back to Anthropic SSE format.
 *
 * Key feature: parses <tool_call> XML from CLI text responses and converts
 * them to proper Anthropic tool_use content blocks, so the browser's agentic
 * loop can execute tools transparently.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerResponse } from 'node:http';

export interface CliProxyConfig {
  command?: string;     // Default: 'claude'
  args?: string[];      // Extra CLI args
  timeout?: number;     // Max response time in ms (default: 120000)
}

export interface CliProxyRequest {
  system?: string;           // System prompt
  messages: Message[];       // Conversation history
  model?: string;            // Model hint (ignored — Claude Code picks)
  max_tokens?: number;       // Token limit
  stream?: boolean;          // Always true in our case
}

interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  [key: string]: unknown;
}

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Counter for generating unique tool_use IDs within a session
let toolUseCounter = 0;

function generateToolUseId(): string {
  return `toolu_cli_${++toolUseCounter}_${Date.now().toString(36)}`;
}

/**
 * Parse <tool_call> XML blocks from text content.
 * Returns the text parts (without tool calls) and the extracted tool calls.
 */
export function parseToolCalls(text: string): { textParts: string[]; toolCalls: ParsedToolCall[] } {
  const toolCalls: ParsedToolCall[] = [];
  const textParts: string[] = [];

  // First, strip <tool_result> blocks — the LLM generates fake results
  // when it doesn't have real tools. These shouldn't appear in output.
  const stripped = text.replace(/<tool_result>\s*[\s\S]*?\s*<\/tool_result>/g, '');

  // Split on <tool_call>...</tool_call> blocks
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(stripped)) !== null) {
    // Text before this tool call
    const before = stripped.slice(lastIndex, match.index);
    if (before.trim()) {
      textParts.push(before.trim());
    }
    lastIndex = regex.lastIndex;

    // Parse the JSON inside <tool_call>
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push({
        name: parsed.name || 'unknown',
        arguments: parsed.arguments || {},
      });
    } catch {
      // If JSON parse fails, treat as text
      textParts.push(match[0]);
    }
  }

  // Remaining text after last tool call — only include if there were
  // NO tool calls. When tool calls are present, trailing text is the LLM
  // simulating a response after fake tool results. The browser will execute
  // real tools and get a real continuation in the next turn.
  const remaining = stripped.slice(lastIndex);
  if (remaining.trim() && toolCalls.length === 0) {
    textParts.push(remaining.trim());
  }

  return { textParts, toolCalls };
}

/**
 * Format messages array into a text prompt for claude -p stdin.
 * Converts the multi-turn conversation into a readable transcript.
 * Uses <tool_call>/<tool_result> XML format so the LLM sees consistent formatting.
 */
export function formatMessagesAsPrompt(messages: Message[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = formatContent(msg.content);
    parts.push(`${role}: ${content}`);
  }

  return parts.join('\n\n');
}

/**
 * Format message content (string or content blocks) to text.
 * Uses XML format for tool_use/tool_result to match what the LLM generates.
 */
function formatContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      // Format as XML to match the LLM's own output format
      parts.push(`<tool_call>\n${JSON.stringify({ name: block.name, arguments: block.input })}\n</tool_call>`);
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map(b => b.text || '').join('')
          : '';
      parts.push(`<tool_result>\n${resultContent}\n</tool_result>`);
    } else {
      // Unknown block type — include as JSON
      parts.push(JSON.stringify(block));
    }
  }

  return parts.join('\n');
}

/**
 * Transform a complete message by parsing <tool_call> XML from text content
 * and converting to proper Anthropic tool_use content blocks.
 */
export function transformMessageContent(message: Record<string, unknown>): Record<string, unknown> {
  const content = (message.content || []) as Array<Record<string, unknown>>;
  const newContent: Array<Record<string, unknown>> = [];
  let hasToolUse = false;

  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const { textParts, toolCalls } = parseToolCalls(block.text as string);

      // Add any text before/between/after tool calls
      for (const text of textParts) {
        newContent.push({ type: 'text', text });
      }

      // Add tool_use blocks for each parsed tool call
      for (const tc of toolCalls) {
        hasToolUse = true;
        newContent.push({
          type: 'tool_use',
          id: generateToolUseId(),
          name: tc.name,
          input: tc.arguments,
        });
      }
    } else {
      // Pass through non-text blocks (tool_use, etc.)
      newContent.push(block);
      if (block.type === 'tool_use') hasToolUse = true;
    }
  }

  return {
    ...message,
    content: newContent,
    // Override stop_reason if tool calls were found
    stop_reason: hasToolUse ? 'tool_use' : (message.stop_reason || 'end_turn'),
  };
}

/**
 * Synthesize Anthropic SSE events from a complete message object.
 * Parses <tool_call> XML from text content and converts to proper tool_use blocks.
 */
export function synthesizeSSEFromMessage(message: Record<string, unknown>): Record<string, unknown>[] {
  // Transform: parse <tool_call> XML from text into proper tool_use blocks
  const transformed = transformMessageContent(message);
  const events: Record<string, unknown>[] = [];
  const content = (transformed.content || []) as Array<Record<string, unknown>>;

  // message_start — send the message shell without content
  events.push({
    type: 'message_start',
    message: {
      ...transformed,
      content: [],
    },
  });

  // Emit content blocks
  for (let i = 0; i < content.length; i++) {
    const block = content[i];

    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: block.text },
      });
      events.push({
        type: 'content_block_stop',
        index: i,
      });
    } else if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index: i,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      events.push({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
      events.push({
        type: 'content_block_stop',
        index: i,
      });
    }
  }

  // message_delta with stop_reason (may have been updated by transformMessageContent)
  events.push({
    type: 'message_delta',
    delta: {
      stop_reason: transformed.stop_reason || 'end_turn',
      stop_sequence: transformed.stop_sequence || null,
    },
    usage: (transformed.usage as Record<string, unknown>) || {},
  });

  // message_stop
  events.push({ type: 'message_stop' });

  return events;
}

/**
 * Parse a line of stream-json output from Claude Code.
 * Returns an array of SSE event objects to emit, or empty array if none.
 *
 * Claude Code stream-json produces:
 *   {"type":"system",...}     — init info, skip
 *   {"type":"assistant","message":{...}} — the response, parse tool calls + synthesize SSE
 *   {"type":"result",...}     — summary, skip
 */
export function parseStreamLine(line: string): Record<string, unknown>[] {
  if (!line.trim()) return [];

  try {
    const parsed = JSON.parse(line);

    // Assistant message — parse tool calls and synthesize SSE events
    if (parsed.type === 'assistant' && parsed.message) {
      return synthesizeSSEFromMessage(parsed.message as Record<string, unknown>);
    }

    // Log errors from CLI
    if (parsed.type === 'error') {
      console.error('[cli-proxy] CLI error:', parsed.error || parsed.message || line);
    }

    return [];
  } catch {
    // Non-JSON line — ignore
    return [];
  }
}

/**
 * Format an Anthropic event as an SSE string
 */
export function formatSSE(event: Record<string, unknown>): string {
  const eventType = event.type as string;
  return `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build the CLI arguments for claude -p
 */
export function buildCliArgs(req: CliProxyRequest, config: CliProxyConfig): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];

  // Disable all built-in tools so it acts as pure LLM proxy
  args.push('--tools', '');

  // System prompt
  if (req.system) {
    args.push('--system-prompt', req.system);
  }

  // Max tokens
  if (req.max_tokens) {
    args.push('--max-turns', '1');
  }

  // Extra args from config
  if (config.args) {
    args.push(...config.args);
  }

  return args;
}

/**
 * Main handler — spawns Claude CLI, buffers response, parses tool calls,
 * and sends proper Anthropic SSE events to the browser.
 *
 * Buffers the complete response (no incremental streaming) because we need
 * to parse <tool_call> XML from text content before sending events.
 */
export async function handleCliProxy(
  req: CliProxyRequest,
  res: ServerResponse,
  config: CliProxyConfig,
): Promise<void> {
  const command = config.command || 'claude';
  const timeout = config.timeout || 120000;
  const args = buildCliArgs(req, config);
  const prompt = formatMessagesAsPrompt(req.messages);

  return new Promise<void>((resolve, reject) => {
    let proc: ChildProcess;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      // Command not found or spawn error
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Failed to spawn CLI: ${(err as Error).message}` }));
      finish();
      return;
    }

    // Timeout
    timeoutHandle = setTimeout(() => {
      console.error('[cli-proxy] Process timed out, killing');
      proc.kill('SIGKILL');
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CLI proxy timeout' }));
      }
      finish();
    }, timeout);

    // Write prompt to stdin then close
    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    // Set up SSE response headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-api-provider, anthropic-version, Authorization',
    });

    // Collect all stdout for processing on close
    let stdoutBuffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
    });

    // Log stderr
    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
    });

    // Handle process exit — parse and emit all events
    proc.on('close', (code) => {
      const lines = stdoutBuffer.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const events = parseStreamLine(line);
        for (const event of events) {
          res.write(formatSSE(event));
        }
      }

      if (code !== 0 && stderrOutput) {
        console.error(`[cli-proxy] Process exited with code ${code}: ${stderrOutput.slice(0, 500)}`);
      }

      res.end();
      finish();
    });

    proc.on('error', (err) => {
      console.error('[cli-proxy] Process error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `CLI proxy error: ${err.message}` }));
      } else {
        res.end();
      }
      finish();
    });
  });
}
