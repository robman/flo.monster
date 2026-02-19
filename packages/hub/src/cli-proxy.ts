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
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModelInfo } from '@flo-monster/core';

export interface CliProxyConfig {
  command?: string;     // Default: 'claude'
  args?: string[];      // Extra CLI args
  timeout?: number;     // Max response time in ms (default: 120000)
}

export interface CliProxyRequest {
  system?: string;           // System prompt
  messages: Message[];       // Conversation history
  model?: string;            // Model to use (passed as --model flag)
  max_tokens?: number;       // Token limit
  stream?: boolean;          // Always true in our case
  tools?: CliToolDef[];      // Tool definitions from API request body
}

export interface CliToolDef {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
  };
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
      // Fix ES6 Unicode escapes (\u{XXXX}) which are valid JS but not valid JSON.
      // Models sometimes generate these for emoji/non-BMP characters.
      const fixed = match[1].replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) =>
        String.fromCodePoint(parseInt(hex, 16)),
      );
      const parsed = JSON.parse(fixed);
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

  // Drop empty-argument "rehearsal" calls: when the same tool appears with both
  // empty {} and non-empty args, the empty one is the model rehearsing the format.
  // But empty-arg calls to OTHER tools are valid (e.g. capabilities {} + files {action: "list"}).
  const nonEmptyNames = new Set(
    toolCalls.filter(tc => Object.keys(tc.arguments).length > 0).map(tc => tc.name),
  );
  const filtered = toolCalls.filter(tc =>
    Object.keys(tc.arguments).length > 0 || !nonEmptyNames.has(tc.name),
  );

  return { textParts, toolCalls: filtered };
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
    } else if (block.type === 'image' && (block.source as Record<string, unknown>)?.type === 'base64') {
      // Write base64 image data to temp file so CLI can reference it
      const source = block.source as Record<string, string>;
      const tmpPath = writeTempImage(source.media_type, source.data);
      parts.push(`[Image: ${tmpPath}]`);
    } else {
      // Unknown block type — include as JSON
      parts.push(JSON.stringify(block));
    }
  }

  return parts.join('\n');
}

/**
 * Write base64-encoded image data to a temp file and return the path.
 */
export function writeTempImage(mediaType: string, base64Data: string): string {
  const ext = mediaType?.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
  const dir = join(tmpdir(), 'flo-cli-images');
  mkdirSync(dir, { recursive: true });
  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
  return filePath;
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
    // Include partial messages for future streaming optimization.
    // Currently we only process the final 'assistant' line, but this flag
    // causes CLI to emit stream_event lines with native Anthropic SSE events
    // that could be forwarded directly in a future streaming mode.
    '--include-partial-messages',
  ];

  // Disable all built-in tools so it acts as pure LLM proxy
  args.push('--tools', '');

  // Model selection
  if (req.model) {
    args.push('--model', req.model);
  }

  // System prompt — append tool call format instructions and tool schemas so the model
  // uses <tool_call> JSON format (which we parse) instead of other XML formats
  const systemPrompt = buildSystemPrompt(req.system, req.tools);
  args.push('--system-prompt', systemPrompt);

  // Budget from max_tokens — reverse-calculate cost using model pricing
  if (req.max_tokens) {
    const budget = calculateBudget(req.max_tokens, req.model);
    args.push('--max-budget-usd', budget.toFixed(4));
  }

  // Extra args from config
  if (config.args) {
    args.push(...config.args);
  }

  return args;
}

/**
 * Tool call format instructions appended to the system prompt.
 * Without native tool definitions (--tools ''), the model needs explicit
 * instructions on how to format tool calls so we can parse them.
 */
const TOOL_CALL_FORMAT_INSTRUCTIONS = `

When you need to call a tool, use this exact XML format:
<tool_call>
{"name": "tool_name", "arguments": {"param1": "value1", "param2": "value2"}}
</tool_call>

Tool results will be provided in <tool_result> blocks. Do not simulate or fabricate tool results.
Always include all required parameters. Never call a tool with empty arguments.
Use valid JSON only (no ES6 syntax like \\u{XXXX} — use literal characters instead).

DOM best practices: prefer "modify" to update existing elements over "create" which appends new ones. Use "create" only for truly new content.`;

/**
 * Serialize tool definitions compactly for inclusion in the system prompt.
 * Includes name, description, and properties with types — skips JSON Schema boilerplate.
 */
export function serializeToolSchemas(tools: CliToolDef[]): string {
  if (!tools || tools.length === 0) return '';

  const lines: string[] = ['\n\nAvailable tools:'];
  for (const tool of tools) {
    const props = tool.input_schema?.properties;
    if (!props) {
      lines.push(`- ${tool.name}: ${tool.description}`);
      continue;
    }
    const params: string[] = [];
    for (const [key, schema] of Object.entries(props)) {
      const parts: string[] = [key];
      if (schema.type) parts.push(`(${schema.type})`);
      if (schema.enum) parts.push(`[${(schema.enum as string[]).join('|')}]`);
      if (schema.description) parts.push(`- ${schema.description}`);
      params.push(parts.join(' '));
    }
    const required = tool.input_schema?.required;
    const reqStr = required && required.length > 0 ? ` Required: ${required.join(', ')}.` : '';
    lines.push(`- ${tool.name}: ${tool.description}${reqStr}`);
    lines.push(`  params: ${params.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * Build the system prompt for CLI, appending tool call format instructions
 * and compact tool schemas so the model knows exact parameter names.
 */
export function buildSystemPrompt(userSystemPrompt?: string, tools?: CliToolDef[]): string {
  const base = userSystemPrompt || '';
  const toolSchemas = serializeToolSchemas(tools || []);
  return base + TOOL_CALL_FORMAT_INSTRUCTIONS + toolSchemas;
}

/**
 * Calculate a budget in USD from max_tokens using model pricing.
 * Uses 1.5x multiplier (output cost + buffer for input tokens).
 * Falls back to $15/M output (Sonnet-level) if model not in registry.
 * Caps at $5 to prevent runaway costs.
 */
export function calculateBudget(maxTokens: number, model?: string): number {
  const DEFAULT_OUTPUT_PER_MILLION = 15; // Sonnet-level fallback
  const MAX_BUDGET = 5;

  let outputPerMillion = DEFAULT_OUTPUT_PER_MILLION;
  if (model) {
    const info = getModelInfo(model);
    if (info?.pricing?.outputPerMillion) {
      outputPerMillion = info.pricing.outputPerMillion;
    }
  }

  const outputCost = (maxTokens / 1_000_000) * outputPerMillion;
  const budget = outputCost * 1.5; // 50% buffer for input tokens
  return Math.min(budget, MAX_BUDGET);
}

/**
 * Shared async generator that spawns Claude CLI, buffers the complete response,
 * parses tool calls, and yields SSE-formatted strings.
 *
 * We buffer the complete CLI response before emitting events because tool call
 * support requires seeing the full message text. The LLM outputs tool calls as
 * <tool_call> XML in text content (since we use --tools '' to disable built-in
 * tools). transformMessageContent() parses this XML and creates proper Anthropic
 * tool_use content blocks. This parsing requires the complete text.
 *
 * --include-partial-messages is added to CLI args for future streaming optimization
 * (stream_event lines contain native Anthropic SSE events that could be forwarded
 * directly), but for now we only process the final 'assistant' line.
 *
 * Used by all three CLI proxy paths: HTTP, WebSocket, and Mode 4 (hub-persisted).
 */
export async function* streamCliEvents(
  req: CliProxyRequest,
  config: CliProxyConfig,
): AsyncGenerator<string> {
  const command = config.command || 'claude';
  const timeout = config.timeout || 120000;
  const args = buildCliArgs(req, config);
  const prompt = formatMessagesAsPrompt(req.messages);

  console.log(`[cli-proxy] model=${req.model || 'default'} messages=${req.messages.length} tools=${req.tools?.length || 0} max_tokens=${req.max_tokens || 'none'}`);

  // Spawn CLI, buffer output, wait for process exit
  const result = await new Promise<string>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
    } catch (err) {
      reject(new Error(`Failed to spawn CLI: ${(err as Error).message}`));
      return;
    }

    const timeoutHandle = setTimeout(() => {
      console.error('[cli-proxy] Process timed out, killing');
      proc.kill('SIGKILL');
      reject(new Error('CLI proxy timeout'));
    }, timeout);

    // Write prompt to stdin then close
    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    let stdoutBuffer = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
    });

    let stderrOutput = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0 && stderrOutput) {
        console.error(`[cli-proxy] Process exited with code ${code}: ${stderrOutput.slice(0, 500)}`);
      }
      resolve(stdoutBuffer);
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`CLI proxy error: ${err.message}`));
    });
  });

  // Parse CLI output and yield as SSE strings
  const lines = result.split('\n').filter(l => l.trim());
  for (const line of lines) {
    const events = parseStreamLine(line);
    for (const event of events) {
      yield formatSSE(event);
    }
  }
}

/**
 * HTTP handler — streams CLI proxy response as SSE to the browser.
 * Uses streamCliEvents() for the actual spawn+parse+yield logic.
 */
export async function handleCliProxy(
  req: CliProxyRequest,
  res: ServerResponse,
  config: CliProxyConfig,
): Promise<void> {
  // Set up SSE response headers immediately
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-hub-token, x-api-provider, anthropic-version, Authorization',
  });

  try {
    for await (const sseChunk of streamCliEvents(req, config)) {
      res.write(sseChunk);
    }
    res.end();
  } catch (err) {
    console.error('[cli-proxy] Process error:', (err as Error).message);
    // Headers already sent (SSE), so just end the response
    res.end();
  }
}
