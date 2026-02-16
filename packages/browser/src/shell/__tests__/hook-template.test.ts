import { describe, it, expect } from 'vitest';
import { renderHookTemplate } from '../hook-template';

describe('renderHookTemplate', () => {
  describe('toolName substitution', () => {
    it('should replace {{toolName}} with the tool name', () => {
      const result = renderHookTemplate('Tool: {{toolName}}', {
        toolName: 'read_file',
      });
      expect(result).toBe('Tool: read_file');
    });

    it('should replace multiple {{toolName}} occurrences', () => {
      const result = renderHookTemplate(
        '{{toolName}} started, {{toolName}} finished',
        { toolName: 'bash' }
      );
      expect(result).toBe('bash started, bash finished');
    });

    it('should render empty string when toolName is undefined', () => {
      const result = renderHookTemplate('Tool: {{toolName}}', {});
      expect(result).toBe('Tool: ');
    });
  });

  describe('input.X substitution', () => {
    it('should replace {{input.path}} with input path value', () => {
      const result = renderHookTemplate('Path: {{input.path}}', {
        toolInput: { path: '/tmp/test.txt' },
      });
      expect(result).toBe('Path: /tmp/test.txt');
    });

    it('should replace various input field names', () => {
      const result = renderHookTemplate(
        'Command: {{input.command}}, Timeout: {{input.timeout}}',
        {
          toolInput: { command: 'ls -la', timeout: 5000 },
        }
      );
      expect(result).toBe('Command: ls -la, Timeout: 5000');
    });

    it('should handle nested object values by converting to string', () => {
      const result = renderHookTemplate('Data: {{input.data}}', {
        toolInput: { data: { nested: 'value' } },
      });
      expect(result).toBe('Data: [object Object]');
    });

    it('should render empty string when input field is undefined', () => {
      const result = renderHookTemplate('Path: {{input.path}}', {
        toolInput: { other: 'value' },
      });
      expect(result).toBe('Path: ');
    });

    it('should render empty string when input field is null', () => {
      const result = renderHookTemplate('Path: {{input.path}}', {
        toolInput: { path: null },
      });
      expect(result).toBe('Path: ');
    });

    it('should render empty string when toolInput is undefined', () => {
      const result = renderHookTemplate('Path: {{input.path}}', {});
      expect(result).toBe('Path: ');
    });

    it('should handle boolean input values', () => {
      const result = renderHookTemplate('Flag: {{input.verbose}}', {
        toolInput: { verbose: true },
      });
      expect(result).toBe('Flag: true');
    });

    it('should handle numeric input values', () => {
      const result = renderHookTemplate('Count: {{input.count}}', {
        toolInput: { count: 42 },
      });
      expect(result).toBe('Count: 42');
    });
  });

  describe('result.content substitution', () => {
    it('should replace {{result.content}} with result content', () => {
      const result = renderHookTemplate('Output: {{result.content}}', {
        toolResult: { content: 'Success!' },
      });
      expect(result).toBe('Output: Success!');
    });

    it('should render empty string when result is undefined', () => {
      const result = renderHookTemplate('Output: {{result.content}}', {});
      expect(result).toBe('Output: ');
    });

    it('should handle multiline content', () => {
      const result = renderHookTemplate('Output: {{result.content}}', {
        toolResult: { content: 'Line 1\nLine 2\nLine 3' },
      });
      expect(result).toBe('Output: Line 1\nLine 2\nLine 3');
    });
  });

  describe('result.is_error substitution', () => {
    it('should replace {{result.is_error}} with true when error', () => {
      const result = renderHookTemplate('Error: {{result.is_error}}', {
        toolResult: { content: 'Failed', is_error: true },
      });
      expect(result).toBe('Error: true');
    });

    it('should replace {{result.is_error}} with false when not error', () => {
      const result = renderHookTemplate('Error: {{result.is_error}}', {
        toolResult: { content: 'Success', is_error: false },
      });
      expect(result).toBe('Error: false');
    });

    it('should render false when is_error is undefined', () => {
      const result = renderHookTemplate('Error: {{result.is_error}}', {
        toolResult: { content: 'Success' },
      });
      expect(result).toBe('Error: false');
    });

    it('should render false when result is undefined', () => {
      const result = renderHookTemplate('Error: {{result.is_error}}', {});
      expect(result).toBe('Error: false');
    });
  });

  describe('multiple substitutions', () => {
    it('should handle all substitution types in one template', () => {
      const result = renderHookTemplate(
        'Tool {{toolName}} with path {{input.path}} returned {{result.content}} (error: {{result.is_error}})',
        {
          toolName: 'read_file',
          toolInput: { path: '/etc/hosts' },
          toolResult: { content: 'file contents', is_error: false },
        }
      );
      expect(result).toBe(
        'Tool read_file with path /etc/hosts returned file contents (error: false)'
      );
    });

    it('should handle repeated variables of different types', () => {
      const result = renderHookTemplate(
        '{{toolName}}: {{input.cmd}} -> {{result.content}} | {{toolName}} done',
        {
          toolName: 'bash',
          toolInput: { cmd: 'echo test' },
          toolResult: { content: 'test' },
        }
      );
      expect(result).toBe('bash: echo test -> test | bash done');
    });
  });

  describe('plain string passthrough', () => {
    it('should pass through string with no variables unchanged', () => {
      const result = renderHookTemplate('echo "hello world"', {
        toolName: 'ignored',
        toolInput: { also: 'ignored' },
      });
      expect(result).toBe('echo "hello world"');
    });

    it('should pass through empty string', () => {
      const result = renderHookTemplate('', { toolName: 'test' });
      expect(result).toBe('');
    });

    it('should not substitute partial variable patterns', () => {
      const result = renderHookTemplate('{{tool}} {{inputpath}}', {
        toolName: 'test',
        toolInput: { path: 'value' },
      });
      expect(result).toBe('{{tool}} {{inputpath}}');
    });

    it('should handle curly braces that are not variables', () => {
      const result = renderHookTemplate('const obj = { key: "value" }', {});
      expect(result).toBe('const obj = { key: "value" }');
    });
  });

  describe('edge cases', () => {
    it('should handle empty context object', () => {
      const result = renderHookTemplate(
        '{{toolName}} {{input.x}} {{result.content}} {{result.is_error}}',
        {}
      );
      expect(result).toBe('   false');
    });

    it('should handle special characters in values', () => {
      const result = renderHookTemplate('Path: {{input.path}}', {
        toolInput: { path: '/path/with spaces/and$pecial"chars' },
      });
      expect(result).toBe('Path: /path/with spaces/and$pecial"chars');
    });

    it('should handle empty string values', () => {
      const result = renderHookTemplate('Tool: {{toolName}}', {
        toolName: '',
      });
      expect(result).toBe('Tool: ');
    });

    it('should handle zero as input value', () => {
      const result = renderHookTemplate('Count: {{input.count}}', {
        toolInput: { count: 0 },
      });
      expect(result).toBe('Count: 0');
    });

    it('should handle false as input value', () => {
      const result = renderHookTemplate('Flag: {{input.flag}}', {
        toolInput: { flag: false },
      });
      expect(result).toBe('Flag: false');
    });
  });
});
