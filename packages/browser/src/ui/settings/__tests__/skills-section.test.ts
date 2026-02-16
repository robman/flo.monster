import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSkillsSection } from '../skills-section.js';
import { SkillManager } from '../../../shell/skill-manager.js';
import type { PersistenceLayer, AppSettings } from '../../../shell/persistence.js';
import type { StoredSkill } from '@flo-monster/core';

describe('createSkillsSection', () => {
  let skillManager: SkillManager;
  let mockPersistence: PersistenceLayer;
  let mockSettings: AppSettings;
  let onRerender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    skillManager = new SkillManager();
    mockSettings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
    };
    mockPersistence = {
      getSettings: vi.fn().mockResolvedValue(mockSettings),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    } as unknown as PersistenceLayer;
    onRerender = vi.fn();
  });

  afterEach(() => {
    // Clean up any dialogs
    document.body.innerHTML = '';
  });

  it('shows empty state when no skills installed', () => {
    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    expect(el.querySelector('.settings-skills__empty')).not.toBeNull();
    expect(el.querySelector('.settings-skills__empty')?.textContent).toBe('No skills installed');
  });

  it('lists installed skills', () => {
    const skill: StoredSkill = {
      name: 'test-skill',
      manifest: {
        name: 'test-skill',
        description: 'A test skill',
        argumentHint: '[message]',
      },
      instructions: 'Do $ARGUMENTS',
      source: { type: 'url', url: 'https://example.com/SKILL.md' },
      installedAt: Date.now(),
    };
    skillManager.installBuiltin(skill);

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    expect(el.querySelector('.settings-skills__empty')).toBeNull();
    const nameEl = el.querySelector('.settings-skills__name');
    expect(nameEl?.textContent).toContain('/test-skill');
    expect(nameEl?.textContent).toContain('[message]');
    expect(el.querySelector('.settings-skills__desc')?.textContent).toBe('A test skill');
  });

  it('shows allowed tools if present', () => {
    skillManager.installBuiltin({
      name: 'with-tools',
      manifest: {
        name: 'with-tools',
        description: 'Has tools',
        allowedTools: ['bash', 'runjs'],
      },
      instructions: '',
      source: { type: 'builtin' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    expect(el.querySelector('.settings-skills__tools')?.textContent).toContain('bash, runjs');
  });

  it('has install from URL button', () => {
    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    const installBtn = el.querySelector('.settings-skills__add') as HTMLButtonElement;
    expect(installBtn).not.toBeNull();
    expect(installBtn.textContent).toBe('Install from URL');
  });

  it('does not show remove button for builtin skills', () => {
    skillManager.installBuiltin({
      name: 'builtin-skill',
      manifest: { name: 'builtin-skill', description: 'Built-in' },
      instructions: '',
      source: { type: 'builtin' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    const removeBtn = Array.from(el.querySelectorAll('.btn')).find(
      btn => btn.textContent === 'Remove'
    );
    expect(removeBtn).toBeUndefined();
  });

  it('shows remove button for URL-installed skills', () => {
    skillManager.installBuiltin({
      name: 'url-skill',
      manifest: { name: 'url-skill', description: 'From URL' },
      instructions: '',
      source: { type: 'url', url: 'https://example.com' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    const removeBtn = Array.from(el.querySelectorAll('.btn')).find(
      btn => btn.textContent === 'Remove'
    );
    expect(removeBtn).not.toBeUndefined();
  });

  it('has view button for each skill', () => {
    skillManager.installBuiltin({
      name: 'test',
      manifest: { name: 'test', description: 'Test' },
      instructions: 'Instructions here',
      source: { type: 'builtin' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    const viewBtn = Array.from(el.querySelectorAll('.btn')).find(
      btn => btn.textContent === 'View'
    );
    expect(viewBtn).not.toBeUndefined();
  });

  it('opens view dialog when view button clicked', () => {
    skillManager.installBuiltin({
      name: 'test',
      manifest: { name: 'test', description: 'Test' },
      instructions: 'Instructions here',
      source: { type: 'builtin' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);
    document.body.appendChild(el);

    const viewBtn = Array.from(el.querySelectorAll('.btn')).find(
      btn => btn.textContent === 'View'
    ) as HTMLButtonElement;
    viewBtn.click();

    // Dialog should be appended to body
    const overlay = document.querySelector('.settings-skills__dialog-overlay');
    expect(overlay).not.toBeNull();
    expect(document.querySelector('.settings-skills__dialog')?.textContent).toContain('Skill: test');
  });

  it('removes skill and saves when remove clicked and confirmed', async () => {
    skillManager.installBuiltin({
      name: 'removable',
      manifest: { name: 'removable', description: 'To remove' },
      instructions: '',
      source: { type: 'url', url: 'https://example.com' },
      installedAt: Date.now(),
    });

    const el = createSkillsSection(mockSettings, mockPersistence, skillManager, onRerender);

    // Mock confirm
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const removeBtn = Array.from(el.querySelectorAll('.btn')).find(
      btn => btn.textContent === 'Remove'
    ) as HTMLButtonElement;
    removeBtn.click();

    // Wait for async operations
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(confirmSpy).toHaveBeenCalledWith('Remove skill "removable"?');
    expect(skillManager.hasSkill('removable')).toBe(false);
    expect(mockPersistence.saveSettings).toHaveBeenCalled();
    expect(onRerender).toHaveBeenCalled();

    confirmSpy.mockRestore();
  });
});
