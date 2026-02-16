/**
 * Shared process execution utilities for hub tools
 * Extracted from bash.ts and hook-executor.ts to deduplicate subprocess spawn patterns.
 */

import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

/**
 * Sanitized environment variables for agent subprocess execution.
 * Strips sensitive data while providing a usable shell environment.
 */
export const AGENT_ENV: Record<string, string> = {
  PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env.HOME || '/tmp',
  USER: process.env.USER || 'agent',
  SHELL: '/bin/sh',
  TERM: 'xterm-256color',
  LANG: process.env.LANG || 'en_US.UTF-8',
};

/**
 * Execute a command as a subprocess with timeout and process group management.
 *
 * Spawns the command via /usr/bin/sh, captures stdout/stderr, and kills
 * the entire process group on timeout (Unix) or the process directly (Windows).
 */
export function executeProcess(
  command: string,
  opts: { cwd: string; timeout: number; env?: Record<string, string>; runAsUser?: string }
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    // Wrap command for user isolation if runAsUser is configured
    let effectiveCommand = command;
    if (opts.runAsUser) {
      // Escape single quotes in command for safe embedding in sh -c '...'
      const escaped = command.replace(/'/g, "'\\''");
      effectiveCommand = `sudo -n -u ${opts.runAsUser} -- /usr/bin/sh -c '${escaped}'`;
    }

    const isWin = process.platform === 'win32';
    const proc = spawn(effectiveCommand, [], {
      cwd: opts.cwd,
      env: opts.env ?? AGENT_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: '/usr/bin/sh',
      detached: !isWin, // Create process group on Unix for proper cleanup
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      // Kill process group on Unix, direct kill on Windows
      if (!isWin && proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGKILL'); // Negative PID kills process group
        } catch {
          proc.kill('SIGKILL');
        }
      } else {
        proc.kill('SIGKILL');
      }
    }, opts.timeout);

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: -1,
        error: `Failed to execute command: ${error.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        resolve({
          stdout,
          stderr,
          exitCode: -1,
          error: `Command timed out after ${opts.timeout}ms`,
        });
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
      });
    });
  });
}
