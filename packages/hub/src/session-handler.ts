/**
 * Hub session handler - handles restoring agents from serialized sessions
 */

import type {
  SerializedSession,
  SessionDependencies,
  SkillDependency,
  ExtensionDependency,
  SerializedFile,
  StoredSkill,
  HookRulesConfig,
} from '@flo-monster/core';
import { migrateSessionV1ToV2 } from '@flo-monster/core';
import type { HubSkillManager } from './skill-manager.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, normalize, resolve, isAbsolute } from 'node:path';

export interface SessionRestoreOptions {
  /** Directory for restored agent files */
  filesDir: string;
  /** Skip browser-only extensions without error */
  skipBrowserOnly?: boolean;
}

export interface SessionRestoreResult {
  success: boolean;
  agentId: string;
  warnings: string[];
  errors: string[];
  /** The migrated session (v2 format) */
  session: SerializedSession;
  /** Declarative hook rules from session dependencies (scripts skipped on hub) */
  hooks?: HookRulesConfig;
}

export class SessionHandler {
  constructor(
    private skillManager: HubSkillManager,
    private options: SessionRestoreOptions,
  ) {}

  /**
   * Restore a session from serialized data
   */
  async restoreSession(
    session: SerializedSession,
  ): Promise<SessionRestoreResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Migrate v1 to v2 if needed
    const migrated = migrateSessionV1ToV2(session);

    // Log browser-only features that will be skipped
    if (migrated.domState) {
      warnings.push('DOM state ignored - hub does not support DOM rendering');
    }

    // Resolve dependencies
    if (migrated.dependencies) {
      await this.resolveDependencies(migrated.dependencies, warnings, errors);
    }

    // Restore files to filesystem
    if (migrated.files?.length) {
      await this.restoreFiles(migrated.agentId, migrated.files, warnings, errors);
    }

    // Conversation is transferred as-is (stored in session.conversation)
    // The headless runner will use this to initialize the agent

    // Extract hooks from dependencies
    let hooks: HookRulesConfig | undefined;
    if (migrated.dependencies?.hooks) {
      hooks = migrated.dependencies.hooks as HookRulesConfig;
      warnings.push('Hooks restored from session (declarative rules only, scripts skipped on hub)');
    }

    return {
      success: errors.length === 0,
      agentId: migrated.agentId,
      warnings,
      errors,
      session: migrated,
      hooks,
    };
  }

  /**
   * Resolve session dependencies (skills, extensions)
   */
  private async resolveDependencies(
    deps: SessionDependencies,
    warnings: string[],
    errors: string[],
  ): Promise<void> {
    // Resolve skill dependencies
    for (const skillDep of deps.skills) {
      try {
        await this.resolveSkill(skillDep);
      } catch (err) {
        if (skillDep.inline) {
          // Use inline fallback
          this.installSkillFromInline(skillDep.inline);
          warnings.push(`Skill "${skillDep.name}" resolved from inline fallback`);
        } else {
          errors.push(`Failed to resolve skill "${skillDep.name}": ${err}`);
        }
      }
    }

    // Handle extension dependencies
    for (const extDep of deps.extensions) {
      // Extensions are browser-only in most cases
      if (this.isBrowserOnlyExtension(extDep)) {
        if (this.options.skipBrowserOnly) {
          warnings.push(`Extension "${extDep.id}" skipped - browser-only`);
        } else {
          errors.push(`Extension "${extDep.id}" requires browser environment`);
        }
      }
      // If we have browser-compatible extensions in the future,
      // we could try to resolve them here
    }
  }

  /**
   * Resolve a skill dependency
   */
  private async resolveSkill(dep: SkillDependency): Promise<void> {
    // Check if skill is already installed
    if (this.skillManager.hasSkill(dep.name)) {
      return;
    }

    // Try to install based on source
    switch (dep.source.type) {
      case 'builtin':
        // System skills are now registered in HubSkillManager via getSystemSkills()
        // If not found after the hasSkill check above, it's a genuine error
        throw new Error(`Builtin skill "${dep.name}" not found in hub skill manager`);
      case 'url':
        if (dep.source.url) {
          await this.installSkillFromUrl(dep.source.url, dep.name);
        } else if (dep.inline) {
          this.installSkillFromInline(dep.inline);
        } else {
          throw new Error(`Skill "${dep.name}" has no URL or inline fallback`);
        }
        break;
      case 'local':
        // Local skills need to be transferred inline
        if (dep.inline) {
          this.installSkillFromInline(dep.inline);
        } else {
          throw new Error(`Local skill "${dep.name}" has no inline content`);
        }
        break;
    }
  }

  /**
   * Install a skill from URL
   */
  private async installSkillFromUrl(url: string, name: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const content = await response.text();
      this.skillManager.install(content);
    } catch (err) {
      throw new Error(`Failed to fetch skill "${name}" from ${url}: ${err}`);
    }
  }

  /**
   * Install a skill from inline StoredSkill (in-memory only, no filesystem write)
   */
  private installSkillFromInline(stored: StoredSkill): void {
    // Check if already exists (another session may have installed it)
    if (this.skillManager.hasSkill(stored.name)) {
      return;
    }

    this.skillManager.registerFromSession(stored);
  }

  /**
   * Check if an extension is browser-only
   */
  private isBrowserOnlyExtension(_dep: ExtensionDependency): boolean {
    // Currently all extensions are browser-only since they run in the DOM
    // This could be extended to check extension manifest for runtime compatibility
    return true;
  }

  /**
   * Restore files to the hub filesystem
   */
  private async restoreFiles(
    agentId: string,
    files: SerializedFile[],
    warnings: string[],
    errors: string[],
  ): Promise<void> {
    const agentDir = resolve(this.options.filesDir, agentId);
    const resolvedAgentDir = resolve(agentDir);
    let restoredCount = 0;

    for (const file of files) {
      try {
        // Validate path for traversal attempts
        const normalizedPath = normalize(file.path);
        if (normalizedPath.startsWith('..') || isAbsolute(normalizedPath)) {
          errors.push(`Invalid file path (traversal attempt): ${file.path}`);
          continue;
        }

        const filePath = resolve(agentDir, normalizedPath);
        if (!filePath.startsWith(resolvedAgentDir + '/') && filePath !== resolvedAgentDir) {
          errors.push(`Path traversal detected: ${file.path}`);
          continue;
        }

        const dirPath = dirname(filePath);

        // Create directory if needed
        await mkdir(dirPath, { recursive: true });

        // Write file content
        const content = file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : file.content;

        await writeFile(filePath, content);
        restoredCount++;
      } catch (err) {
        errors.push(`Failed to restore file "${file.path}": ${err}`);
      }
    }

    if (restoredCount > 0) {
      warnings.push(`Restored ${restoredCount} file(s) to ${agentDir}`);
    }
  }
}
