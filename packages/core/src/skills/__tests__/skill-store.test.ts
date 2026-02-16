import { describe, it, expect, beforeEach } from 'vitest';
import { SkillStore } from '../skill-store.js';
import type { StoredSkill } from '../../types/skills.js';

// --- Test fixtures ---

const systemSkill: StoredSkill = {
  name: 'sys-skill',
  manifest: { name: 'sys-skill', description: 'System', category: 'system', userInvocable: false },
  instructions: 'System instructions',
  source: { type: 'builtin' },
  installedAt: 0,
};

const hubOnlySkill: StoredSkill = {
  name: 'hub-only',
  manifest: { name: 'hub-only', description: 'Hub only', category: 'system', userInvocable: false, requiredCapabilities: ['hub'] },
  instructions: 'Hub instructions',
  source: { type: 'builtin' },
  installedAt: 0,
};

const browserOnlySkill: StoredSkill = {
  name: 'browser-only',
  manifest: { name: 'browser-only', description: 'Browser only', category: 'system', userInvocable: false, requiredCapabilities: ['browser'] },
  instructions: 'Browser instructions',
  source: { type: 'builtin' },
  installedAt: 0,
};

const hubAndBrowserSkill: StoredSkill = {
  name: 'hub-browser',
  manifest: { name: 'hub-browser', description: 'Both', category: 'system', userInvocable: false, requiredCapabilities: ['hub', 'browser'] },
  instructions: 'Both instructions',
  source: { type: 'builtin' },
  installedAt: 0,
};

const userSkill: StoredSkill = {
  name: 'my-skill',
  manifest: { name: 'my-skill', description: 'User skill' },
  instructions: 'User instructions',
  source: { type: 'url', url: 'https://example.com/skill' },
  installedAt: Date.now(),
};

const localSkill: StoredSkill = {
  name: 'local-skill',
  manifest: { name: 'local-skill', description: 'Local skill' },
  instructions: 'Local instructions',
  source: { type: 'local' },
  installedAt: Date.now(),
};

const nonInvocableUserSkill: StoredSkill = {
  name: 'non-invocable',
  manifest: { name: 'non-invocable', description: 'Cannot invoke', userInvocable: false },
  instructions: 'Hidden instructions',
  source: { type: 'url', url: 'https://example.com/hidden' },
  installedAt: Date.now(),
};

const invocableSkillWithHub: StoredSkill = {
  name: 'invocable-hub',
  manifest: { name: 'invocable-hub', description: 'Invocable hub skill', requiredCapabilities: ['hub'] },
  instructions: 'Invocable hub instructions',
  source: { type: 'url', url: 'https://example.com/invocable-hub' },
  installedAt: Date.now(),
};

describe('SkillStore', () => {
  let store: SkillStore;

  beforeEach(() => {
    store = new SkillStore();
  });

  // === Registration ===

  describe('register', () => {
    it('registers a skill and makes it retrievable', () => {
      store.register(systemSkill);
      expect(store.get('sys-skill')).toBe(systemSkill);
    });

    it('overwrites a skill with the same name', () => {
      store.register(systemSkill);
      const updated = { ...systemSkill, instructions: 'Updated instructions' };
      store.register(updated);
      expect(store.get('sys-skill')?.instructions).toBe('Updated instructions');
    });
  });

  describe('registerSystemSkills', () => {
    it('registers multiple skills at once', () => {
      store.registerSystemSkills([systemSkill, hubOnlySkill, browserOnlySkill]);
      expect(store.has('sys-skill')).toBe(true);
      expect(store.has('hub-only')).toBe(true);
      expect(store.has('browser-only')).toBe(true);
    });

    it('handles empty array', () => {
      store.registerSystemSkills([]);
      expect(store.listAll()).toHaveLength(0);
    });
  });

  describe('unregister', () => {
    it('removes a user-installed skill', () => {
      store.register(userSkill);
      expect(store.unregister('my-skill')).toBe(true);
      expect(store.has('my-skill')).toBe(false);
    });

    it('removes a local skill', () => {
      store.register(localSkill);
      expect(store.unregister('local-skill')).toBe(true);
      expect(store.has('local-skill')).toBe(false);
    });

    it('refuses to unregister a builtin skill', () => {
      store.register(systemSkill);
      expect(store.unregister('sys-skill')).toBe(false);
      expect(store.has('sys-skill')).toBe(true);
    });

    it('returns false for non-existent skill', () => {
      expect(store.unregister('non-existent')).toBe(false);
    });
  });

  // === Lookup ===

  describe('get', () => {
    it('returns the skill when found', () => {
      store.register(userSkill);
      expect(store.get('my-skill')).toBe(userSkill);
    });

    it('returns undefined when not found', () => {
      expect(store.get('non-existent')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for registered skill', () => {
      store.register(systemSkill);
      expect(store.has('sys-skill')).toBe(true);
    });

    it('returns false for unregistered skill', () => {
      expect(store.has('non-existent')).toBe(false);
    });
  });

  describe('listAll', () => {
    it('returns all registered skills', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.register(hubOnlySkill);
      const all = store.listAll();
      expect(all).toHaveLength(3);
      expect(all.map(s => s.name).sort()).toEqual(['hub-only', 'my-skill', 'sys-skill']);
    });

    it('returns empty array when no skills registered', () => {
      expect(store.listAll()).toHaveLength(0);
    });
  });

  // === listAgentVisible ===

  describe('listAgentVisible', () => {
    beforeEach(() => {
      store.registerSystemSkills([systemSkill, hubOnlySkill, browserOnlySkill, hubAndBrowserSkill]);
      store.register(userSkill);
      store.register(nonInvocableUserSkill);
    });

    it('includes system skills (even if userInvocable is false)', () => {
      const visible = store.listAgentVisible();
      const names = visible.map(s => s.name);
      expect(names).toContain('sys-skill');
    });

    it('includes user-invocable skills (default userInvocable)', () => {
      const visible = store.listAgentVisible();
      const names = visible.map(s => s.name);
      expect(names).toContain('my-skill');
    });

    it('excludes non-system, non-invocable skills', () => {
      const visible = store.listAgentVisible();
      const names = visible.map(s => s.name);
      expect(names).not.toContain('non-invocable');
    });

    it('filters by hub capability', () => {
      const visible = store.listAgentVisible(undefined, { hasHub: false, hasBrowser: true });
      const names = visible.map(s => s.name);
      expect(names).not.toContain('hub-only');
      expect(names).toContain('browser-only');
    });

    it('filters by browser capability', () => {
      const visible = store.listAgentVisible(undefined, { hasHub: true, hasBrowser: false });
      const names = visible.map(s => s.name);
      expect(names).toContain('hub-only');
      expect(names).not.toContain('browser-only');
    });

    it('requires ALL capabilities when multiple are specified', () => {
      const hubOnly = store.listAgentVisible(undefined, { hasHub: true, hasBrowser: false });
      expect(hubOnly.map(s => s.name)).not.toContain('hub-browser');

      const browserOnly = store.listAgentVisible(undefined, { hasHub: false, hasBrowser: true });
      expect(browserOnly.map(s => s.name)).not.toContain('hub-browser');

      const both = store.listAgentVisible(undefined, { hasHub: true, hasBrowser: true });
      expect(both.map(s => s.name)).toContain('hub-browser');
    });

    it('shows all capability-skills when no context provided', () => {
      // No context means no filtering by capabilities
      const visible = store.listAgentVisible();
      const names = visible.map(s => s.name);
      expect(names).toContain('hub-only');
      expect(names).toContain('browser-only');
      expect(names).toContain('hub-browser');
    });

    it('excludes skills disabled for the agent', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      const visible = store.listAgentVisible('agent-1');
      const names = visible.map(s => s.name);
      expect(names).not.toContain('sys-skill');
    });

    it('does not exclude disabled skills for a different agent', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      const visible = store.listAgentVisible('agent-2');
      const names = visible.map(s => s.name);
      expect(names).toContain('sys-skill');
    });

    it('does not filter by agent disable when no agentId provided', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      const visible = store.listAgentVisible();
      const names = visible.map(s => s.name);
      expect(names).toContain('sys-skill');
    });
  });

  // === listUserInvocable ===

  describe('listUserInvocable', () => {
    beforeEach(() => {
      store.registerSystemSkills([systemSkill, hubOnlySkill, browserOnlySkill]);
      store.register(userSkill);
      store.register(nonInvocableUserSkill);
      store.register(invocableSkillWithHub);
    });

    it('includes skills where userInvocable is not explicitly false', () => {
      const invocable = store.listUserInvocable();
      const names = invocable.map(s => s.name);
      expect(names).toContain('my-skill');
    });

    it('excludes skills with userInvocable: false', () => {
      const invocable = store.listUserInvocable();
      const names = invocable.map(s => s.name);
      expect(names).not.toContain('sys-skill');
      expect(names).not.toContain('hub-only');
      expect(names).not.toContain('browser-only');
      expect(names).not.toContain('non-invocable');
    });

    it('filters by hub capability', () => {
      const invocable = store.listUserInvocable({ hasHub: false, hasBrowser: true });
      const names = invocable.map(s => s.name);
      expect(names).not.toContain('invocable-hub');
      expect(names).toContain('my-skill');
    });

    it('includes capability-restricted skills when capability is present', () => {
      const invocable = store.listUserInvocable({ hasHub: true, hasBrowser: true });
      const names = invocable.map(s => s.name);
      expect(names).toContain('invocable-hub');
    });

    it('shows all when no context provided', () => {
      const invocable = store.listUserInvocable();
      const names = invocable.map(s => s.name);
      expect(names).toContain('invocable-hub');
      expect(names).toContain('my-skill');
    });
  });

  // === Per-agent enable/disable ===

  describe('disableForAgent / enableForAgent / isDisabledForAgent', () => {
    it('disables a skill for an agent', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      expect(store.isDisabledForAgent('agent-1', 'sys-skill')).toBe(true);
    });

    it('does not affect other agents', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      expect(store.isDisabledForAgent('agent-2', 'sys-skill')).toBe(false);
    });

    it('does not affect other skills for the same agent', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      expect(store.isDisabledForAgent('agent-1', 'my-skill')).toBe(false);
    });

    it('enables a previously disabled skill', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      store.enableForAgent('agent-1', 'sys-skill');
      expect(store.isDisabledForAgent('agent-1', 'sys-skill')).toBe(false);
    });

    it('enable is a no-op for skills that are not disabled', () => {
      store.enableForAgent('agent-1', 'sys-skill');
      expect(store.isDisabledForAgent('agent-1', 'sys-skill')).toBe(false);
    });

    it('enable is a no-op for unknown agents', () => {
      store.enableForAgent('unknown-agent', 'sys-skill');
      expect(store.isDisabledForAgent('unknown-agent', 'sys-skill')).toBe(false);
    });

    it('can disable multiple skills for the same agent', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      store.disableForAgent('agent-1', 'my-skill');
      expect(store.isDisabledForAgent('agent-1', 'sys-skill')).toBe(true);
      expect(store.isDisabledForAgent('agent-1', 'my-skill')).toBe(true);
    });

    it('cleans up internal map when last skill is re-enabled', () => {
      store.disableForAgent('agent-1', 'sys-skill');
      store.enableForAgent('agent-1', 'sys-skill');
      // After enabling the last disabled skill, the agent entry should be removed
      // We verify this indirectly - no disabled skills for agent-1
      expect(store.isDisabledForAgent('agent-1', 'sys-skill')).toBe(false);
    });
  });

  // === Usage tracking ===

  describe('trackUsage', () => {
    it('tracks skill usage for an agent', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(1);
      expect(deps[0].name).toBe('my-skill');
    });

    it('deduplicates repeated usage of the same skill', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      store.trackUsage('agent-1', 'my-skill');
      store.trackUsage('agent-1', 'my-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(1);
    });

    it('tracks multiple skills for the same agent', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.trackUsage('agent-1', 'sys-skill');
      store.trackUsage('agent-1', 'my-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(2);
      expect(deps.map(d => d.name).sort()).toEqual(['my-skill', 'sys-skill']);
    });

    it('tracks usage independently per agent', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.trackUsage('agent-1', 'sys-skill');
      store.trackUsage('agent-2', 'my-skill');
      expect(store.getAgentDependencies('agent-1')).toHaveLength(1);
      expect(store.getAgentDependencies('agent-1')[0].name).toBe('sys-skill');
      expect(store.getAgentDependencies('agent-2')).toHaveLength(1);
      expect(store.getAgentDependencies('agent-2')[0].name).toBe('my-skill');
    });
  });

  describe('getAgentDependencies', () => {
    it('returns empty array for agent with no usage', () => {
      expect(store.getAgentDependencies('agent-1')).toEqual([]);
    });

    it('skips skills that were used but then unregistered', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      store.unregister('my-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(0);
    });

    it('returns SkillDependency objects with correct shape', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(1);
      const dep = deps[0];
      expect(dep.name).toBe('my-skill');
      expect(dep.source).toEqual({ type: 'url', url: 'https://example.com/skill' });
      expect(dep.inline).toBe(userSkill);
    });

    it('includes builtin skills in dependencies if used', () => {
      store.register(systemSkill);
      store.trackUsage('agent-1', 'sys-skill');
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(1);
      expect(deps[0].source.type).toBe('builtin');
    });
  });

  describe('clearAgentUsage', () => {
    it('clears usage for the specified agent', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      store.clearAgentUsage('agent-1');
      expect(store.getAgentDependencies('agent-1')).toEqual([]);
    });

    it('does not affect other agents', () => {
      store.register(userSkill);
      store.trackUsage('agent-1', 'my-skill');
      store.trackUsage('agent-2', 'my-skill');
      store.clearAgentUsage('agent-1');
      expect(store.getAgentDependencies('agent-2')).toHaveLength(1);
    });

    it('is a no-op for unknown agents', () => {
      store.clearAgentUsage('non-existent');
      // Should not throw
    });
  });

  // === Bulk operations ===

  describe('exportUserSkills', () => {
    it('returns only non-builtin skills', () => {
      store.register(systemSkill);
      store.register(hubOnlySkill);
      store.register(userSkill);
      store.register(localSkill);
      const exported = store.exportUserSkills();
      expect(exported).toHaveLength(2);
      const names = exported.map(s => s.name).sort();
      expect(names).toEqual(['local-skill', 'my-skill']);
    });

    it('returns empty array when only builtins are registered', () => {
      store.registerSystemSkills([systemSkill, hubOnlySkill]);
      expect(store.exportUserSkills()).toHaveLength(0);
    });

    it('returns empty array when no skills registered', () => {
      expect(store.exportUserSkills()).toHaveLength(0);
    });
  });

  describe('importUserSkills', () => {
    it('imports user skills while preserving builtins', () => {
      store.register(systemSkill);
      store.register(hubOnlySkill);
      store.importUserSkills([userSkill, localSkill]);

      // Builtins preserved
      expect(store.has('sys-skill')).toBe(true);
      expect(store.has('hub-only')).toBe(true);

      // User skills imported
      expect(store.has('my-skill')).toBe(true);
      expect(store.has('local-skill')).toBe(true);
    });

    it('clears previously registered user skills', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.register(localSkill);

      // Import only one user skill - the other should be gone
      const newUserSkill: StoredSkill = {
        name: 'new-skill',
        manifest: { name: 'new-skill', description: 'New' },
        instructions: 'New instructions',
        source: { type: 'url', url: 'https://example.com/new' },
        installedAt: Date.now(),
      };
      store.importUserSkills([newUserSkill]);

      expect(store.has('sys-skill')).toBe(true);   // builtin preserved
      expect(store.has('my-skill')).toBe(false);    // old user skill gone
      expect(store.has('local-skill')).toBe(false); // old local skill gone
      expect(store.has('new-skill')).toBe(true);    // new user skill added
    });

    it('handles empty import (clears all user skills)', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.importUserSkills([]);

      expect(store.has('sys-skill')).toBe(true);
      expect(store.has('my-skill')).toBe(false);
    });

    it('handles import when no builtins exist', () => {
      store.register(userSkill);
      store.importUserSkills([localSkill]);

      expect(store.has('my-skill')).toBe(false);
      expect(store.has('local-skill')).toBe(true);
    });
  });

  // === Integration scenarios ===

  describe('integration', () => {
    it('full lifecycle: register, disable, track, export', () => {
      // Register system and user skills
      store.registerSystemSkills([systemSkill, hubOnlySkill]);
      store.register(userSkill);

      // Agent uses some skills
      store.trackUsage('agent-1', 'sys-skill');
      store.trackUsage('agent-1', 'my-skill');

      // Disable one for agent
      store.disableForAgent('agent-1', 'hub-only');

      // List visible skills
      const visible = store.listAgentVisible('agent-1', { hasHub: true });
      expect(visible.map(s => s.name).sort()).toEqual(['my-skill', 'sys-skill']);

      // Get dependencies for serialization
      const deps = store.getAgentDependencies('agent-1');
      expect(deps).toHaveLength(2);

      // Export user skills for persistence
      const exported = store.exportUserSkills();
      expect(exported).toHaveLength(1);
      expect(exported[0].name).toBe('my-skill');
    });

    it('import/export round-trip preserves user skills', () => {
      store.register(systemSkill);
      store.register(userSkill);
      store.register(localSkill);

      const exported = store.exportUserSkills();

      // Create a new store with the same builtins
      const newStore = new SkillStore();
      newStore.register(systemSkill);
      newStore.importUserSkills(exported);

      expect(newStore.has('sys-skill')).toBe(true);
      expect(newStore.has('my-skill')).toBe(true);
      expect(newStore.has('local-skill')).toBe(true);
      expect(newStore.listAll()).toHaveLength(3);
    });
  });
});
