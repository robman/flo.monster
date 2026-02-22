/**
 * Tests for hub-files tool
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeHubFiles,
  validateFilePath,
  unpackFilesToDisk,
  packFilesFromDisk,
  hubFilesToolDef,
} from '../tools/hub-files.js';

let testDir: string;

afterEach(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }
});

async function createTestDir(): Promise<string> {
  // Ensure the path ends with / for proper containment checks
  // (validateFilePath uses resolved.startsWith(filesRoot))
  testDir = await mkdtemp(join(tmpdir(), 'hub-files-test-'));
  testDir = testDir.endsWith('/') ? testDir : testDir + '/';
  return testDir;
}

// ---------------------------------------------------------------------------
// validateFilePath
// ---------------------------------------------------------------------------
describe('validateFilePath', () => {
  it('returns resolved path for valid relative path', async () => {
    const root = await createTestDir();
    // Create the file so realpath can resolve it
    await mkdir(join(root, 'foo'), { recursive: true });
    await writeFile(join(root, 'foo/bar.txt'), '', 'utf-8');
    const result = await validateFilePath('foo/bar.txt', root);
    expect(result).toBe(join(root, 'foo/bar.txt'));
  });

  it('returns null for empty path', async () => {
    const root = await createTestDir();
    expect(await validateFilePath('', root)).toBeNull();
  });

  it('returns null for path with null bytes', async () => {
    const root = await createTestDir();
    expect(await validateFilePath('foo\0bar.txt', root)).toBeNull();
  });

  it('returns null for path exceeding 512 characters', async () => {
    const root = await createTestDir();
    const longPath = 'a'.repeat(513);
    expect(await validateFilePath(longPath, root)).toBeNull();
  });

  it('returns null for path traversal (../../etc/passwd)', async () => {
    const root = await createTestDir();
    expect(await validateFilePath('../../etc/passwd', root)).toBeNull();
  });

  it('returns null for absolute path outside filesRoot', async () => {
    const root = await createTestDir();
    expect(await validateFilePath('/etc/passwd', root)).toBeNull();
  });

  it('returns resolved path for non-existent file within root (for writes)', async () => {
    const root = await createTestDir();
    const result = await validateFilePath('newfile.txt', root);
    expect(result).toBe(join(root, 'newfile.txt'));
  });

  it('returns null for symlink pointing outside filesRoot', async () => {
    const root = await createTestDir();
    // Create a symlink inside root that points outside
    await symlink('/tmp', join(root, 'escape-link'));
    const result = await validateFilePath('escape-link', root);
    expect(result).toBeNull();
  });

  it('returns null for symlink to file outside filesRoot', async () => {
    const root = await createTestDir();
    // Create a file outside root to link to
    const outsideDir = await mkdtemp(join(tmpdir(), 'hub-files-outside-'));
    try {
      await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf-8');
      await symlink(join(outsideDir, 'secret.txt'), join(root, 'innocent.txt'));
      const result = await validateFilePath('innocent.txt', root);
      expect(result).toBeNull();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows symlinks that resolve within filesRoot', async () => {
    const root = await createTestDir();
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real/file.txt'), 'content', 'utf-8');
    await symlink(join(root, 'real/file.txt'), join(root, 'link.txt'));
    const result = await validateFilePath('link.txt', root);
    // Should resolve to the real path within root
    expect(result).toBe(join(root, 'real/file.txt'));
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — read_file
// ---------------------------------------------------------------------------
describe('executeHubFiles — read_file', () => {
  it('reads existing file', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'hello.txt'), 'hello world', 'utf-8');

    const result = await executeHubFiles({ action: 'read_file', path: 'hello.txt' }, root);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe('hello world');
  });

  it('returns error for missing file', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'read_file', path: 'missing.txt' }, root);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('returns error when path is missing', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'read_file' }, root);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Missing required parameter: path');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — write_file
// ---------------------------------------------------------------------------
describe('executeHubFiles — write_file', () => {
  it('creates file and parent directories', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'write_file', path: 'sub/dir/test.txt', content: 'contents' },
      root,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('File written');

    const on_disk = await readFile(join(root, 'sub/dir/test.txt'), 'utf-8');
    expect(on_disk).toBe('contents');
  });

  it('overwrites existing file', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'existing.txt'), 'old', 'utf-8');

    const result = await executeHubFiles(
      { action: 'write_file', path: 'existing.txt', content: 'new' },
      root,
    );
    expect(result.is_error).toBeUndefined();

    const on_disk = await readFile(join(root, 'existing.txt'), 'utf-8');
    expect(on_disk).toBe('new');
  });

  it('returns error when path is missing', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'write_file', content: 'stuff' },
      root,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Missing required parameter: path');
  });

  it('returns error when content is missing', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'write_file', path: 'file.txt' },
      root,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Missing required parameter: content');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — list_files
// ---------------------------------------------------------------------------
describe('executeHubFiles — list_files', () => {
  it('lists all files recursively', async () => {
    const root = await createTestDir();
    await mkdir(join(root, 'a/b'), { recursive: true });
    await writeFile(join(root, 'top.txt'), '', 'utf-8');
    await writeFile(join(root, 'a/mid.txt'), '', 'utf-8');
    await writeFile(join(root, 'a/b/deep.txt'), '', 'utf-8');

    const result = await executeHubFiles({ action: 'list_files' }, root);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('top.txt');
    expect(result.content).toContain('a/mid.txt');
    expect(result.content).toContain('a/b/deep.txt');
  });

  it('filters results with pattern', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'readme.md'), '', 'utf-8');
    await writeFile(join(root, 'code.ts'), '', 'utf-8');

    const result = await executeHubFiles(
      { action: 'list_files', pattern: '*.md' },
      root,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('readme.md');
    expect(result.content).not.toContain('code.ts');
  });

  it('returns "(no files)" for empty directory', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'list_files' }, root);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe('(no files)');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — delete_file
// ---------------------------------------------------------------------------
describe('executeHubFiles — delete_file', () => {
  it('deletes existing file', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'doomed.txt'), 'bye', 'utf-8');

    const result = await executeHubFiles(
      { action: 'delete_file', path: 'doomed.txt' },
      root,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('File deleted');

    // Verify file is gone
    await expect(readFile(join(root, 'doomed.txt'))).rejects.toThrow();
  });

  it('returns error for missing file', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'delete_file', path: 'ghost.txt' },
      root,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('File not found');
  });

  it('returns error when path is missing', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'delete_file' }, root);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Missing required parameter: path');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — mkdir
// ---------------------------------------------------------------------------
describe('executeHubFiles — mkdir', () => {
  it('creates nested directories', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'mkdir', path: 'a/b/c' },
      root,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('Directory created');

    // Verify by writing a file inside
    await writeFile(join(root, 'a/b/c/proof.txt'), 'ok', 'utf-8');
    const on_disk = await readFile(join(root, 'a/b/c/proof.txt'), 'utf-8');
    expect(on_disk).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — list_dir
// ---------------------------------------------------------------------------
describe('executeHubFiles — list_dir', () => {
  it('lists directory contents with type indicators', async () => {
    const root = await createTestDir();
    await mkdir(join(root, 'mydir'), { recursive: true });
    await mkdir(join(root, 'mydir/child'), { recursive: true });
    await writeFile(join(root, 'mydir/file.txt'), '', 'utf-8');

    const result = await executeHubFiles(
      { action: 'list_dir', path: 'mydir' },
      root,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('d child');
    expect(result.content).toContain('f file.txt');
  });

  it('lists root directory when path is omitted', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'root-file.txt'), '', 'utf-8');

    const result = await executeHubFiles({ action: 'list_dir' }, root);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain('f root-file.txt');
  });

  it('returns "(empty directory)" for empty directory', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'list_dir' }, root);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe('(empty directory)');
  });

  it('returns error for non-existent directory', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'list_dir', path: 'nope' },
      root,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Directory not found');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — frontmatter
// ---------------------------------------------------------------------------
describe('executeHubFiles — frontmatter', () => {
  it('extracts frontmatter from matching files', async () => {
    const root = await createTestDir();
    const md = '---\ntitle: Hello\ntags: test\n---\n\n# Body';
    await writeFile(join(root, 'post.md'), md, 'utf-8');

    const result = await executeHubFiles(
      { action: 'frontmatter', pattern: '*.md' },
      root,
    );
    expect(result.is_error).toBeUndefined();

    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('post.md');
    expect(parsed[0].frontmatter.title).toBe('Hello');
    expect(parsed[0].frontmatter.tags).toBe('test');
  });

  it('returns empty array when no files have frontmatter', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'plain.md'), '# No frontmatter here', 'utf-8');

    const result = await executeHubFiles(
      { action: 'frontmatter', pattern: '*.md' },
      root,
    );
    expect(result.is_error).toBeUndefined();

    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual([]);
  });

  it('returns error when pattern is missing', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles({ action: 'frontmatter' }, root);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Missing required parameter: pattern');
  });
});

// ---------------------------------------------------------------------------
// executeHubFiles — unknown action
// ---------------------------------------------------------------------------
describe('executeHubFiles — unknown action', () => {
  it('returns error for unknown action', async () => {
    const root = await createTestDir();

    const result = await executeHubFiles(
      { action: 'explode' as any },
      root,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain('Unknown files action');
  });
});

// ---------------------------------------------------------------------------
// unpackFilesToDisk
// ---------------------------------------------------------------------------
describe('unpackFilesToDisk', () => {
  it('unpacks UTF-8 files', async () => {
    const root = await createTestDir();

    await unpackFilesToDisk(
      [{ path: 'hello.txt', content: 'hello world', encoding: 'utf8' }],
      root,
    );

    const on_disk = await readFile(join(root, 'hello.txt'), 'utf-8');
    expect(on_disk).toBe('hello world');
  });

  it('unpacks base64 files', async () => {
    const root = await createTestDir();
    const originalContent = 'binary-ish content \x00\x01\x02';
    const b64 = Buffer.from(originalContent).toString('base64');

    await unpackFilesToDisk(
      [{ path: 'data.bin', content: b64, encoding: 'base64' }],
      root,
    );

    const on_disk = await readFile(join(root, 'data.bin'));
    expect(on_disk.toString()).toBe(originalContent);
  });

  it('creates nested directories', async () => {
    const root = await createTestDir();

    await unpackFilesToDisk(
      [{ path: 'a/b/c/deep.txt', content: 'deep', encoding: 'utf8' }],
      root,
    );

    const on_disk = await readFile(join(root, 'a/b/c/deep.txt'), 'utf-8');
    expect(on_disk).toBe('deep');
  });

  it('skips files with invalid paths (traversal)', async () => {
    const root = await createTestDir();

    await unpackFilesToDisk(
      [
        { path: '../../etc/evil.txt', content: 'evil', encoding: 'utf8' },
        { path: 'good.txt', content: 'good', encoding: 'utf8' },
      ],
      root,
    );

    // The traversal file should NOT exist
    const good = await readFile(join(root, 'good.txt'), 'utf-8');
    expect(good).toBe('good');

    // The evil file should not have been written anywhere in root
    const result = await executeHubFiles({ action: 'list_files' }, root);
    expect(result.content).toBe('good.txt');
  });

  it('handles mixed encodings', async () => {
    const root = await createTestDir();
    const binaryContent = '\x89PNG\r\n';
    const b64 = Buffer.from(binaryContent).toString('base64');

    await unpackFilesToDisk(
      [
        { path: 'text.txt', content: 'plain text', encoding: 'utf8' },
        { path: 'image.png', content: b64, encoding: 'base64' },
      ],
      root,
    );

    const text = await readFile(join(root, 'text.txt'), 'utf-8');
    expect(text).toBe('plain text');

    const binary = await readFile(join(root, 'image.png'));
    expect(binary.toString()).toBe(binaryContent);
  });
});

// ---------------------------------------------------------------------------
// hubFilesToolDef
// ---------------------------------------------------------------------------
describe('hubFilesToolDef', () => {
  it('has correct name', () => {
    expect(hubFilesToolDef.name).toBe('files');
  });

  it('has all 7 actions in enum', () => {
    const actionProp = hubFilesToolDef.input_schema.properties.action as {
      enum: string[];
    };
    expect(actionProp.enum).toEqual([
      'read_file',
      'write_file',
      'list_files',
      'delete_file',
      'mkdir',
      'list_dir',
      'frontmatter',
    ]);
    expect(actionProp.enum).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// packFilesFromDisk
// ---------------------------------------------------------------------------
describe('packFilesFromDisk', () => {
  it('packs text files with utf8 encoding', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'hello.txt'), 'hello world', 'utf-8');

    const files = await packFilesFromDisk(root);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('hello.txt');
    expect(files[0].content).toBe('hello world');
    expect(files[0].encoding).toBe('utf8');
  });

  it('packs binary files with base64 encoding', async () => {
    const root = await createTestDir();
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    await writeFile(join(root, 'image.png'), binaryContent);

    const files = await packFilesFromDisk(root);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('image.png');
    expect(files[0].encoding).toBe('base64');
    // Verify round-trip
    const decoded = Buffer.from(files[0].content, 'base64');
    expect(decoded).toEqual(binaryContent);
  });

  it('packs files from nested directories', async () => {
    const root = await createTestDir();
    await mkdir(join(root, 'sub/dir'), { recursive: true });
    await writeFile(join(root, 'top.txt'), 'top', 'utf-8');
    await writeFile(join(root, 'sub/mid.txt'), 'mid', 'utf-8');
    await writeFile(join(root, 'sub/dir/deep.txt'), 'deep', 'utf-8');

    const files = await packFilesFromDisk(root);
    expect(files).toHaveLength(3);
    const paths = files.map(f => f.path).sort();
    expect(paths).toEqual(['sub/dir/deep.txt', 'sub/mid.txt', 'top.txt']);
  });

  it('returns empty array for non-existent directory', async () => {
    const files = await packFilesFromDisk('/tmp/does-not-exist-' + Date.now());
    expect(files).toEqual([]);
  });

  it('returns empty array for empty directory', async () => {
    const root = await createTestDir();

    const files = await packFilesFromDisk(root);
    expect(files).toEqual([]);
  });

  it('handles mixed text and binary files', async () => {
    const root = await createTestDir();
    await writeFile(join(root, 'readme.md'), '# Hello', 'utf-8');
    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(root, 'icon.png'), pngData);

    const files = await packFilesFromDisk(root);
    expect(files).toHaveLength(2);

    const textFile = files.find(f => f.path === 'readme.md')!;
    expect(textFile.encoding).toBe('utf8');
    expect(textFile.content).toBe('# Hello');

    const binFile = files.find(f => f.path === 'icon.png')!;
    expect(binFile.encoding).toBe('base64');
  });

  it('round-trips with unpackFilesToDisk', async () => {
    const srcRoot = await createTestDir();
    await writeFile(join(srcRoot, 'file.txt'), 'round trip', 'utf-8');
    const binData = Buffer.from([1, 2, 3, 4, 5]);
    await writeFile(join(srcRoot, 'data.bin'), binData);

    const packed = await packFilesFromDisk(srcRoot);

    // Unpack to a different directory
    const destRoot = srcRoot.replace(/\/$/, '') + '-dest/';
    await mkdir(destRoot, { recursive: true });
    await unpackFilesToDisk(packed, destRoot);

    // Verify
    const textContent = await readFile(join(destRoot, 'file.txt'), 'utf-8');
    expect(textContent).toBe('round trip');
    const binContent = await readFile(join(destRoot, 'data.bin'));
    expect(binContent).toEqual(binData);
  });
});
