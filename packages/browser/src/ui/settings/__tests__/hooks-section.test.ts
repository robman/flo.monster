/**
 * Tests for hooks-section UI
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHooksSection } from '../hooks-section.js';
import type { AppSettings, PersistenceLayer } from '../../../shell/persistence.js';
import { HookManager } from '../../../shell/hook-manager.js';

describe('createHooksSection', () => {
  let settings: AppSettings;
  let persistence: PersistenceLayer;
  let hookManager: HookManager;
  let onRerender: () => void;

  beforeEach(() => {
    settings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
    };

    persistence = {
      getSettings: vi.fn().mockResolvedValue(settings),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    } as unknown as PersistenceLayer;

    hookManager = new HookManager();
    onRerender = vi.fn();
  });

  it('should create a div element', () => {
    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    expect(element.tagName).toBe('DIV');
    expect(element.className).toBe('settings-hooks');
  });

  it('should show empty message when no rules', () => {
    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    const empty = element.querySelector('.settings-hooks__empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('No hook rules configured');
  });

  it('should show add button', () => {
    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    const addBtn = element.querySelector('.settings-hooks__add');
    expect(addBtn).not.toBeNull();
    expect(addBtn?.textContent).toBe('Add Hook Rule');
  });

  it('should show existing rules when hookRules is set', () => {
    settings.hookRules = {
      PreToolUse: [
        {
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny', reason: 'No bash' }],
          priority: 10,
        },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);

    // Should not show empty message
    const empty = element.querySelector('.settings-hooks__empty');
    expect(empty).toBeNull();

    // Should show the rule
    const list = element.querySelector('.settings-hooks__list');
    expect(list).not.toBeNull();

    // Check for group title
    const groupTitle = element.querySelector('.settings-hooks__group-title');
    expect(groupTitle?.textContent).toBe('PreToolUse');

    // Check for rule info
    const items = element.querySelectorAll('.settings-hooks__item');
    expect(items.length).toBe(1);
  });

  it('should show multiple rules across event types', () => {
    settings.hookRules = {
      PreToolUse: [
        { hooks: [{ type: 'action', action: 'deny' }] },
        { hooks: [{ type: 'action', action: 'log' }] },
      ],
      AgentStart: [
        { hooks: [{ type: 'action', action: 'allow' }] },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);

    const groups = element.querySelectorAll('.settings-hooks__group');
    expect(groups.length).toBe(2);

    const items = element.querySelectorAll('.settings-hooks__item');
    expect(items.length).toBe(3);
  });

  it('should show edit and delete buttons for each rule', () => {
    settings.hookRules = {
      PreToolUse: [
        { hooks: [{ type: 'action', action: 'deny' }] },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);

    // Find buttons by text content within the actions div
    const actions = element.querySelector('.settings-hooks__actions');
    expect(actions).not.toBeNull();

    const buttons = actions?.querySelectorAll('button') || [];
    const buttonTexts = Array.from(buttons).map(b => b.textContent);
    expect(buttonTexts).toContain('Edit');
    expect(buttonTexts).toContain('Delete');
  });

  it('should display rule matcher when set', () => {
    settings.hookRules = {
      PreToolUse: [
        {
          matcher: '^bash$',
          hooks: [{ type: 'action', action: 'deny' }],
        },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    expect(element.textContent).toContain('^bash$');
  });

  it('should display rule action', () => {
    settings.hookRules = {
      Stop: [
        { hooks: [{ type: 'action', action: 'deny', reason: 'Keep working' }] },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    expect(element.textContent).toContain('deny');
    expect(element.textContent).toContain('Keep working');
  });

  it('should display rule priority when set', () => {
    settings.hookRules = {
      AgentEnd: [
        {
          hooks: [{ type: 'action', action: 'allow' }],
          priority: 50,
        },
      ],
    };

    const element = createHooksSection(settings, persistence, hookManager, onRerender);
    expect(element.textContent).toContain('50');
  });
});
