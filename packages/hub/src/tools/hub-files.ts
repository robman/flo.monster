/**
 * Hub-side file tool for agent file operations.
 * Files stored under ~/.flo-monster/agents/{hubAgentId}/files/
 */

import { readFile, writeFile, readdir, mkdir, rm, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, join, extname } from 'node:path';
import type { ToolDef, ToolResult } from './index.js';
import type { SerializedFile } from '@flo-monster/core';

export interface HubFilesInput {
  action: 'read_file' | 'write_file' | 'list_files' | 'delete_file' | 'mkdir' | 'list_dir' | 'frontmatter';
  path?: string;
  content?: string;
  pattern?: string;
}

export const hubFilesToolDef: ToolDef = {
  name: 'files',
  description: 'Read, write, list, and manage files in the agent workspace. Supports frontmatter extraction from markdown files.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['read_file', 'write_file', 'list_files', 'delete_file', 'mkdir', 'list_dir', 'frontmatter'],
        description: 'File operation to perform',
      },
      path: { type: 'string', description: 'File or directory path (relative to agent workspace)' },
      content: { type: 'string', description: 'Content for write_file' },
      pattern: { type: 'string', description: 'Glob pattern for list_files/frontmatter (e.g. "*.md")' },
    },
    required: ['action'] as const,
  },
};

/**
 * Validate a file path within the agent's files root.
 * Returns the resolved absolute path, or null if invalid.
 * Resolves symlinks to prevent symlink traversal attacks.
 */
export async function validateFilePath(path: string, filesRoot: string): Promise<string | null> {
  if (!path) return null;

  // Block null bytes
  if (path.includes('\0')) return null;

  // Block excessive length
  if (path.length > 512) return null;

  // Normalize filesRoot to end with / to prevent prefix collisions
  // e.g. /tmp/abc should not match /tmp/abcevil
  const normalizedRoot = filesRoot.endsWith('/') ? filesRoot : filesRoot + '/';

  // Resolve the path relative to filesRoot
  const resolved = resolve(filesRoot, path);

  // Ensure it stays within filesRoot (prevent traversal)
  if (!resolved.startsWith(normalizedRoot) && resolved !== normalizedRoot.slice(0, -1)) return null;

  // Resolve symlinks to prevent traversal via symlink
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(normalizedRoot) && real !== normalizedRoot.slice(0, -1)) return null;
    return real;
  } catch (err) {
    // Path doesn't exist yet — validate parent directory
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const parentReal = await realpath(dirname(resolved));
        const parentNorm = parentReal.endsWith('/') ? parentReal : parentReal + '/';
        if (!parentNorm.startsWith(normalizedRoot) && parentReal !== normalizedRoot.slice(0, -1)) return null;
      } catch {
        // Parent doesn't exist either — path is within sandbox (will be created by mkdir)
      }
      return resolved;
    }
    return null;
  }
}

/**
 * Simple glob matching: supports * as wildcard
 */
function simpleGlobMatch(pattern: string, str: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexStr = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + regexStr + '$').test(str);
}

/**
 * Parse YAML-like frontmatter from text content.
 * Returns key-value pairs from frontmatter between --- delimiters.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const result: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) result[key] = value;
    }
  }
  return result;
}

/**
 * Recursively list all files under a directory.
 */
async function listAllFiles(dir: string, root: string): Promise<string[]> {
  const files: string[] = [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await listAllFiles(fullPath, root);
      files.push(...subFiles);
    } else {
      // Return relative path from root
      files.push(relative(root, fullPath));
    }
  }

  return files;
}

/**
 * Execute a hub files operation.
 */
export async function executeHubFiles(
  input: HubFilesInput,
  filesRoot: string,
): Promise<ToolResult> {
  // Ensure filesRoot exists
  await mkdir(filesRoot, { recursive: true });

  switch (input.action) {
    case 'read_file': {
      if (!input.path) {
        return { content: 'Missing required parameter: path', is_error: true };
      }
      const resolved = await validateFilePath(input.path, filesRoot);
      if (!resolved) {
        return { content: 'Invalid file path', is_error: true };
      }
      try {
        const data = await readFile(resolved, 'utf-8');
        return { content: data };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: `File not found: ${input.path}`, is_error: true };
        }
        return { content: `Read error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'write_file': {
      if (!input.path) {
        return { content: 'Missing required parameter: path', is_error: true };
      }
      if (input.content === undefined) {
        return { content: 'Missing required parameter: content', is_error: true };
      }
      const resolved = await validateFilePath(input.path, filesRoot);
      if (!resolved) {
        return { content: 'Invalid file path', is_error: true };
      }
      try {
        await mkdir(dirname(resolved), { recursive: true });
        await writeFile(resolved, input.content, 'utf-8');
        return { content: `File written: ${input.path}` };
      } catch (err) {
        return { content: `Write error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'list_files': {
      try {
        const allFiles = await listAllFiles(filesRoot, filesRoot);
        if (input.pattern) {
          const filtered = allFiles.filter(f => simpleGlobMatch(input.pattern!, f) || simpleGlobMatch(input.pattern!, f.split('/').pop()!));
          return { content: filtered.length > 0 ? filtered.join('\n') : '(no files match pattern)' };
        }
        return { content: allFiles.length > 0 ? allFiles.join('\n') : '(no files)' };
      } catch (err) {
        return { content: `List error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'delete_file': {
      if (!input.path) {
        return { content: 'Missing required parameter: path', is_error: true };
      }
      const resolved = await validateFilePath(input.path, filesRoot);
      if (!resolved) {
        return { content: 'Invalid file path', is_error: true };
      }
      try {
        await rm(resolved);
        return { content: `File deleted: ${input.path}` };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: `File not found: ${input.path}`, is_error: true };
        }
        return { content: `Delete error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'mkdir': {
      if (!input.path) {
        return { content: 'Missing required parameter: path', is_error: true };
      }
      const resolved = await validateFilePath(input.path, filesRoot);
      if (!resolved) {
        return { content: 'Invalid file path', is_error: true };
      }
      try {
        await mkdir(resolved, { recursive: true });
        return { content: `Directory created: ${input.path}` };
      } catch (err) {
        return { content: `Mkdir error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'list_dir': {
      const dirPath = input.path ? await validateFilePath(input.path, filesRoot) : filesRoot;
      if (!dirPath) {
        return { content: 'Invalid directory path', is_error: true };
      }
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const listing = entries.map(e => {
          const type = e.isDirectory() ? 'd' : 'f';
          return `${type} ${e.name}`;
        });
        return { content: listing.length > 0 ? listing.join('\n') : '(empty directory)' };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: `Directory not found: ${input.path || '/'}`, is_error: true };
        }
        return { content: `List dir error: ${(err as Error).message}`, is_error: true };
      }
    }

    case 'frontmatter': {
      if (!input.pattern) {
        return { content: 'Missing required parameter: pattern', is_error: true };
      }
      try {
        const allFiles = await listAllFiles(filesRoot, filesRoot);
        const matching = allFiles.filter(f =>
          simpleGlobMatch(input.pattern!, f) || simpleGlobMatch(input.pattern!, f.split('/').pop()!)
        );

        const results: Array<{ path: string; frontmatter: Record<string, string> }> = [];
        for (const filePath of matching) {
          try {
            const fullPath = join(filesRoot, filePath);
            const fileContent = await readFile(fullPath, 'utf-8');
            const fm = parseFrontmatter(fileContent);
            if (fm) {
              results.push({ path: filePath, frontmatter: fm });
            }
          } catch {
            // Skip unreadable files
          }
        }

        return { content: JSON.stringify(results) };
      } catch (err) {
        return { content: `Frontmatter error: ${(err as Error).message}`, is_error: true };
      }
    }

    default:
      return { content: `Unknown files action: ${(input as any).action}`, is_error: true };
  }
}

/**
 * Unpack serialized files from a session to disk.
 */
export async function unpackFilesToDisk(
  files: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }>,
  filesRoot: string,
): Promise<void> {
  await mkdir(filesRoot, { recursive: true });

  for (const file of files) {
    const resolved = await validateFilePath(file.path, filesRoot);
    if (!resolved) continue; // Skip invalid paths

    await mkdir(dirname(resolved), { recursive: true });

    if (file.encoding === 'base64') {
      const buffer = Buffer.from(file.content, 'base64');
      await writeFile(resolved, buffer);
    } else {
      await writeFile(resolved, file.content, 'utf-8');
    }
  }
}

/**
 * Binary file extensions that should be encoded as base64 when packing.
 */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.bin'
]);

/**
 * Pack files from disk into SerializedFile[].
 * Reverse of unpackFilesToDisk — reads all files under filesRoot
 * and returns them as serialized file objects.
 */
export async function packFilesFromDisk(filesRoot: string): Promise<SerializedFile[]> {
  const files: SerializedFile[] = [];
  let paths: string[];
  try {
    paths = await listAllFiles(filesRoot, filesRoot);
  } catch {
    return files; // No files directory
  }
  for (const relPath of paths) {
    const fullPath = join(filesRoot, relPath);
    const ext = extname(relPath).toLowerCase();
    const isBinary = BINARY_EXTENSIONS.has(ext);
    if (isBinary) {
      const buf = await readFile(fullPath);
      files.push({ path: relPath, content: buf.toString('base64'), encoding: 'base64' });
    } else {
      const text = await readFile(fullPath, 'utf-8');
      files.push({ path: relPath, content: text, encoding: 'utf8' });
    }
  }
  return files;
}
