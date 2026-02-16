import { describe, it, expect } from 'vitest';
import { getBuiltinToolDefinitions, BUILTIN_TOOL_NAMES } from './builtin-tools.js';

describe('getBuiltinToolDefinitions', () => {
  it('should export 10 tool definitions', () => {
    const defs = getBuiltinToolDefinitions();
    expect(defs).toHaveLength(10);
  });

  it('should have the correct tool names', () => {
    const defs = getBuiltinToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toEqual(['runjs', 'dom', 'fetch', 'storage', 'files', 'agent_respond', 'worker_message', 'view_state', 'state', 'capabilities']);
    expect(names).toEqual([...BUILTIN_TOOL_NAMES]);
  });

  it('should have valid input_schema on each definition', () => {
    const defs = getBuiltinToolDefinitions();
    for (const def of defs) {
      expect(def.input_schema).toBeDefined();
      expect(def.input_schema.type).toBe('object');
      expect(def.input_schema.properties).toBeDefined();
      // Some tools (like agent_respond) don't have required fields
      if (def.input_schema.required) {
        expect(Array.isArray(def.input_schema.required)).toBe(true);
      }
      expect(def.description).toBeTruthy();
    }
  });

  it('includes files tool definition', () => {
    const tools = getBuiltinToolDefinitions();
    const filesTool = tools.find(t => t.name === 'files');
    expect(filesTool).toBeDefined();
    expect(filesTool!.name).toBe('files');
    expect(filesTool!.input_schema.properties!.action).toBeDefined();
    expect(filesTool!.input_schema.properties!.path).toBeDefined();
    expect(filesTool!.input_schema.properties!.content).toBeDefined();
    expect(filesTool!.input_schema.required).toEqual(['action']);
  });

  it('files tool action has correct enum values', () => {
    const tools = getBuiltinToolDefinitions();
    const filesTool = tools.find(t => t.name === 'files');
    expect(filesTool!.input_schema.properties!.action.enum).toEqual(
      ['read_file', 'write_file', 'list_files', 'delete_file', 'mkdir', 'list_dir', 'frontmatter']
    );
  });

  it('BUILTIN_TOOL_NAMES includes files', () => {
    expect(BUILTIN_TOOL_NAMES).toContain('files');
    expect(BUILTIN_TOOL_NAMES).toHaveLength(10);
  });

  it('includes view_state tool definition', () => {
    const tools = getBuiltinToolDefinitions();
    const tool = tools.find(t => t.name === 'view_state');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.properties!.state).toBeDefined();
    expect(tool!.input_schema.properties!.state.enum).toEqual(['max', 'ui-only', 'chat-only']);
    expect(tool!.input_schema.required).toEqual(['state']);
  });

  it('includes agent_respond tool definition', () => {
    const tools = getBuiltinToolDefinitions();
    const tool = tools.find(t => t.name === 'agent_respond');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.properties!.result).toBeDefined();
    expect(tool!.input_schema.properties!.error).toBeDefined();
  });

  it('includes worker_message tool definition', () => {
    const tools = getBuiltinToolDefinitions();
    const tool = tools.find(t => t.name === 'worker_message');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.properties!.target).toBeDefined();
    expect(tool!.input_schema.properties!.event).toBeDefined();
    expect(tool!.input_schema.properties!.data).toBeDefined();
    expect(tool!.input_schema.required).toEqual(['target', 'event']);
  });

  it('dom tool includes event listener actions', () => {
    const tools = getBuiltinToolDefinitions();
    const domTool = tools.find(t => t.name === 'dom');
    expect(domTool).toBeDefined();
    const actionEnum = domTool!.input_schema.properties!.action.enum;
    expect(actionEnum).toContain('listen');
    expect(actionEnum).toContain('unlisten');
    expect(actionEnum).toContain('wait_for');
    expect(actionEnum).toContain('get_listeners');
    expect(domTool!.input_schema.properties!.events).toBeDefined();
    expect(domTool!.input_schema.properties!.event).toBeDefined();
    expect(domTool!.input_schema.properties!.timeout).toBeDefined();
    expect(domTool!.input_schema.properties!.options).toBeDefined();
  });

  it('includes capabilities tool definition', () => {
    const tools = getBuiltinToolDefinitions();
    const tool = tools.find(t => t.name === 'capabilities');
    expect(tool).toBeDefined();
    expect(tool!.input_schema.properties!.probe).toBeDefined();
    expect(tool!.input_schema.properties!.url).toBeDefined();
    expect(tool!.input_schema.properties!.name).toBeDefined();
    expect(tool!.description).toBeTruthy();
  });
});
