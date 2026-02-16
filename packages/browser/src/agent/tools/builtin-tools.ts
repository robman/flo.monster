import type { ToolDef } from '@flo-monster/core';

/**
 * Array of all builtin tool definitions.
 * These are tools that execute inside the worker/iframe (not shell plugins).
 * web_fetch and web_search are shell plugins, so they come from pluginRegistry.
 */
export const BUILTIN_TOOL_DEFS: ToolDef[] = [
    {
      name: 'runjs',
      description: 'Execute JavaScript code. Returns the result and console output.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute' },
          context: { type: 'string', enum: ['iframe', 'worker'], description: 'Execution context. iframe (default) has DOM access; worker is for pure computation.' },
        },
        required: ['code'],
      },
    },
    {
      name: 'dom',
      description: 'Manipulate the DOM in the agent viewport. Supports create, modify, query, remove for basic DOM manipulation, plus listen, unlisten, wait_for, get_listeners for event handling.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'modify', 'query', 'remove', 'listen', 'unlisten', 'wait_for', 'get_listeners'], description: 'DOM action' },
          html: { type: 'string', description: 'HTML to create (for create action)' },
          selector: { type: 'string', description: 'CSS selector' },
          attributes: { type: 'object', description: 'Attributes to set (for modify action)' },
          textContent: { type: 'string', description: 'Text content to set (for modify action)' },
          innerHTML: { type: 'string', description: 'Inner HTML to set (for modify action) - replaces element contents' },
          parentSelector: { type: 'string', description: 'Parent CSS selector (for create action)' },
          events: { type: 'array', items: { type: 'string' }, description: 'Event types to listen for (for listen action)' },
          event: { type: 'string', description: 'Single event type to wait for (for wait_for action)' },
          timeout: { type: 'number', description: 'Timeout in milliseconds for wait_for action' },
          options: { type: 'object', properties: { debounce: { type: 'number' } }, description: 'Options for event listeners' },
        },
        required: ['action'],
      },
    },
    {
      name: 'fetch',
      description: 'Make HTTP requests.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default: GET)' },
          headers: { type: 'object', description: 'Request headers' },
          body: { type: 'string', description: 'Request body' },
        },
        required: ['url'],
      },
    },
    {
      name: 'storage',
      description: 'Persistent key-value storage.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'delete', 'list'], description: 'Storage action' },
          key: { type: 'string', description: 'Storage key' },
          value: { type: 'string', description: 'Value to store' },
        },
        required: ['action'],
      },
    },
    {
      name: 'files',
      description: 'Read, write, list, and manage files in the agent workspace using the Origin Private File System. Files are session-scoped and do not persist across page reloads. For persistent data, use the storage tool.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read_file', 'write_file', 'list_files', 'delete_file', 'mkdir', 'list_dir', 'frontmatter'], description: 'File operation to perform' },
          path: { type: 'string', description: 'File or directory path (e.g., "data/output.txt")' },
          content: { type: 'string', description: 'Content to write (write_file only)' },
          pattern: { type: 'string', description: 'Glob pattern for frontmatter action (e.g., "*.srcdoc.md")' },
        },
        required: ['action'],
      },
    },
    {
      name: 'agent_respond',
      description: 'Respond to a flo.ask() request from JavaScript in the agent iframe. The response will be delivered to the JS caller as a resolved Promise.',
      input_schema: {
        type: 'object',
        properties: {
          result: { type: 'object', description: 'The result to send back to the JS caller (any JSON-serializable value)' },
          error: { type: 'string', description: 'Optional error message. If provided, the JS Promise will be rejected.' },
        },
      },
    },
    {
      name: 'worker_message',
      description: 'Send a message to another worker in the same agent iframe. Use this to coordinate between parent agents and subagents.',
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Target worker ID: "main", a subworker ID, or "broadcast" for all workers' },
          event: { type: 'string', description: 'Event name/type for the message' },
          data: { type: 'object', description: 'Data payload to send (any JSON-serializable value)' },
        },
        required: ['target', 'event'],
      },
    },
    {
      name: 'view_state',
      description: 'Change the view layout. States: "max" (UI + chat side by side), "ui-only" (UI fullscreen, chat hidden), "chat-only" (chat fullscreen, UI hidden). Note: "max" is not available on mobile devices - use "ui-only" or "chat-only" instead.',
      input_schema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['max', 'ui-only', 'chat-only'], description: 'Target view state' },
        },
        required: ['state'],
      },
    },
    {
      name: 'state',
      description: 'Reactive state management. Read/write persistent state visible to page JavaScript via flo.state, and manage escalation rules that wake the agent when conditions are met.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'get_all', 'set', 'delete', 'escalation_rules', 'escalate', 'clear_escalation'], description: 'State action to perform' },
          key: { type: 'string', description: 'State key (required for get, set, delete, escalate, clear_escalation)' },
          value: { type: 'object', description: 'Value to set (any JSON type, required for set)' },
          condition: { type: 'string', description: 'JS expression for escalation condition. Use "always" to escalate on every change, or a JS expression like "val > 100" where val is the new value.' },
          message: { type: 'string', description: 'Context message included when escalation fires, so you remember why you set this rule' },
        },
        required: ['action'],
      },
    },
    {
      name: 'capabilities',
      description: 'Discover your runtime environment. Call with no arguments for a full snapshot (platform, tools, viewport, permissions, hub, extensions). Call with a probe argument for specific feature detection (webgl, webaudio, webrtc, webgpu, wasm, offscreencanvas, sharedarraybuffer, storage, network, tool).',
      input_schema: {
        type: 'object',
        properties: {
          probe: { type: 'string', description: 'Feature to probe: webgl, webaudio, webrtc, webgpu, wasm, offscreencanvas, sharedarraybuffer, storage, network, tool' },
          url: { type: 'string', description: 'URL to check (for network probe)' },
          name: { type: 'string', description: 'Tool name to check (for tool probe)' },
        },
      },
    },
  ];

/**
 * Returns all builtin tool definitions.
 * @deprecated Use BUILTIN_TOOL_DEFS constant instead.
 */
export function getBuiltinToolDefinitions(): ToolDef[] {
  return [...BUILTIN_TOOL_DEFS];
}

export const BUILTIN_TOOL_NAMES = ['runjs', 'dom', 'fetch', 'storage', 'files', 'agent_respond', 'worker_message', 'view_state', 'state', 'capabilities'] as const;
