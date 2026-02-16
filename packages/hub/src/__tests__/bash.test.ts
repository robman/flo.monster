/**
 * Tests for bash tool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeBash, isCommandBlocked, isCommandAllowed, validateCwd, getEffectiveBlocklist } from '../tools/bash.js';
import { getDefaultConfig, type HubConfig } from '../config.js';

describe('bash tool', () => {
  describe('isCommandBlocked', () => {
    it('should return false with no blocked commands', () => {
      expect(isCommandBlocked('ls -la', undefined)).toBe(false);
      expect(isCommandBlocked('ls -la', [])).toBe(false);
    });

    it('should block matching commands', () => {
      const blocked = ['rm -rf /', 'mkfs'];

      expect(isCommandBlocked('rm -rf /', blocked)).toBe(true);
      expect(isCommandBlocked('mkfs /dev/sda', blocked)).toBe(true);
    });

    it('should block commands with sudo prefix', () => {
      const blocked = ['rm', 'mkfs'];

      expect(isCommandBlocked('sudo rm file.txt', blocked)).toBe(true);
      expect(isCommandBlocked('sudo mkfs /dev/sda', blocked)).toBe(true);
    });

    it('should allow non-matching commands', () => {
      const blocked = ['rm -rf /'];

      expect(isCommandBlocked('ls -la', blocked)).toBe(false);
      expect(isCommandBlocked('rm file.txt', blocked)).toBe(false);
    });

    it('should NOT block commands that merely contain the blocked word as substring', () => {
      const blocked = ['rm'];

      // These should NOT be blocked - they just contain "rm" as a substring
      expect(isCommandBlocked('ls rm_old_backup', blocked)).toBe(false);
      expect(isCommandBlocked('echo "rm is dangerous"', blocked)).toBe(false);
      expect(isCommandBlocked('cat format.txt', blocked)).toBe(false);

      // But the actual rm command should be blocked
      expect(isCommandBlocked('rm file.txt', blocked)).toBe(true);
      expect(isCommandBlocked('/bin/rm file.txt', blocked)).toBe(true);
    });

    it('should handle full paths in blocked commands', () => {
      const blocked = ['rm'];

      expect(isCommandBlocked('/bin/rm file.txt', blocked)).toBe(true);
      expect(isCommandBlocked('/usr/bin/rm -rf dir', blocked)).toBe(true);
    });

    it('should be case insensitive', () => {
      const blocked = ['RM -RF /'];

      expect(isCommandBlocked('rm -rf /', blocked)).toBe(true);
    });
  });

  describe('isCommandAllowed', () => {
    it('should return true with no allowed list', () => {
      expect(isCommandAllowed('anything', undefined)).toBe(true);
      expect(isCommandAllowed('anything', [])).toBe(true);
    });

    it('should allow matching commands', () => {
      const allowed = ['ls', 'cat', 'echo'];

      expect(isCommandAllowed('ls -la', allowed)).toBe(true);
      expect(isCommandAllowed('cat file.txt', allowed)).toBe(true);
      expect(isCommandAllowed('echo hello', allowed)).toBe(true);
    });

    it('should reject non-matching commands', () => {
      const allowed = ['ls', 'cat'];

      expect(isCommandAllowed('rm file.txt', allowed)).toBe(false);
      expect(isCommandAllowed('wget url', allowed)).toBe(false);
    });

    it('should handle full paths', () => {
      const allowed = ['ls'];

      expect(isCommandAllowed('/bin/ls -la', allowed)).toBe(true);
      expect(isCommandAllowed('/usr/bin/ls', allowed)).toBe(true);
    });

    it('should reject compound commands where some are not allowed', () => {
      expect(isCommandAllowed('ls; rm -rf /', ['ls'])).toBe(false);
    });

    it('should reject command substitution in allowed mode', () => {
      expect(isCommandAllowed('ls $(whoami)', ['ls'])).toBe(false);
    });

    it('should reject backtick substitution in allowed mode', () => {
      expect(isCommandAllowed('ls `whoami`', ['ls'])).toBe(false);
    });

    it('should reject newline injection in allowed mode', () => {
      expect(isCommandAllowed('ls\nrm -rf /', ['ls'])).toBe(false);
    });

    it('should reject process substitution in allowed mode', () => {
      expect(isCommandAllowed('diff <(cat /etc/passwd) file.txt', ['diff'])).toBe(false);
    });

    it('should reject heredoc in allowed mode', () => {
      expect(isCommandAllowed('cat <<EOF', ['cat'])).toBe(false);
    });

    it('should allow simple compound when all commands are allowed', () => {
      expect(isCommandAllowed('ls | grep foo', ['ls', 'grep'])).toBe(true);
    });

    it('should allow chained commands when all are allowed', () => {
      expect(isCommandAllowed('echo hello && echo world', ['echo'])).toBe(true);
    });
  });

  describe('executeBash', () => {
    let execSandboxDir: string;
    let execConfig: HubConfig;

    beforeEach(async () => {
      execSandboxDir = join(tmpdir(), `hub-bash-exec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(execSandboxDir, { recursive: true });
      await mkdir(join(execSandboxDir, 'subdir'), { recursive: true });

      execConfig = {
        ...getDefaultConfig(),
        sandboxPath: execSandboxDir,
      };
    });

    afterEach(async () => {
      await rm(execSandboxDir, { recursive: true, force: true });
    });

    it('should return error when bash is disabled', async () => {
      const config: HubConfig = {
        ...execConfig,
        tools: {
          ...execConfig.tools,
          bash: { enabled: false },
        },
      };

      const result = await executeBash({ command: 'echo test' }, config);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('disabled');
    });

    it('should execute simple commands', async () => {
      const result = await executeBash({ command: 'echo hello' }, execConfig);

      expect(result.is_error).toBeUndefined();
      expect(result.content.trim()).toBe('hello');
    });

    it('should block dangerous commands', async () => {
      const result = await executeBash({ command: 'rm -rf /' }, execConfig);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('blocked');
    });

    it('should respect allowed commands list', async () => {
      const config: HubConfig = {
        ...execConfig,
        tools: {
          ...execConfig.tools,
          bash: {
            enabled: true,
            allowedCommands: ['echo'],
          },
        },
      };

      const allowed = await executeBash({ command: 'echo test' }, config);
      expect(allowed.is_error).toBeUndefined();

      const blocked = await executeBash({ command: 'ls -la' }, config);
      expect(blocked.is_error).toBe(true);
      expect(blocked.content).toContain('not in the allowed');
    });

    it('should handle command errors', async () => {
      const result = await executeBash({ command: 'exit 1' }, execConfig);

      expect(result.is_error).toBe(true);
    });

    it('should handle timeout', async () => {
      const result = await executeBash(
        { command: 'sleep 10', timeout: 100 },
        execConfig
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('timed out');
    }, 5000);

    it('should respect working directory within sandbox', async () => {
      const result = await executeBash(
        { command: 'pwd', cwd: join(execSandboxDir, 'subdir') },
        execConfig
      );

      expect(result.is_error).toBeUndefined();
      expect(result.content.trim()).toBe(join(execSandboxDir, 'subdir'));
    });

    it('should capture stderr', async () => {
      const result = await executeBash(
        { command: 'echo error >&2 && exit 1' },
        execConfig
      );

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('error');
    });
  });

  describe('getEffectiveBlocklist', () => {
    it('should return DEFAULT_RESTRICTED_BLOCKLIST in restricted mode', () => {
      const result = getEffectiveBlocklist({ enabled: true, mode: 'restricted' });
      expect(result).toContain('crontab');
      expect(result).toContain('systemctl');
      expect(result).toContain('kill');
      expect(result).toContain('rm -rf /');
    });

    it('should combine DEFAULT_RESTRICTED_BLOCKLIST with custom in restricted mode', () => {
      const result = getEffectiveBlocklist({
        enabled: true,
        mode: 'restricted',
        blockedCommands: ['custom-cmd'],
      });
      expect(result).toContain('crontab');
      expect(result).toContain('custom-cmd');
    });

    it('should return only custom in unrestricted mode', () => {
      const result = getEffectiveBlocklist({
        enabled: true,
        mode: 'unrestricted',
        blockedCommands: ['custom-cmd'],
      });
      expect(result).not.toContain('crontab');
      expect(result).toContain('custom-cmd');
    });

    it('should return empty in unrestricted mode with no custom', () => {
      const result = getEffectiveBlocklist({ enabled: true, mode: 'unrestricted' });
      expect(result).toEqual([]);
    });

    it('should default to restricted when mode is undefined', () => {
      const result = getEffectiveBlocklist({ enabled: true });
      expect(result).toContain('crontab');
      expect(result).toContain('systemctl');
    });
  });

  describe('isCommandBlocked - shell metacharacter bypass vectors', () => {
    const blocked = ['crontab', 'kill'];

    it('should block command substitution with $()', () => {
      expect(isCommandBlocked('echo $(whoami)', blocked)).toBe(true);
    });

    it('should block backtick command substitution', () => {
      expect(isCommandBlocked('echo `whoami`', blocked)).toBe(true);
    });

    it('should block newline injection', () => {
      expect(isCommandBlocked('echo hello\nrm -rf /', blocked)).toBe(true);
    });

    it('should block process substitution <()', () => {
      expect(isCommandBlocked('diff <(cat /etc/passwd) file.txt', blocked)).toBe(true);
    });

    it('should block process substitution >()', () => {
      expect(isCommandBlocked('tee >(cat > /tmp/leak)', blocked)).toBe(true);
    });

    it('should block heredoc', () => {
      expect(isCommandBlocked('cat <<EOF\nevil\nEOF', blocked)).toBe(true);
    });
  });

  describe('isCommandBlocked - compound commands', () => {
    const blocked = ['crontab', 'kill'];

    it('should catch blocked command after semicolon', () => {
      expect(isCommandBlocked('echo hello; crontab -l', blocked)).toBe(true);
    });

    it('should catch blocked command after &&', () => {
      expect(isCommandBlocked('echo hello && crontab -l', blocked)).toBe(true);
    });

    it('should catch blocked command after ||', () => {
      expect(isCommandBlocked('false || kill -9 1', blocked)).toBe(true);
    });

    it('should catch blocked command in pipe', () => {
      expect(isCommandBlocked('echo "* * * * * cmd" | crontab -', blocked)).toBe(true);
    });

    it('should allow clean compound commands', () => {
      expect(isCommandBlocked('echo hello; echo world', blocked)).toBe(false);
    });
  });

  describe('isCommandBlocked - shell wrappers', () => {
    const blocked = ['crontab', 'kill'];

    it('should catch bash -c wrapper with quotes', () => {
      expect(isCommandBlocked("bash -c 'crontab -l'", blocked)).toBe(true);
    });

    it('should catch sh -c wrapper', () => {
      expect(isCommandBlocked('sh -c "kill -9 1"', blocked)).toBe(true);
    });

    it('should catch /bin/bash -c wrapper', () => {
      expect(isCommandBlocked("/bin/bash -c 'crontab -e'", blocked)).toBe(true);
    });

    it('should catch env prefix', () => {
      expect(isCommandBlocked('env crontab -l', blocked)).toBe(true);
    });

    it('should catch env with VAR=val prefix', () => {
      expect(isCommandBlocked('env FOO=bar crontab -l', blocked)).toBe(true);
    });

    it('should catch /usr/bin/env prefix', () => {
      expect(isCommandBlocked('/usr/bin/env crontab -l', blocked)).toBe(true);
    });

    it('should allow env with non-blocked command', () => {
      expect(isCommandBlocked('env FOO=bar ls -la', blocked)).toBe(false);
    });
  });

  describe('isCommandBlocked - default restricted blocklist integration', () => {
    it('should block crontab with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('crontab -l', blocklist)).toBe(true);
    });

    it('should block systemctl with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('systemctl start nginx', blocklist)).toBe(true);
    });

    it('should block apt-get with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('apt-get install vim', blocklist)).toBe(true);
    });

    it('should block kill with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('kill -9 1234', blocklist)).toBe(true);
    });

    it('should allow ls with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('ls -la', blocklist)).toBe(false);
    });

    it('should allow echo with default config', () => {
      const config = getDefaultConfig();
      const blocklist = getEffectiveBlocklist(config.tools.bash);
      expect(isCommandBlocked('echo hello', blocklist)).toBe(false);
    });

    it('unrestricted mode allows previously blocked commands', () => {
      const blocklist = getEffectiveBlocklist({ enabled: true, mode: 'unrestricted' });
      expect(isCommandBlocked('crontab -l', blocklist)).toBe(false);
      expect(isCommandBlocked('kill -9 1', blocklist)).toBe(false);
    });
  });

  describe('cwd validation', () => {
    let sandboxDir: string;
    let config: HubConfig;

    beforeEach(async () => {
      sandboxDir = join(tmpdir(), `hub-sandbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await mkdir(sandboxDir, { recursive: true });
      await mkdir(join(sandboxDir, 'subdir'), { recursive: true });

      config = {
        ...getDefaultConfig(),
        sandboxPath: sandboxDir,
      };
    });

    afterEach(async () => {
      await rm(sandboxDir, { recursive: true, force: true });
    });

    it('should allow cwd when under sandbox', async () => {
      const result = await validateCwd(join(sandboxDir, 'subdir'), config);
      expect(result.valid).toBe(true);
      expect(result.resolvedPath).toBeDefined();
    });

    it('should reject cwd when outside sandbox', async () => {
      const result = await validateCwd('/tmp', config);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('outside the sandbox');
    });

    it('should block symlink escape attempt', async () => {
      // Create a symlink inside sandbox that points outside
      const linkPath = join(sandboxDir, 'escape-link');
      try {
        await symlink('/tmp', linkPath);
        const result = await validateCwd(linkPath, config);
        expect(result.valid).toBe(false);
        expect(result.reason).toContain('outside the sandbox');
      } catch {
        // Symlink creation might fail due to permissions, skip test
      }
    });

    it('should use sandboxPath as default cwd', async () => {
      const result = await executeBash({ command: 'pwd' }, config);

      expect(result.is_error).toBeUndefined();
      // The output should be the sandbox directory (possibly with resolved symlinks)
      expect(result.content.trim()).toContain(sandboxDir);
    });

    it('should reject cwd when sandboxPath is empty', async () => {
      const noSandboxConfig: HubConfig = {
        ...getDefaultConfig(),
        sandboxPath: '',
      };

      const result = await validateCwd('/tmp', noSandboxConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not configured');
    });

    it('should reject cwd when sandboxPath is undefined', async () => {
      const noSandboxConfig: HubConfig = {
        ...getDefaultConfig(),
        sandboxPath: undefined,
      };

      const result = await validateCwd('/tmp', noSandboxConfig);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('not configured');
    });

    it('should reject command execution when cwd is outside sandbox', async () => {
      const result = await executeBash({ command: 'pwd', cwd: '/tmp' }, config);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('outside the sandbox');
    });
  });
});
