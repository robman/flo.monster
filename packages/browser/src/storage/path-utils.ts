/**
 * Path normalization and validation utilities for browser storage.
 * These utilities ensure safe path handling without parent directory traversal.
 */

/**
 * Validate a path, throwing if it contains dangerous patterns.
 * @param path - The path to validate
 * @throws Error if path contains null bytes or parent directory references
 */
export function validatePath(path: string): void {
  if (path.includes('\0')) {
    throw new Error('Invalid path: null bytes are not allowed');
  }

  // Check for '..' as a path segment
  const segments = path.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new Error('Invalid path: parent directory references (..) are not allowed');
    }
  }
}

/**
 * Normalize a path by removing redundant segments and validating safety.
 * @param path - The path to normalize
 * @returns Normalized path without leading/trailing slashes
 * @throws Error if path contains null bytes or parent directory references
 */
export function normalizePath(path: string): string {
  // Validate first
  validatePath(path);

  // Split on slashes, filter out empty segments and '.' segments
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');

  // Join with single slashes
  return segments.join('/');
}

/**
 * Get the parent directory path from a given path.
 * @param path - The path to get the parent of
 * @returns Parent directory path, or '' for root-level paths
 */
export function getParentPath(path: string): string {
  const normalized = normalizePath(path);
  const lastSlash = normalized.lastIndexOf('/');

  if (lastSlash === -1) {
    // No slash means root-level file
    return '';
  }

  return normalized.substring(0, lastSlash);
}

/**
 * Get the filename (last segment) from a path.
 * @param path - The path to extract the filename from
 * @returns The filename, or '' for empty/root paths
 */
export function getFileName(path: string): string {
  const normalized = normalizePath(path);

  if (normalized === '') {
    return '';
  }

  const lastSlash = normalized.lastIndexOf('/');

  if (lastSlash === -1) {
    return normalized;
  }

  return normalized.substring(lastSlash + 1);
}
