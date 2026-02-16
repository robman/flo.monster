import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NewAgentDialog } from './new-agent-dialog.js';
import type { NewAgentResult, NewAgentFromTemplateResult } from './new-agent-dialog.js';
import type { HubClient, HubConnection } from '../shell/hub-client.js';
import type { ToolDef } from '@flo-monster/core';

// Type guard to check if result is a custom agent result
function isCustomResult(result: NewAgentResult | NewAgentFromTemplateResult | null): result is NewAgentResult {
  return result !== null && result.type === 'custom';
}

// Mock tools for testing
const mockTools: ToolDef[] = [
  { name: 'runjs', description: 'Execute JavaScript', input_schema: { type: 'object', properties: {} } },
  { name: 'dom', description: 'Manipulate DOM', input_schema: { type: 'object', properties: {} } },
];

function createMockHubClient(connections: HubConnection[] = []): HubClient {
  return {
    getConnections: vi.fn(() => connections),
    getConnection: vi.fn((id: string) => connections.find(c => c.id === id)),
    connect: vi.fn(),
    disconnect: vi.fn(),
    executeTool: vi.fn(),
    fetch: vi.fn(),
    onConnect: vi.fn(() => vi.fn()),
    onDisconnect: vi.fn(() => vi.fn()),
    onToolsAnnounced: vi.fn(() => vi.fn()),
    getAllTools: vi.fn(() => []),
    findToolHub: vi.fn(),
  } as unknown as HubClient;
}

describe('NewAgentDialog', () => {
  let dialog: NewAgentDialog;

  beforeEach(() => {
    dialog = new NewAgentDialog();
  });

  afterEach(() => {
    dialog.hide();
  });

  it('creates dialog with form elements', async () => {
    const showPromise = dialog.show(mockTools, 1);

    // Check form elements exist
    expect(document.querySelector('#agent-name')).toBeTruthy();
    expect(document.querySelector('#agent-model')).toBeTruthy();
    expect(document.querySelector('#agent-prompt')).toBeTruthy();
    expect(document.querySelector('#tool-checkboxes')).toBeTruthy();

    // Cancel to cleanup
    (document.querySelector('#dialog-cancel') as HTMLButtonElement).click();
    const result = await showPromise;
    expect(result).toBeNull();
  });

  it('Name and Model are visible without expanding sections', () => {
    dialog.show(mockTools, 1);

    // Top-level fields should NOT be inside a details element
    const nameInput = document.querySelector('#agent-name') as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    expect(nameInput.closest('details')).toBeNull();

    const modelSelect = document.querySelector('#agent-model') as HTMLSelectElement;
    expect(modelSelect).toBeTruthy();
    expect(modelSelect.closest('details')).toBeNull();

    dialog.hide();
  });

  it('uses collapsible sections for advanced settings', () => {
    dialog.show(mockTools, 1);

    const sections = document.querySelectorAll('details.settings-section');
    // System Prompt, Tools, Budget, Network Policy, Context Strategy, Sandbox Permissions (no Hub since no hubClient)
    expect(sections.length).toBe(6);
    // All should be collapsed by default
    sections.forEach(section => {
      expect((section as HTMLDetailsElement).open).toBe(false);
    });

    dialog.hide();
  });

  it('returns new budget fields when set', async () => {
    const showPromise = dialog.show(mockTools, 1);

    // Set budget values
    const maxTokensInput = document.querySelector('#agent-max-tokens') as HTMLInputElement;
    maxTokensInput.value = '8192';
    const costInput = document.querySelector('#agent-cost-budget') as HTMLInputElement;
    costInput.value = '5.00';

    // Submit form
    const form = document.querySelector('.new-agent-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result).not.toBeNull();
    expect(isCustomResult(result)).toBe(true);
    if (isCustomResult(result)) {
      expect(result.maxTokens).toBe(8192);
      expect(result.costBudgetUsd).toBe(5.00);
    }
  });

  it('hide removes dialog from DOM', () => {
    dialog.show(mockTools, 1);
    expect(document.querySelector('.new-agent-dialog')).toBeTruthy();
    dialog.hide();
    expect(document.querySelector('.new-agent-dialog')).toBeNull();
  });

  it('returns result on form submit', async () => {
    const showPromise = dialog.show(mockTools, 1);

    // Fill form
    const nameInput = document.querySelector('#agent-name') as HTMLInputElement;
    nameInput.value = 'My Agent';

    // Submit form
    const form = document.querySelector('.new-agent-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const result = await showPromise;
    expect(result).not.toBeNull();
    expect(isCustomResult(result)).toBe(true);
    if (isCustomResult(result)) {
      expect(result.name).toBe('My Agent');
      expect(result.selectedTools).toContain('runjs');
      expect(result.selectedTools).toContain('dom');
    }
  });

  describe('hub integration', () => {
    it('hides hub section when no hubClient set', () => {
      dialog.show(mockTools, 1);

      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      expect(hubSelect).toBeNull();

      dialog.hide();
    });

    it('hides hub section when hubClient has no connections', () => {
      const hubClient = createMockHubClient([]);
      dialog.setHubClient(hubClient);
      dialog.show(mockTools, 1);

      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      expect(hubSelect).toBeNull();

      dialog.hide();
    });

    it('shows hub dropdown when hubClient has connections', () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
        { id: 'hub-2', name: 'Remote Hub', url: 'ws://remote:3002', connected: false, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      dialog.setHubClient(hubClient);
      dialog.show(mockTools, 1);

      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      expect(hubSelect).toBeTruthy();
      expect(hubSelect.options.length).toBe(3); // None + 2 connections

      // Check options
      expect(hubSelect.options[0].value).toBe('');
      expect(hubSelect.options[0].textContent).toBe('None (first available)');
      expect(hubSelect.options[1].value).toBe('hub-1');
      expect(hubSelect.options[1].textContent).toBe('Local Hub');
      expect(hubSelect.options[2].value).toBe('hub-2');
      expect(hubSelect.options[2].textContent).toBe('Remote Hub (disconnected)');

      dialog.hide();
    });

    it('shows sandbox path input when hub selected', () => {
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      dialog.setHubClient(hubClient);
      dialog.show(mockTools, 1);

      const sandboxSection = document.querySelector('#sandbox-section') as HTMLElement;
      expect(sandboxSection.style.display).toBe('none');

      // Select a hub
      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      hubSelect.value = 'hub-1';
      hubSelect.dispatchEvent(new Event('change'));

      expect(sandboxSection.style.display).toBe('block');

      // Deselect hub
      hubSelect.value = '';
      hubSelect.dispatchEvent(new Event('change'));

      expect(sandboxSection.style.display).toBe('none');

      dialog.hide();
    });

    it('returns hubConnectionId in result', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-abc', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      dialog.setHubClient(hubClient);

      const showPromise = dialog.show(mockTools, 1);

      // Select hub
      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      hubSelect.value = 'hub-abc';

      // Submit form
      const form = document.querySelector('.new-agent-form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const result = await showPromise;
      expect(result).not.toBeNull();
      expect(isCustomResult(result)).toBe(true);
      if (isCustomResult(result)) {
        expect(result.hubConnectionId).toBe('hub-abc');
      }
    });

    it('returns hubSandboxPath in result', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-abc', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      dialog.setHubClient(hubClient);

      const showPromise = dialog.show(mockTools, 1);

      // Select hub
      const hubSelect = document.querySelector('#agent-hub') as HTMLSelectElement;
      hubSelect.value = 'hub-abc';
      hubSelect.dispatchEvent(new Event('change'));

      // Fill sandbox path
      const sandboxInput = document.querySelector('#agent-sandbox-path') as HTMLInputElement;
      sandboxInput.value = '/home/user/sandbox';

      // Submit form
      const form = document.querySelector('.new-agent-form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const result = await showPromise;
      expect(result).not.toBeNull();
      expect(isCustomResult(result)).toBe(true);
      if (isCustomResult(result)) {
        expect(result.hubConnectionId).toBe('hub-abc');
        expect(result.hubSandboxPath).toBe('/home/user/sandbox');
      }
    });

    it('returns undefined for empty hub fields', async () => {
      const connections: HubConnection[] = [
        { id: 'hub-abc', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      dialog.setHubClient(hubClient);

      const showPromise = dialog.show(mockTools, 1);

      // Don't select any hub (keep default "None")

      // Submit form
      const form = document.querySelector('.new-agent-form') as HTMLFormElement;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      const result = await showPromise;
      expect(result).not.toBeNull();
      expect(isCustomResult(result)).toBe(true);
      if (isCustomResult(result)) {
        expect(result.hubConnectionId).toBeUndefined();
        expect(result.hubSandboxPath).toBeUndefined();
      }
    });
  });
});
