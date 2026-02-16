/**
 * Hooks settings section - allows users to configure declarative hook rules
 */

import type { HookRulesConfig, HookRuleConfig, HookActionConfig } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings } from '../../shell/persistence.js';
import type { HookManager } from '../../shell/hook-manager.js';
import { createEmptyState } from '../dom-helpers.js';

const EVENT_TYPES = [
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'UserPromptSubmit',
  'AgentStart',
  'AgentEnd',
] as const;

type EventType = (typeof EVENT_TYPES)[number];

const TOOL_HOOK_TYPES: EventType[] = ['PreToolUse', 'PostToolUse'];

export function createHooksSection(
  settings: AppSettings,
  persistence: PersistenceLayer,
  hookManager: HookManager,
  onRerender: () => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'settings-hooks';

  const rules = settings.hookRules || {};
  const hasRules = EVENT_TYPES.some(
    (type) => rules[type] && rules[type]!.length > 0,
  );

  if (!hasRules) {
    el.appendChild(createEmptyState('No hook rules configured', 'settings-hooks__empty'));
  } else {
    const list = document.createElement('div');
    list.className = 'settings-hooks__list';

    for (const eventType of EVENT_TYPES) {
      const eventRules = rules[eventType];
      if (!eventRules || eventRules.length === 0) continue;

      const group = document.createElement('div');
      group.className = 'settings-hooks__group';

      const groupTitle = document.createElement('h4');
      groupTitle.className = 'settings-hooks__group-title';
      groupTitle.textContent = eventType;
      group.appendChild(groupTitle);

      for (let ruleIndex = 0; ruleIndex < eventRules.length; ruleIndex++) {
        const rule = eventRules[ruleIndex];
        const item = createRuleItem(
          eventType,
          rule,
          ruleIndex,
          settings,
          persistence,
          hookManager,
          el,
          onRerender,
        );
        group.appendChild(item);
      }

      list.appendChild(group);
    }
    el.appendChild(list);
  }

  // Add rule button
  const addBtn = document.createElement('button');
  addBtn.className = 'btn settings-hooks__add';
  addBtn.textContent = 'Add Hook Rule';
  addBtn.addEventListener('click', () => {
    showRuleDialog(null, null, settings, persistence, hookManager, el, onRerender);
  });
  el.appendChild(addBtn);

  return el;
}

function createRuleItem(
  eventType: EventType,
  rule: HookRuleConfig,
  ruleIndex: number,
  settings: AppSettings,
  persistence: PersistenceLayer,
  hookManager: HookManager,
  container: HTMLElement,
  onRerender: () => void,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'settings-hooks__item';

  const info = document.createElement('div');
  info.className = 'settings-hooks__info';

  // Display rule details
  const details: string[] = [];

  if (rule.matcher && TOOL_HOOK_TYPES.includes(eventType)) {
    details.push(`Matcher: ${rule.matcher}`);
  }

  // Display inputMatchers if present
  if (rule.inputMatchers && Object.keys(rule.inputMatchers).length > 0) {
    const matcherParts = Object.entries(rule.inputMatchers)
      .map(([field, pattern]) => `${field}=${pattern}`)
      .join(', ');
    details.push(`Input: ${matcherParts}`);
  }

  // Display all actions in the hooks array
  for (const hook of rule.hooks) {
    let actionText = `Action: ${hook.action}`;
    if (hook.action === 'script' && hook.script) {
      // Show truncated script for display
      const scriptDisplay = hook.script.length > 40
        ? hook.script.substring(0, 37) + '...'
        : hook.script;
      actionText += `: ${scriptDisplay}`;
      if (hook.continueOnError === false) {
        actionText += ' (stopOnError)';
      }
    } else if (hook.reason) {
      actionText += ` (${hook.reason})`;
    }
    details.push(actionText);
  }

  details.push(`Priority: ${rule.priority ?? 0}`);

  for (const detail of details) {
    const detailEl = document.createElement('div');
    detailEl.textContent = detail;
    info.appendChild(detailEl);
  }

  const actions = document.createElement('div');
  actions.className = 'settings-hooks__actions';

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'btn';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    showRuleDialog(
      { eventType, rule, ruleIndex },
      null,
      settings,
      persistence,
      hookManager,
      container,
      onRerender,
    );
  });
  actions.appendChild(editBtn);

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm('Are you sure you want to delete this hook rule?')) {
      return;
    }

    const current = await persistence.getSettings();
    const currentRules = current.hookRules || {};
    const eventRules = currentRules[eventType] || [];
    eventRules.splice(ruleIndex, 1);

    if (eventRules.length === 0) {
      delete currentRules[eventType];
    } else {
      currentRules[eventType] = eventRules;
    }

    current.hookRules = currentRules;
    await persistence.saveSettings(current);
    hookManager.registerFromConfig(current.hookRules || {});
    onRerender();
  });
  actions.appendChild(deleteBtn);

  item.appendChild(info);
  item.appendChild(actions);

  return item;
}

interface EditingRule {
  eventType: EventType;
  rule: HookRuleConfig;
  ruleIndex: number;
}

function showRuleDialog(
  editing: EditingRule | null,
  _unused: null,
  settings: AppSettings,
  persistence: PersistenceLayer,
  hookManager: HookManager,
  container: HTMLElement,
  onRerender: () => void,
): void {
  const overlay = document.createElement('div');
  overlay.className = 'settings-hooks__dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'settings-hooks__dialog';

  // Title
  const title = document.createElement('h3');
  title.textContent = editing ? 'Edit Hook Rule' : 'Add Hook Rule';
  dialog.appendChild(title);

  // Event type dropdown
  const eventTypeField = document.createElement('div');
  eventTypeField.className = 'form-field';

  const eventTypeLabel = document.createElement('label');
  eventTypeLabel.className = 'form-field__label';
  eventTypeLabel.textContent = 'Event Type';

  const eventTypeSelect = document.createElement('select');
  eventTypeSelect.className = 'form-field__input';
  for (const type of EVENT_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = type;
    if (editing && editing.eventType === type) {
      option.selected = true;
    }
    eventTypeSelect.appendChild(option);
  }

  eventTypeField.appendChild(eventTypeLabel);
  eventTypeField.appendChild(eventTypeSelect);
  dialog.appendChild(eventTypeField);

  // Matcher input (only for tool-related hooks)
  const matcherField = document.createElement('div');
  matcherField.className = 'form-field';

  const matcherLabel = document.createElement('label');
  matcherLabel.className = 'form-field__label';
  matcherLabel.textContent = 'Matcher (regex pattern for tool name)';

  const matcherInput = document.createElement('input');
  matcherInput.type = 'text';
  matcherInput.className = 'form-field__input';
  matcherInput.placeholder = 'e.g., bash|file_.*';
  if (editing && editing.rule.matcher) {
    matcherInput.value = editing.rule.matcher;
  }

  const matcherHelp = document.createElement('div');
  matcherHelp.className = 'settings-hooks__help';
  matcherHelp.textContent = 'Only applies to PreToolUse and PostToolUse events';

  matcherField.appendChild(matcherLabel);
  matcherField.appendChild(matcherInput);
  matcherField.appendChild(matcherHelp);
  dialog.appendChild(matcherField);

  // Input matchers section (only for tool-related hooks)
  const inputMatchersField = document.createElement('div');
  inputMatchersField.className = 'form-field';

  const inputMatchersLabel = document.createElement('label');
  inputMatchersLabel.className = 'form-field__label';
  inputMatchersLabel.textContent = 'Input Matchers';

  const inputMatchersList = document.createElement('div');
  inputMatchersList.className = 'settings-hooks__input-matchers';

  // Track input matchers
  const inputMatchersData: Array<{ field: string; pattern: string }> = [];

  // Load existing input matchers
  if (editing && editing.rule.inputMatchers) {
    for (const [field, pattern] of Object.entries(editing.rule.inputMatchers)) {
      inputMatchersData.push({ field, pattern });
    }
  }

  const renderInputMatchers = () => {
    inputMatchersList.innerHTML = '';

    for (let i = 0; i < inputMatchersData.length; i++) {
      const matcher = inputMatchersData[i];
      const row = document.createElement('div');
      row.className = 'settings-hooks__input-matcher-row';

      const fieldInput = document.createElement('input');
      fieldInput.type = 'text';
      fieldInput.className = 'form-field__input settings-hooks__input-matcher-field';
      fieldInput.placeholder = 'Field name (e.g., path)';
      fieldInput.value = matcher.field;
      fieldInput.addEventListener('input', () => {
        inputMatchersData[i].field = fieldInput.value;
      });

      const patternInput = document.createElement('input');
      patternInput.type = 'text';
      patternInput.className = 'form-field__input settings-hooks__input-matcher-pattern';
      patternInput.placeholder = 'Pattern (e.g., \\.py$)';
      patternInput.value = matcher.pattern;
      patternInput.addEventListener('input', () => {
        inputMatchersData[i].pattern = patternInput.value;
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn settings-hooks__input-matcher-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        inputMatchersData.splice(i, 1);
        renderInputMatchers();
      });

      row.appendChild(fieldInput);
      row.appendChild(patternInput);
      row.appendChild(removeBtn);
      inputMatchersList.appendChild(row);
    }
  };

  const addMatcherBtn = document.createElement('button');
  addMatcherBtn.type = 'button';
  addMatcherBtn.className = 'btn settings-hooks__add-input-matcher';
  addMatcherBtn.textContent = 'Add Input Matcher';
  addMatcherBtn.addEventListener('click', () => {
    inputMatchersData.push({ field: '', pattern: '' });
    renderInputMatchers();
  });

  const inputMatchersHelp = document.createElement('div');
  inputMatchersHelp.className = 'settings-hooks__help';
  inputMatchersHelp.textContent = 'Match tool input fields with regex patterns';

  inputMatchersField.appendChild(inputMatchersLabel);
  inputMatchersField.appendChild(inputMatchersList);
  inputMatchersField.appendChild(addMatcherBtn);
  inputMatchersField.appendChild(inputMatchersHelp);
  dialog.appendChild(inputMatchersField);

  renderInputMatchers();

  // Update matcher and inputMatchers field visibility based on event type
  const updateMatcherVisibility = () => {
    const selectedType = eventTypeSelect.value as EventType;
    const isToolHook = TOOL_HOOK_TYPES.includes(selectedType);
    matcherField.style.display = isToolHook ? 'block' : 'none';
    inputMatchersField.style.display = isToolHook ? 'block' : 'none';
  };

  eventTypeSelect.addEventListener('change', updateMatcherVisibility);
  updateMatcherVisibility();

  // Action dropdown
  const actionField = document.createElement('div');
  actionField.className = 'form-field';

  const actionLabel = document.createElement('label');
  actionLabel.className = 'form-field__label';
  actionLabel.textContent = 'Action';

  const actionSelect = document.createElement('select');
  actionSelect.className = 'form-field__input';
  const actions: Array<'deny' | 'allow' | 'log' | 'script'> = ['deny', 'allow', 'log', 'script'];
  for (const action of actions) {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = action;
    if (editing && editing.rule.hooks.length > 0 && editing.rule.hooks[0].action === action) {
      option.selected = true;
    }
    actionSelect.appendChild(option);
  }

  actionField.appendChild(actionLabel);
  actionField.appendChild(actionSelect);
  dialog.appendChild(actionField);

  // Script input (only for script action)
  const scriptField = document.createElement('div');
  scriptField.className = 'form-field';

  const scriptLabel = document.createElement('label');
  scriptLabel.className = 'form-field__label';
  scriptLabel.textContent = 'JavaScript';

  const scriptInput = document.createElement('textarea');
  scriptInput.className = 'form-field__input settings-hooks__script-input';
  scriptInput.rows = 5;
  scriptInput.placeholder = `// Available: type, agentId, toolName, toolInput, toolResult, prompt, stopReason
// APIs: callTool(name, input), log(...args)
// Return { decision: 'deny'|'allow', reason?: string } to override

log('Hook triggered:', toolName);
await callTool('runjs', { code: 'console.log("hello")' });`;
  if (editing && editing.rule.hooks.length > 0 && editing.rule.hooks[0].script) {
    scriptInput.value = editing.rule.hooks[0].script;
  }

  const scriptHelp = document.createElement('div');
  scriptHelp.className = 'settings-hooks__help';
  scriptHelp.textContent = 'Context vars: type, agentId, toolName, toolInput, toolResult, prompt, stopReason. APIs: callTool(name, input), log(...)';

  scriptField.appendChild(scriptLabel);
  scriptField.appendChild(scriptInput);
  scriptField.appendChild(scriptHelp);
  dialog.appendChild(scriptField);

  // Continue on error checkbox (only for script action)
  const continueOnErrorField = document.createElement('div');
  continueOnErrorField.className = 'form-field settings-hooks__checkbox-field';

  const continueOnErrorLabel = document.createElement('label');
  continueOnErrorLabel.className = 'form-field__label settings-hooks__checkbox-label';

  const continueOnErrorInput = document.createElement('input');
  continueOnErrorInput.type = 'checkbox';
  continueOnErrorInput.className = 'settings-hooks__checkbox';
  // Default to true, only unchecked if explicitly set to false
  continueOnErrorInput.checked = !(editing && editing.rule.hooks.length > 0 && editing.rule.hooks[0].continueOnError === false);

  const continueOnErrorText = document.createTextNode(' Continue on error (log failures but don\'t affect hook decision)');
  continueOnErrorLabel.appendChild(continueOnErrorInput);
  continueOnErrorLabel.appendChild(continueOnErrorText);

  continueOnErrorField.appendChild(continueOnErrorLabel);
  dialog.appendChild(continueOnErrorField);

  // Reason input (not for command action)
  const reasonField = document.createElement('div');
  reasonField.className = 'form-field';

  const reasonLabel = document.createElement('label');
  reasonLabel.className = 'form-field__label';
  reasonLabel.textContent = 'Reason (optional)';

  const reasonInput = document.createElement('input');
  reasonInput.type = 'text';
  reasonInput.className = 'form-field__input';
  reasonInput.placeholder = 'Explain why this rule exists';
  if (editing && editing.rule.hooks.length > 0 && editing.rule.hooks[0].reason) {
    reasonInput.value = editing.rule.hooks[0].reason;
  }

  reasonField.appendChild(reasonLabel);
  reasonField.appendChild(reasonInput);
  dialog.appendChild(reasonField);

  // Update action-dependent field visibility
  const updateActionFieldsVisibility = () => {
    const selectedAction = actionSelect.value;
    const isScript = selectedAction === 'script';
    scriptField.style.display = isScript ? 'block' : 'none';
    continueOnErrorField.style.display = isScript ? 'block' : 'none';
    reasonField.style.display = isScript ? 'none' : 'block';
  };

  actionSelect.addEventListener('change', updateActionFieldsVisibility);
  updateActionFieldsVisibility();

  // Priority input
  const priorityField = document.createElement('div');
  priorityField.className = 'form-field';

  const priorityLabel = document.createElement('label');
  priorityLabel.className = 'form-field__label';
  priorityLabel.textContent = 'Priority';

  const priorityInput = document.createElement('input');
  priorityInput.type = 'number';
  priorityInput.className = 'form-field__input';
  priorityInput.value = String(editing?.rule.priority ?? 0);

  const priorityHelp = document.createElement('div');
  priorityHelp.className = 'settings-hooks__help';
  priorityHelp.textContent = 'Higher priority rules are evaluated first';

  priorityField.appendChild(priorityLabel);
  priorityField.appendChild(priorityInput);
  priorityField.appendChild(priorityHelp);
  dialog.appendChild(priorityField);

  // Error display
  const errorEl = document.createElement('div');
  errorEl.className = 'settings-hooks__dialog-error';
  errorEl.style.display = 'none';
  dialog.appendChild(errorEl);

  // Action buttons
  const actionsEl = document.createElement('div');
  actionsEl.className = 'settings-hooks__dialog-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = 'Cancel';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn--primary';
  saveBtn.textContent = 'Save';

  actionsEl.appendChild(cancelBtn);
  actionsEl.appendChild(saveBtn);
  dialog.appendChild(actionsEl);

  overlay.appendChild(dialog);
  container.appendChild(overlay);

  const closeDialog = () => {
    overlay.remove();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  cancelBtn.addEventListener('click', closeDialog);

  saveBtn.addEventListener('click', async () => {
    const eventType = eventTypeSelect.value as EventType;
    const matcher = matcherInput.value.trim();
    const action = actionSelect.value as 'deny' | 'allow' | 'log' | 'script';
    const reason = reasonInput.value.trim();
    const script = scriptInput.value.trim();
    const continueOnError = continueOnErrorInput.checked;
    const priority = parseInt(priorityInput.value, 10) || 0;

    // Validate matcher regex if provided
    if (matcher && TOOL_HOOK_TYPES.includes(eventType)) {
      try {
        new RegExp(matcher);
      } catch {
        errorEl.textContent = 'Invalid regex pattern for matcher';
        errorEl.style.display = 'block';
        return;
      }
    }

    // Validate input matchers regexes
    if (TOOL_HOOK_TYPES.includes(eventType)) {
      for (const im of inputMatchersData) {
        if (im.field && im.pattern) {
          try {
            new RegExp(im.pattern);
          } catch {
            errorEl.textContent = `Invalid regex pattern for input matcher "${im.field}"`;
            errorEl.style.display = 'block';
            return;
          }
        }
      }
    }

    // Validate script is required for script action
    if (action === 'script' && !script) {
      errorEl.textContent = 'JavaScript code is required for script action';
      errorEl.style.display = 'block';
      return;
    }

    // Build the hook action
    const hookAction: HookActionConfig = {
      type: 'action',
      action,
    };
    if (action === 'script') {
      hookAction.script = script;
      // Only set continueOnError if false (default is true)
      if (!continueOnError) {
        hookAction.continueOnError = false;
      }
    } else if (reason) {
      hookAction.reason = reason;
    }

    // Build the rule
    const newRule: HookRuleConfig = {
      hooks: [hookAction],
      priority,
    };

    if (matcher && TOOL_HOOK_TYPES.includes(eventType)) {
      newRule.matcher = matcher;
    }

    // Add inputMatchers if any valid entries
    if (TOOL_HOOK_TYPES.includes(eventType)) {
      const validInputMatchers: Record<string, string> = {};
      for (const im of inputMatchersData) {
        if (im.field.trim() && im.pattern.trim()) {
          validInputMatchers[im.field.trim()] = im.pattern.trim();
        }
      }
      if (Object.keys(validInputMatchers).length > 0) {
        newRule.inputMatchers = validInputMatchers;
      }
    }

    // Update settings
    const current = await persistence.getSettings();
    const currentRules = current.hookRules || {};

    if (editing) {
      // If event type changed, remove from old location
      if (editing.eventType !== eventType) {
        const oldRules = currentRules[editing.eventType] || [];
        oldRules.splice(editing.ruleIndex, 1);
        if (oldRules.length === 0) {
          delete currentRules[editing.eventType];
        } else {
          currentRules[editing.eventType] = oldRules;
        }
        // Add to new location
        const newRules = currentRules[eventType] || [];
        newRules.push(newRule);
        currentRules[eventType] = newRules;
      } else {
        // Same event type, update in place
        const eventRules = currentRules[eventType] || [];
        eventRules[editing.ruleIndex] = newRule;
        currentRules[eventType] = eventRules;
      }
    } else {
      // Adding new rule
      const eventRules = currentRules[eventType] || [];
      eventRules.push(newRule);
      currentRules[eventType] = eventRules;
    }

    current.hookRules = currentRules;
    await persistence.saveSettings(current);
    hookManager.registerFromConfig(current.hookRules || {});
    closeDialog();
    onRerender();
  });
}
