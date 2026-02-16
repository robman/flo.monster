/**
 * Shared path utilities for hub tools
 */

import { realpath } from 'node:fs/promises';
import { normalize, resolve, join, dirname } from 'node:path';
import type { HubConfig } from '../config.js';

/**
 * Check if a path matches a pattern (simple prefix matching)
 * Used for sandbox enforcement and path validation
 */
export function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalize(path);
  const normalizedPattern = normalize(pattern);

  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(normalizedPattern + '/')
  );
}

export interface SandboxValidationResult {
  valid: boolean;
  resolved: string;
  reason?: string;
}

/**
 * Resolve a path through symlinks, falling back to parent resolution or the
 * absolute path itself when the target does not yet exist.
 */
async function resolveSymlinks(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch {
    // Path doesn't exist yet, check parent directory
    const parentPath = dirname(absolutePath);
    try {
      const realParent = await realpath(parentPath);
      return join(realParent, absolutePath.slice(parentPath.length));
    } catch {
      // Parent doesn't exist either, use absolute path
      return absolutePath;
    }
  }
}

/**
 * Validate that a path is within the sandbox and allowed paths.
 *
 * This is the shared core of sandbox path validation used by both
 * the bash tool (validateCwd) and the filesystem tool (validatePath).
 *
 * @param inputPath - The path to validate (may be relative)
 * @param config - Hub configuration (provides sandboxPath)
 * @param basePath - Base path for resolving relative paths. If not provided,
 *                   uses config.sandboxPath (or cwd as last resort).
 */
export async function validateSandboxPath(
  inputPath: string,
  config: HubConfig,
  basePath?: string
): Promise<SandboxValidationResult> {
  const effectiveBase = basePath ?? config.sandboxPath ?? process.cwd();

  try {
    // Resolve to absolute path
    const absolutePath = resolve(effectiveBase, inputPath);

    // Resolve symlinks for the sandbox path
    let realSandboxPath: string;
    if (config.sandboxPath) {
      try {
        realSandboxPath = await realpath(config.sandboxPath);
      } catch {
        // Sandbox doesn't exist yet, use the configured path
        realSandboxPath = resolve(config.sandboxPath);
      }
    } else {
      realSandboxPath = resolve(effectiveBase);
    }

    // Resolve symlinks on the target path
    const resolvedPath = await resolveSymlinks(absolutePath);

    // Check if the resolved path is within the sandbox
    if (!matchesPattern(resolvedPath, realSandboxPath)) {
      return {
        valid: false,
        resolved: resolvedPath,
        reason: 'Path is outside the sandbox',
      };
    }

    return { valid: true, resolved: resolvedPath };
  } catch (error) {
    return {
      valid: false,
      resolved: '',
      reason: `Path validation error: ${(error as Error).message}`,
    };
  }
}
