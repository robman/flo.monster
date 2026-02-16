/**
 * Filesystem tool for file operations
 */

import { readFile, writeFile, readdir, mkdir, rm, stat, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { HubConfig } from '../config.js';
import { matchesPattern, validateSandboxPath } from '../utils/path-utils.js';

export interface FilesystemInput {
  action: 'read' | 'write' | 'list' | 'mkdir' | 'delete' | 'stat';
  path: string;
  content?: string;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export const filesystemToolDef = {
  name: 'filesystem',
  description: 'File system operations',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: ['read', 'write', 'list', 'mkdir', 'delete', 'stat'] as const,
        description: 'The operation to perform',
      },
      path: { type: 'string' as const, description: 'The file or directory path' },
      content: { type: 'string' as const, description: 'Content for write operation' },
    },
    required: ['action', 'path'] as const,
  },
};

/**
 * Validate that a path is allowed by the configuration
 * This also prevents symlink traversal attacks
 */
export async function validatePath(
  path: string,
  config: HubConfig
): Promise<{ valid: boolean; reason?: string; resolvedPath?: string }> {
  try {
    // Resolve to absolute path - relative paths are relative to sandboxPath, not cwd
    const basePath = config.sandboxPath || process.cwd();
    const absolutePath = resolve(basePath, path);

    // Check blocked paths first (before following symlinks)
    const blockedPaths = config.tools.filesystem.blockedPaths ?? [];
    for (const blocked of blockedPaths) {
      if (matchesPattern(absolutePath, blocked)) {
        return { valid: false, reason: 'Path is blocked by security policy' };
      }
    }

    // Block special system paths regardless of config
    const systemPaths = ['/dev', '/proc', '/sys'];
    for (const sysPath of systemPaths) {
      if (matchesPattern(absolutePath, sysPath)) {
        return { valid: false, reason: 'Access to system paths is blocked' };
      }
    }

    // Use shared sandbox validation for symlink resolution
    // Pass a dummy config with no sandbox for pure symlink resolution
    const sandboxResult = await validateSandboxPath(path, config, basePath);
    const realPath = sandboxResult.resolved;

    // Check blocked paths again with resolved path (after following symlinks)
    for (const blocked of blockedPaths) {
      if (matchesPattern(realPath, blocked)) {
        return { valid: false, reason: 'Path resolves to a blocked location' };
      }
    }

    // Check allowed paths (auto-include sandboxPath if configured)
    const allowedPaths = [...config.tools.filesystem.allowedPaths];
    if (config.sandboxPath && config.sandboxPath.length > 0) {
      allowedPaths.push(config.sandboxPath);
    }
    let allowed = false;
    for (const allowedPath of allowedPaths) {
      if (matchesPattern(realPath, allowedPath)) {
        allowed = true;
        break;
      }
    }

    if (!allowed) {
      return { valid: false, reason: 'Path is not in allowed paths list' };
    }

    return { valid: true, resolvedPath: realPath };
  } catch (error) {
    return { valid: false, reason: `Path validation error: ${(error as Error).message}` };
  }
}

/**
 * Execute a filesystem operation
 */
export async function executeFilesystem(
  input: FilesystemInput,
  config: HubConfig
): Promise<ToolResult> {
  // Check if filesystem tool is enabled
  if (!config.tools.filesystem.enabled) {
    return {
      content: 'Filesystem tool is disabled',
      is_error: true,
    };
  }

  // Validate path
  const validation = await validatePath(input.path, config);
  if (!validation.valid) {
    return {
      content: validation.reason ?? 'Invalid path',
      is_error: true,
    };
  }

  const resolvedPath = validation.resolvedPath!;

  try {
    switch (input.action) {
      case 'read': {
        const content = await readFile(resolvedPath, 'utf-8');
        return { content };
      }

      case 'write': {
        if (input.content === undefined) {
          return { content: 'Content is required for write operation', is_error: true };
        }
        // Ensure parent directory exists
        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, input.content, 'utf-8');
        return { content: `Successfully wrote ${input.content.length} bytes to ${input.path}` };
      }

      case 'list': {
        const entries = await readdir(resolvedPath, { withFileTypes: true });
        const listing = entries.map((entry) => {
          const type = entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f';
          return `${type} ${entry.name}`;
        });
        return { content: listing.join('\n') || '(empty directory)' };
      }

      case 'mkdir': {
        await mkdir(resolvedPath, { recursive: true });
        return { content: `Created directory: ${input.path}` };
      }

      case 'delete': {
        const stats = await lstat(resolvedPath);
        if (stats.isDirectory()) {
          await rm(resolvedPath, { recursive: true });
          return { content: `Deleted directory: ${input.path}` };
        } else {
          await rm(resolvedPath);
          return { content: `Deleted file: ${input.path}` };
        }
      }

      case 'stat': {
        const stats = await stat(resolvedPath);
        const info = {
          type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
          size: stats.size,
          modified: stats.mtime.toISOString(),
          created: stats.birthtime.toISOString(),
          mode: stats.mode.toString(8),
        };
        return { content: JSON.stringify(info, null, 2) };
      }

      default:
        return { content: `Unknown action: ${input.action}`, is_error: true };
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { content: `Path not found: ${input.path}`, is_error: true };
    }
    if (err.code === 'EACCES') {
      return { content: `Permission denied: ${input.path}`, is_error: true };
    }
    return { content: `Error: ${err.message}`, is_error: true };
  }
}
