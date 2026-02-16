/**
 * Tests for SessionHandler
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionHandler, type SessionRestoreOptions } from '../session-handler.js';
import { HubSkillManager } from '../skill-manager.js';
import type {
  SerializedSession,
  AgentConfig,
  StoredSkill,
  SkillDependency,
  ExtensionDependency,
  SerializedFile,
} from '@flo-monster/core';

describe('SessionHandler', () => {
  let testDir: string;
  let filesDir: string;
  let skillManager: HubSkillManager;
  let handler: SessionHandler;

  const mockConfig: AgentConfig = {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-20250514',
    tools: [],
    maxTokens: 4096,
  };

  const createMockSession = (overrides?: Partial<SerializedSession>): SerializedSession => ({
    version: 1,
    agentId: 'agent-123',
    config: mockConfig,
    conversation: [],
    storage: {},
    metadata: {
      createdAt: 1000,
      serializedAt: 2000,
      totalTokens: 100,
      totalCost: 0.01,
    },
    ...overrides,
  });

  const createStoredSkill = (name: string): StoredSkill => ({
    name,
    manifest: {
      name,
      description: `Test skill: ${name}`,
    },
    instructions: `Instructions for ${name} with $ARGUMENTS`,
    source: { type: 'local' },
    installedAt: Date.now(),
  });

  beforeEach(async () => {
    testDir = join(tmpdir(), `session-handler-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    filesDir = join(testDir, 'files');
    await mkdir(filesDir, { recursive: true });

    skillManager = new HubSkillManager();
    handler = new SessionHandler(skillManager, { filesDir, skipBrowserOnly: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });

    // Clean up any skills we installed
    for (const skill of skillManager.listSkills()) {
      if (skill.name.startsWith('test-')) {
        skillManager.remove(skill.name);
      }
    }
  });

  describe('restoreSession', () => {
    it('migrates v1 to v2', async () => {
      const v1Session = createMockSession({ version: 1 });

      const result = await handler.restoreSession(v1Session);

      expect(result.success).toBe(true);
      expect(result.session.version).toBe(2);
      expect(result.session.dependencies).toBeDefined();
      expect(result.session.dependencies?.skills).toEqual([]);
      expect(result.session.dependencies?.extensions).toEqual([]);
    });

    it('warns about DOM state', async () => {
      const session = createMockSession({
        version: 2,
        domState: {
          viewportHtml: '<div>test</div>',
          listeners: [],
          capturedAt: Date.now(),
        },
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('DOM state ignored - hub does not support DOM rendering');
    });

    it('resolves skills from local registry', async () => {
      // Pre-install a skill
      const skillContent = `---
name: test-preinstalled
description: Pre-installed skill
---
Do the thing`;
      skillManager.install(skillContent);

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-preinstalled',
            source: { type: 'local' },
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Clean up
      skillManager.remove('test-preinstalled');
    });

    it('installs local skill from inline when not found', async () => {
      const inlineSkill = createStoredSkill('test-inline-skill');

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-inline-skill',
            source: { type: 'local' },
            inline: inlineSkill,
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      // Local skills with inline are installed directly (no fallback warning needed)
      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(skillManager.hasSkill('test-inline-skill')).toBe(true);

      // Clean up
      skillManager.remove('test-inline-skill');
    });

    it('uses inline fallback when builtin skill not found in hub', async () => {
      const inlineSkill = createStoredSkill('test-builtin-fallback');

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-builtin-fallback',
            source: { type: 'builtin' },
            inline: inlineSkill,
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Skill "test-builtin-fallback" resolved from inline fallback');
      expect(skillManager.hasSkill('test-builtin-fallback')).toBe(true);

      // Clean up
      skillManager.remove('test-builtin-fallback');
    });

    it('errors on missing skill without fallback', async () => {
      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'nonexistent-skill',
            source: { type: 'local' },
            // No inline fallback
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('nonexistent-skill'))).toBe(true);
    });

    it('skips browser-only extensions with warning when skipBrowserOnly is true', async () => {
      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [],
          extensions: [{
            id: 'browser-ext',
            source: { type: 'builtin' },
          }],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.warnings).toContain('Extension "browser-ext" skipped - browser-only');
    });

    it('errors on browser-only extensions when skipBrowserOnly is false', async () => {
      const strictHandler = new SessionHandler(skillManager, {
        filesDir,
        skipBrowserOnly: false,
      });

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [],
          extensions: [{
            id: 'browser-ext',
            source: { type: 'builtin' },
          }],
        },
      });

      const result = await strictHandler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors).toContain('Extension "browser-ext" requires browser environment');
    });

    it('restores files to filesystem', async () => {
      const session = createMockSession({
        version: 2,
        files: [
          { path: 'test.txt', content: 'Hello, World!', encoding: 'utf8' },
          { path: 'subdir/nested.txt', content: 'Nested file', encoding: 'utf8' },
          { path: 'binary.bin', content: Buffer.from([0x00, 0x01, 0x02]).toString('base64'), encoding: 'base64' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.warnings.some(w => w.includes('Restored 3 file(s)'))).toBe(true);

      // Verify files were created
      const agentDir = join(filesDir, 'agent-123');
      expect(existsSync(join(agentDir, 'test.txt'))).toBe(true);
      expect(existsSync(join(agentDir, 'subdir/nested.txt'))).toBe(true);
      expect(existsSync(join(agentDir, 'binary.bin'))).toBe(true);

      // Verify file contents
      const textContent = await readFile(join(agentDir, 'test.txt'), 'utf8');
      expect(textContent).toBe('Hello, World!');

      const binaryContent = await readFile(join(agentDir, 'binary.bin'));
      expect(binaryContent).toEqual(Buffer.from([0x00, 0x01, 0x02]));
    });

    it('reports file restoration errors', async () => {
      // Create a read-only directory situation by using an invalid path
      const badHandler = new SessionHandler(skillManager, {
        filesDir: '/nonexistent/readonly/path',
        skipBrowserOnly: true,
      });

      const session = createMockSession({
        version: 2,
        files: [
          { path: 'test.txt', content: 'Hello', encoding: 'utf8' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await badHandler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Failed to restore file'))).toBe(true);
    });

    it('handles builtin skill that exists', async () => {
      // Pre-install a skill to simulate a builtin
      const skillContent = `---
name: test-builtin-skill
description: Builtin skill
---
Instructions`;
      skillManager.install(skillContent);

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-builtin-skill',
            source: { type: 'builtin' },
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);

      // Clean up
      skillManager.remove('test-builtin-skill');
    });

    it('errors on missing builtin skill without inline', async () => {
      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'missing-builtin',
            source: { type: 'builtin' },
            // No inline fallback
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('missing-builtin'))).toBe(true);
    });

    it('handles url skill with inline fallback when fetch fails', async () => {
      // Mock fetch to fail
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      try {
        const inlineSkill = createStoredSkill('test-url-skill');

        const session = createMockSession({
          version: 2,
          dependencies: {
            skills: [{
              name: 'test-url-skill',
              source: { type: 'url', url: 'https://example.com/skill.md' },
              inline: inlineSkill,
            }],
            extensions: [],
          },
        });

        const result = await handler.restoreSession(session);

        expect(result.success).toBe(true);
        expect(result.warnings).toContain('Skill "test-url-skill" resolved from inline fallback');

        // Clean up
        skillManager.remove('test-url-skill');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('errors on url skill without url or inline', async () => {
      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'broken-url-skill',
            source: { type: 'url' }, // No url provided
            // No inline fallback
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('no URL or inline fallback'))).toBe(true);
    });

    it('rejects path traversal attempts with ..', async () => {
      const session = createMockSession({
        version: 2,
        files: [
          { path: '../../../etc/passwd', content: 'malicious', encoding: 'utf8' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid file path (traversal attempt)'))).toBe(true);
    });

    it('rejects absolute paths', async () => {
      const session = createMockSession({
        version: 2,
        files: [
          { path: '/etc/passwd', content: 'malicious', encoding: 'utf8' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Invalid file path (traversal attempt)'))).toBe(true);
    });

    it('rejects normalized path traversal', async () => {
      const session = createMockSession({
        version: 2,
        files: [
          { path: 'subdir/../../outside.txt', content: 'malicious', encoding: 'utf8' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.includes('Path traversal detected') || e.includes('Invalid file path'))).toBe(true);
    });

    it('allows valid nested paths while rejecting traversal in same session', async () => {
      const session = createMockSession({
        version: 2,
        files: [
          { path: 'valid/nested/file.txt', content: 'ok', encoding: 'utf8' },
          { path: '../traversal.txt', content: 'bad', encoding: 'utf8' },
        ],
        dependencies: { skills: [], extensions: [] },
      });

      const result = await handler.restoreSession(session);

      // Should fail because one file has traversal
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('traversal');

      // But the valid file should have been restored
      const agentDir = join(filesDir, 'agent-123');
      expect(existsSync(join(agentDir, 'valid/nested/file.txt'))).toBe(true);
    });

    it('preserves conversation in migrated session', async () => {
      const conversation = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const session = createMockSession({
        version: 1,
        conversation,
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.session.conversation).toEqual(conversation);
    });

    it('resolves builtin system skills without error (system skills registered in hub)', async () => {
      // HubSkillManager.load() registers system skills via getSystemSkills()
      // 'flo-cookbook' is a real system skill
      skillManager.load();

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'flo-cookbook',
            source: { type: 'builtin' },
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('inline skills use registerFromSession (no filesystem write)', async () => {
      const registerSpy = vi.spyOn(skillManager, 'registerFromSession');
      const installSpy = vi.spyOn(skillManager, 'install');

      const inlineSkill = createStoredSkill('test-no-fs-write');

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-no-fs-write',
            source: { type: 'local' },
            inline: inlineSkill,
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      // registerFromSession should be called (in-memory only)
      expect(registerSpy).toHaveBeenCalledWith(inlineSkill);
      // install should NOT be called (it writes to filesystem)
      expect(installSpy).not.toHaveBeenCalled();

      registerSpy.mockRestore();
      installSpy.mockRestore();
    });

    it('registers inline skill via registerFromSession preserving all manifest fields', async () => {
      const fullSkill: StoredSkill = {
        name: 'test-full-skill',
        manifest: {
          name: 'test-full-skill',
          description: 'A fully featured skill',
          allowedTools: ['bash', 'filesystem'],
          argumentHint: '[file path]',
          disableModelInvocation: true,
          userInvocable: true,
          dependencies: ['other-skill'],
          integrity: 'sha256-abc123',
        },
        instructions: 'Process $ARGUMENTS with care',
        source: { type: 'local' },
        installedAt: Date.now(),
      };

      const session = createMockSession({
        version: 2,
        dependencies: {
          skills: [{
            name: 'test-full-skill',
            source: { type: 'local' },
            inline: fullSkill,
          }],
          extensions: [],
        },
      });

      const result = await handler.restoreSession(session);

      expect(result.success).toBe(true);
      expect(skillManager.hasSkill('test-full-skill')).toBe(true);

      const installed = skillManager.getSkill('test-full-skill');
      expect(installed?.manifest.allowedTools).toEqual(['bash', 'filesystem']);
      expect(installed?.manifest.argumentHint).toBe('[file path]');
      expect(installed?.manifest.disableModelInvocation).toBe(true);
      expect(installed?.manifest.userInvocable).toBe(true);
      expect(installed?.manifest.dependencies).toEqual(['other-skill']);
      expect(installed?.manifest.integrity).toBe('sha256-abc123');
      expect(installed?.instructions).toBe('Process $ARGUMENTS with care');

      // Clean up
      skillManager.remove('test-full-skill');
    });
  });
});
