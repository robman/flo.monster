/**
 * Tests for CLI proxy module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import {
  formatMessagesAsPrompt,
  parseToolCalls,
  transformMessageContent,
  parseStreamLine,
  formatSSE,
  buildCliArgs,
  handleCliProxy,
  synthesizeSSEFromMessage,
  type CliProxyConfig,
  type CliProxyRequest,
} from '../cli-proxy.js';

class MockProcess extends EventEmitter {
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
  pid = 12345;
}

// Track the current mock process for tests
let currentMockProcess: MockProcess;

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn((): ChildProcess => {
      return currentMockProcess as unknown as ChildProcess;
    }),
  };
});

describe('CLI proxy', () => {
  describe('parseToolCalls', () => {
    it('should extract a single tool call from text', () => {
      const text = 'Let me check.\n<tool_call>\n{"name": "capabilities", "arguments": {}}\n</tool_call>';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(textParts).toEqual(['Let me check.']);
      expect(toolCalls).toEqual([{ name: 'capabilities', arguments: {} }]);
    });

    it('should extract multiple tool calls', () => {
      const text = 'Checking...\n<tool_call>\n{"name": "capabilities", "arguments": {}}\n</tool_call>\n<tool_call>\n{"name": "files", "arguments": {"action": "list"}}\n</tool_call>';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(textParts).toEqual(['Checking...']);
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].name).toBe('capabilities');
      expect(toolCalls[1].name).toBe('files');
      expect(toolCalls[1].arguments).toEqual({ action: 'list' });
    });

    it('should discard trailing text after tool calls (simulated continuation)', () => {
      const text = 'Before\n<tool_call>\n{"name": "dom", "arguments": {"action":"create"}}\n</tool_call>\nAfter the tool call';
      const { textParts, toolCalls } = parseToolCalls(text);
      // "After the tool call" is discarded — it's the LLM simulating a response
      expect(textParts).toEqual(['Before']);
      expect(toolCalls).toHaveLength(1);
    });

    it('should handle text with no tool calls', () => {
      const text = 'Just plain text, no tool calls here.';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(textParts).toEqual(['Just plain text, no tool calls here.']);
      expect(toolCalls).toHaveLength(0);
    });

    it('should handle only tool calls with no surrounding text', () => {
      const text = '<tool_call>\n{"name": "dom", "arguments": {}}\n</tool_call>';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(textParts).toHaveLength(0);
      expect(toolCalls).toHaveLength(1);
    });

    it('should handle malformed JSON in tool call gracefully', () => {
      const text = '<tool_call>\nnot valid json\n</tool_call>';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(toolCalls).toHaveLength(0);
      // Malformed tool call treated as text
      expect(textParts).toHaveLength(1);
      expect(textParts[0]).toContain('not valid json');
    });

    it('should strip <tool_result> blocks from text', () => {
      const text = '<tool_result>\n{"ok":true}\n</tool_result>';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(textParts).toHaveLength(0);
      expect(toolCalls).toHaveLength(0);
    });

    it('should strip fake tool_result and discard trailing text', () => {
      const text = 'Checking.\n<tool_call>\n{"name": "capabilities", "arguments": {}}\n</tool_call>\n<tool_result>\n{"platform":"web"}\n</tool_result>\nDone!';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].name).toBe('capabilities');
      // "Done!" is trailing text after tool calls — discarded (simulated continuation)
      expect(textParts).toEqual(['Checking.']);
    });

    it('should strip multiple fake tool_results and discard trailing text', () => {
      const text = 'Hi\n<tool_call>\n{"name": "a", "arguments": {}}\n</tool_call>\n<tool_result>\nresult1\n</tool_result>\n<tool_call>\n{"name": "b", "arguments": {}}\n</tool_call>\n<tool_result>\nresult2\n</tool_result>\nBye';
      const { textParts, toolCalls } = parseToolCalls(text);
      expect(toolCalls).toHaveLength(2);
      // "Bye" is trailing text — discarded
      expect(textParts).toEqual(['Hi']);
    });
  });

  describe('transformMessageContent', () => {
    it('should parse tool calls from text and create tool_use blocks', () => {
      const message = {
        content: [{ type: 'text', text: 'Hello\n<tool_call>\n{"name": "dom", "arguments": {"action":"create"}}\n</tool_call>' }],
        stop_reason: 'end_turn',
      };
      const result = transformMessageContent(message);
      const content = result.content as Array<Record<string, unknown>>;

      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'Hello' });
      expect(content[1].type).toBe('tool_use');
      expect(content[1].name).toBe('dom');
      expect(content[1].input).toEqual({ action: 'create' });
      expect(content[1].id).toBeDefined();
      expect(result.stop_reason).toBe('tool_use');
    });

    it('should not modify messages without tool calls', () => {
      const message = {
        content: [{ type: 'text', text: 'Just regular text' }],
        stop_reason: 'end_turn',
      };
      const result = transformMessageContent(message);
      const content = result.content as Array<Record<string, unknown>>;

      expect(content).toHaveLength(1);
      expect(content[0]).toEqual({ type: 'text', text: 'Just regular text' });
      expect(result.stop_reason).toBe('end_turn');
    });

    it('should preserve existing tool_use blocks', () => {
      const message = {
        content: [{ type: 'tool_use', id: 'existing', name: 'dom', input: {} }],
        stop_reason: 'tool_use',
      };
      const result = transformMessageContent(message);
      const content = result.content as Array<Record<string, unknown>>;

      expect(content).toHaveLength(1);
      expect(content[0].id).toBe('existing');
      expect(result.stop_reason).toBe('tool_use');
    });

    it('should handle multiple tool calls in one text block', () => {
      const message = {
        content: [{
          type: 'text',
          text: 'Let me check.\n<tool_call>\n{"name": "capabilities", "arguments": {}}\n</tool_call>\n<tool_call>\n{"name": "files", "arguments": {"action":"list"}}\n</tool_call>',
        }],
        stop_reason: 'end_turn',
      };
      const result = transformMessageContent(message);
      const content = result.content as Array<Record<string, unknown>>;

      expect(content).toHaveLength(3); // text + 2 tool_use
      expect(content[0].type).toBe('text');
      expect(content[1].type).toBe('tool_use');
      expect(content[1].name).toBe('capabilities');
      expect(content[2].type).toBe('tool_use');
      expect(content[2].name).toBe('files');
      expect(result.stop_reason).toBe('tool_use');
    });

    it('should generate unique IDs for each tool_use', () => {
      const message = {
        content: [{
          type: 'text',
          text: '<tool_call>\n{"name": "a", "arguments": {}}\n</tool_call>\n<tool_call>\n{"name": "b", "arguments": {}}\n</tool_call>',
        }],
      };
      const result = transformMessageContent(message);
      const content = result.content as Array<Record<string, unknown>>;
      expect(content[0].id).not.toBe(content[1].id);
    });
  });

  describe('formatMessagesAsPrompt', () => {
    it('should format a single user message', () => {
      const result = formatMessagesAsPrompt([
        { role: 'user', content: 'Hello' },
      ]);
      expect(result).toBe('Human: Hello');
    });

    it('should format multi-turn conversation', () => {
      const result = formatMessagesAsPrompt([
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ]);
      expect(result).toBe('Human: Hi\n\nAssistant: Hello!\n\nHuman: How are you?');
    });

    it('should handle text content blocks', () => {
      const result = formatMessagesAsPrompt([
        { role: 'assistant', content: [{ type: 'text', text: 'I can help with that.' }] },
      ]);
      expect(result).toBe('Assistant: I can help with that.');
    });

    it('should format tool_use as XML', () => {
      const result = formatMessagesAsPrompt([
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'dom', input: { action: 'create', html: '<p>hi</p>' } },
          ],
        },
      ]);
      expect(result).toContain('<tool_call>');
      expect(result).toContain('"name":"dom"');
      expect(result).toContain('</tool_call>');
    });

    it('should format tool_result as XML', () => {
      const result = formatMessagesAsPrompt([
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '{"ok":true}' },
          ],
        },
      ]);
      expect(result).toContain('<tool_result>');
      expect(result).toContain('{"ok":true}');
      expect(result).toContain('</tool_result>');
    });

    it('should handle mixed content blocks', () => {
      const result = formatMessagesAsPrompt([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me update the DOM.' },
            { type: 'tool_use', id: 'tu_1', name: 'dom', input: { html: '<p>done</p>' } },
          ],
        },
      ]);
      expect(result).toContain('Let me update the DOM.');
      expect(result).toContain('<tool_call>');
    });

    it('should handle tool_result with array content', () => {
      const result = formatMessagesAsPrompt([
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: 'Array result' }],
            },
          ],
        },
      ]);
      expect(result).toContain('<tool_result>');
      expect(result).toContain('Array result');
    });
  });

  describe('parseStreamLine', () => {
    it('should synthesize SSE events from assistant message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: [{ type: 'text', text: 'Hello!' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });
      const events = parseStreamLine(line);
      expect(events.length).toBeGreaterThanOrEqual(5);
      expect(events[0].type).toBe('message_start');
      expect(events[1].type).toBe('content_block_start');
      expect(events[2].type).toBe('content_block_delta');
      expect((events[2].delta as Record<string, unknown>).text).toBe('Hello!');
      expect(events[3].type).toBe('content_block_stop');
      expect(events[4].type).toBe('message_delta');
      expect((events[4].delta as Record<string, unknown>).stop_reason).toBe('end_turn');
      expect(events[5].type).toBe('message_stop');
    });

    it('should parse tool calls from assistant text and create tool_use events', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_2',
          content: [{ type: 'text', text: 'Let me check.\n<tool_call>\n{"name": "dom", "arguments": {"action":"query"}}\n</tool_call>' }],
          stop_reason: 'end_turn',
        },
      });
      const events = parseStreamLine(line);

      // message_start + text block (3) + tool_use block (3) + message_delta + message_stop = 9
      expect(events[0].type).toBe('message_start');
      // Text block: "Let me check."
      expect(events[1].type).toBe('content_block_start');
      expect((events[1].content_block as Record<string, unknown>).type).toBe('text');
      expect(events[2].type).toBe('content_block_delta');
      expect((events[2].delta as Record<string, unknown>).text).toBe('Let me check.');
      expect(events[3].type).toBe('content_block_stop');
      // Tool use block
      expect(events[4].type).toBe('content_block_start');
      expect((events[4].content_block as Record<string, unknown>).type).toBe('tool_use');
      expect((events[4].content_block as Record<string, unknown>).name).toBe('dom');
      expect(events[5].type).toBe('content_block_delta');
      expect((events[5].delta as Record<string, unknown>).type).toBe('input_json_delta');
      expect(events[6].type).toBe('content_block_stop');
      // message_delta should have stop_reason: tool_use
      expect(events[7].type).toBe('message_delta');
      expect((events[7].delta as Record<string, unknown>).stop_reason).toBe('tool_use');
      expect(events[8].type).toBe('message_stop');
    });

    it('should return empty array for system/result lines', () => {
      expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
      expect(parseStreamLine(JSON.stringify({ type: 'result', data: {} }))).toEqual([]);
    });

    it('should return empty array for empty lines', () => {
      expect(parseStreamLine('')).toEqual([]);
      expect(parseStreamLine('   ')).toEqual([]);
    });

    it('should return empty array for non-JSON lines', () => {
      expect(parseStreamLine('not json')).toEqual([]);
    });

    it('should log errors from CLI error lines', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      parseStreamLine(JSON.stringify({ type: 'error', error: 'something failed' }));
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('CLI error'), expect.anything());
      spy.mockRestore();
    });
  });

  describe('formatSSE', () => {
    it('should format event as SSE string', () => {
      const event = { type: 'message_start', message: { id: 'msg_1' } };
      const result = formatSSE(event);
      expect(result).toBe(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`);
    });

    it('should format content_block_delta as SSE', () => {
      const event = {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hi' },
      };
      const result = formatSSE(event);
      expect(result.startsWith('event: content_block_delta\n')).toBe(true);
      expect(result).toContain('"text":"Hi"');
      expect(result.endsWith('\n\n')).toBe(true);
    });
  });

  describe('buildCliArgs', () => {
    it('should include base flags', () => {
      const req: CliProxyRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);

      expect(args).toContain('-p');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--verbose');
      expect(args).toContain('--no-session-persistence');
    });

    it('should not include --include-partial-messages (buffered mode)', () => {
      const req: CliProxyRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);
      expect(args).not.toContain('--include-partial-messages');
    });

    it('should disable tools with --tools ""', () => {
      const req: CliProxyRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);

      const toolsIdx = args.indexOf('--tools');
      expect(toolsIdx).toBeGreaterThan(-1);
      expect(args[toolsIdx + 1]).toBe('');
    });

    it('should include system prompt when provided', () => {
      const req: CliProxyRequest = {
        system: 'You are a helpful agent.',
        messages: [{ role: 'user', content: 'hi' }],
      };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);

      const sysIdx = args.indexOf('--system-prompt');
      expect(sysIdx).toBeGreaterThan(-1);
      expect(args[sysIdx + 1]).toBe('You are a helpful agent.');
    });

    it('should not include system prompt when not provided', () => {
      const req: CliProxyRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);

      expect(args).not.toContain('--system-prompt');
    });

    it('should include extra args from config', () => {
      const req: CliProxyRequest = { messages: [{ role: 'user', content: 'hi' }] };
      const config: CliProxyConfig = { args: ['--model', 'opus'] };
      const args = buildCliArgs(req, config);

      expect(args).toContain('--model');
      expect(args).toContain('opus');
    });

    it('should include --max-turns 1 when max_tokens is set', () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 4096,
      };
      const config: CliProxyConfig = {};
      const args = buildCliArgs(req, config);

      expect(args).toContain('--max-turns');
      expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
    });
  });

  describe('handleCliProxy', () => {
    let mockRes: MockResponse;

    class MockResponse {
      statusCode: number | undefined;
      headers: Record<string, string> = {};
      chunks: string[] = [];
      ended = false;
      headersSent = false;

      writeHead(status: number, headers: Record<string, string> = {}) {
        this.statusCode = status;
        this.headers = { ...this.headers, ...headers };
        this.headersSent = true;
      }

      write(chunk: string) {
        this.chunks.push(chunk);
        return true;
      }

      end(data?: string) {
        if (data) this.chunks.push(data);
        this.ended = true;
      }

      setHeader(key: string, value: string) {
        this.headers[key] = value;
      }
    }

    beforeEach(() => {
      currentMockProcess = new MockProcess();
      mockRes = new MockResponse();
    });

    it('should spawn claude with correct command and flags', async () => {
      const { spawn } = await import('node:child_process');
      const req: CliProxyRequest = {
        system: 'You are a test agent.',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const config: CliProxyConfig = { command: 'claude' };

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence']),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
    });

    it('should write prompt to stdin', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Test prompt' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(currentMockProcess.stdin.write).toHaveBeenCalledWith('Human: Test prompt');
      expect(currentMockProcess.stdin.end).toHaveBeenCalled();
    });

    it('should buffer stdout and emit SSE events on close', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      const assistantLine = JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello!' }], stop_reason: 'end_turn' },
      });

      setTimeout(() => {
        currentMockProcess.stdout.emit('data', Buffer.from(assistantLine + '\n'));
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(mockRes.statusCode).toBe(200);
      expect(mockRes.headers['Content-Type']).toBe('text/event-stream');
      // message_start + block_start + block_delta + block_stop + message_delta + message_stop = 6
      expect(mockRes.chunks.length).toBe(6);
      expect(mockRes.chunks[0]).toContain('event: message_start');
      expect(mockRes.chunks[5]).toContain('event: message_stop');
    });

    it('should parse tool calls from buffered response', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      const assistantLine = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [{ type: 'text', text: 'Let me help.\n<tool_call>\n{"name": "dom", "arguments": {"action":"create","html":"<p>hi</p>"}}\n</tool_call>' }],
          stop_reason: 'end_turn',
        },
      });

      setTimeout(() => {
        currentMockProcess.stdout.emit('data', Buffer.from(assistantLine + '\n'));
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      // Should have: message_start + text(3) + tool_use(3) + message_delta + message_stop = 9
      expect(mockRes.chunks.length).toBe(9);
      // Check text block
      expect(mockRes.chunks[2]).toContain('text_delta');
      expect(mockRes.chunks[2]).toContain('Let me help.');
      // Check tool_use block
      expect(mockRes.chunks[4]).toContain('content_block_start');
      expect(mockRes.chunks[4]).toContain('tool_use');
      expect(mockRes.chunks[4]).toContain('"dom"');
      // Check stop_reason is tool_use
      expect(mockRes.chunks[7]).toContain('"stop_reason":"tool_use"');
    });

    it('should skip system and result lines', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      const systemLine = JSON.stringify({ type: 'system', subtype: 'init', tools: [] });
      const assistantLine = JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Hi!' }], stop_reason: 'end_turn' },
      });
      const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false });

      setTimeout(() => {
        currentMockProcess.stdout.emit('data', Buffer.from(systemLine + '\n' + assistantLine + '\n' + resultLine + '\n'));
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      // Only the assistant line should produce events (6)
      expect(mockRes.chunks.length).toBe(6);
      expect(mockRes.chunks[0]).toContain('event: message_start');
    });

    it('should handle process timeout', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = { timeout: 50 };

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      const proc = currentMockProcess;
      setTimeout(() => {
        proc.emit('close', null);
      }, 100);

      await promise;

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('should log stderr output on non-zero exit', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.stderr.emit('data', Buffer.from('Some error happened'));
        currentMockProcess.emit('close', 1);
      }, 10);

      await promise;

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('Process exited with code 1'),
      );
      const callArgs = spy.mock.calls.find(c => String(c[0]).includes('Process exited'));
      expect(callArgs).toBeDefined();
      expect(String(callArgs![0])).toContain('Some error happened');
      spy.mockRestore();
    });

    it('should handle process error event', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('error', new Error('spawn ENOENT'));
        currentMockProcess.emit('close', 1);
      }, 10);

      await promise;

      expect(mockRes.ended).toBe(true);
    });

    it('should use default command when not specified', async () => {
      const { spawn } = await import('node:child_process');
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(spawn).toHaveBeenCalledWith('claude', expect.anything(), expect.anything());
    });

    it('should set SSE response headers including CORS', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(mockRes.headers['Content-Type']).toBe('text/event-stream');
      expect(mockRes.headers['Cache-Control']).toBe('no-cache');
      expect(mockRes.headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('should end the response when process closes', async () => {
      const req: CliProxyRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      expect(mockRes.ended).toBe(true);
    });

    it('should format tool_use/tool_result as XML in prompt for roundtrip', async () => {
      const req: CliProxyRequest = {
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool_use', id: 'tu_1', name: 'capabilities', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: '{"platform":"web"}' },
            ],
          },
        ],
      };
      const config: CliProxyConfig = {};

      const promise = handleCliProxy(req, mockRes as unknown as ServerResponse, config);

      setTimeout(() => {
        currentMockProcess.emit('close', 0);
      }, 10);

      await promise;

      // Check that the prompt sent to stdin uses XML format
      const writtenPrompt = currentMockProcess.stdin.write.mock.calls[0][0] as string;
      expect(writtenPrompt).toContain('<tool_call>');
      expect(writtenPrompt).toContain('"name":"capabilities"');
      expect(writtenPrompt).toContain('</tool_call>');
      expect(writtenPrompt).toContain('<tool_result>');
      expect(writtenPrompt).toContain('{"platform":"web"}');
      expect(writtenPrompt).toContain('</tool_result>');
    });
  });
});
