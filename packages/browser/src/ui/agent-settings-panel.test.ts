import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSettingsPanel } from './agent-settings-panel.js';
import type { HubClient, HubConnection } from '../shell/hub-client.js';

// Mock the builtin tools - define data inline to avoid hoisting issues
vi.mock('../agent/tools/builtin-tools.js', () => {
  const tools = [
    { name: 'runjs', description: 'Execute JavaScript', input_schema: { type: 'object', properties: {} } },
    { name: 'dom', description: 'Manipulate DOM', input_schema: { type: 'object', properties: {} } },
    { name: 'storage', description: 'Key-value storage', input_schema: { type: 'object', properties: {} } },
  ];
  return {
    BUILTIN_TOOL_DEFS: tools,
    getBuiltinToolDefinitions: () => [...tools],
  };
});

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

function createMockAgent(overrides?: Partial<any>) {
  return {
    id: 'agent-1',
    config: {
      id: 'agent-1',
      name: 'Test Agent',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      tools: [
        { name: 'runjs', description: 'Execute JavaScript', input_schema: { type: 'object', properties: {} } },
      ],
      maxTokens: 4096,
      ...overrides,
    },
    state: 'running',
    updateConfig: vi.fn(),
    onEvent: vi.fn(() => vi.fn()),
    ...overrides,
  } as any;
}

describe('AgentSettingsPanel', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('show/hide/toggle work correctly', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();

    expect(panel.isVisible()).toBe(false);
    panel.show(agent);
    expect(panel.isVisible()).toBe(true);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('toggle switches visibility', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();

    panel.toggle(agent);
    expect(panel.isVisible()).toBe(true);
    panel.toggle(agent);
    expect(panel.isVisible()).toBe(false);
  });

  it('renders provider and model selects', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const providerSelect = container.querySelector('.settings-provider-select') as HTMLSelectElement;
    expect(providerSelect).toBeTruthy();
    expect(providerSelect.value).toBe('anthropic');

    const modelSelect = container.querySelector('.settings-model-select') as HTMLSelectElement;
    expect(modelSelect).toBeTruthy();
    expect(modelSelect.options.length).toBeGreaterThanOrEqual(1);
    // Current model should be selected
    expect(modelSelect.value).toBe('claude-sonnet-4-20250514');
  });

  it('provider change updates model list and fires callback', () => {
    const onConfigChange = vi.fn();
    const panel = new AgentSettingsPanel(container, { onConfigChange });
    const agent = createMockAgent();
    panel.show(agent);

    const providerSelect = container.querySelector('.settings-provider-select') as HTMLSelectElement;
    providerSelect.value = 'openai';
    providerSelect.dispatchEvent(new Event('change'));

    // Should update both provider and model
    expect(agent.updateConfig).toHaveBeenCalled();
    const call = (agent.updateConfig as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.provider).toBe('openai');
    expect(call.model).toBeDefined();

    // Model select should now show OpenAI models
    const modelSelect = container.querySelector('.settings-model-select') as HTMLSelectElement;
    expect(modelSelect.options.length).toBeGreaterThanOrEqual(1);
  });

  it('system prompt textarea shows current value', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const textarea = container.querySelector('.agent-settings__prompt') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe('You are helpful.');
  });

  it('tool checkboxes reflect config', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const checkboxes = container.querySelectorAll('.tool-checkbox input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
    expect(checkboxes.length).toBe(3); // 3 mocked builtin tools
    // runjs should be checked (it's in the agent's tools)
    const runjsCheckbox = checkboxes[0];
    expect(runjsCheckbox.checked).toBe(true);
    // dom should NOT be checked
    const domCheckbox = checkboxes[1];
    expect(domCheckbox.checked).toBe(false);
  });

  it('budget inputs are present', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    expect(container.querySelector('.agent-settings__max-tokens')).toBeTruthy();
    expect(container.querySelector('.agent-settings__cost-budget')).toBeTruthy();
  });

  it('model change fires callback and calls updateConfig', () => {
    const onConfigChange = vi.fn();
    const panel = new AgentSettingsPanel(container, { onConfigChange });
    const agent = createMockAgent();
    panel.show(agent);

    const select = container.querySelector('.settings-model-select') as HTMLSelectElement;
    // Change the model
    select.value = 'claude-opus-4-20250514';
    select.dispatchEvent(new Event('change'));

    expect(agent.updateConfig).toHaveBeenCalledWith({ model: 'claude-opus-4-20250514' });
    expect(onConfigChange).toHaveBeenCalledWith('agent-1', { model: 'claude-opus-4-20250514' });
  });

  it('isVisible tracks state', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();

    expect(panel.isVisible()).toBe(false);
    panel.show(agent);
    expect(panel.isVisible()).toBe(true);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
  });

  it('renders all sections', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const sections = container.querySelectorAll('.settings-section');
    expect(sections.length).toBe(7); // Model, System Prompt, Tools, Budget, Network Policy, Context Strategy, Sandbox Permissions
  });

  it('uses details/summary elements for collapsible sections', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const sections = container.querySelectorAll('details.settings-section');
    expect(sections.length).toBe(7);
    sections.forEach(section => {
      expect(section.querySelector('summary.settings-section__title')).toBeTruthy();
    });
  });

  it('Model section is open by default, others collapsed', () => {
    const panel = new AgentSettingsPanel(container);
    const agent = createMockAgent();
    panel.show(agent);

    const sections = container.querySelectorAll('details.settings-section') as NodeListOf<HTMLDetailsElement>;
    // First section: Model (open)
    expect(sections[0].open).toBe(true);
    expect(sections[0].querySelector('summary')!.textContent).toBe('Model');
    // Second section: System Prompt (collapsed)
    expect(sections[1].open).toBe(false);
    expect(sections[1].querySelector('summary')!.textContent).toBe('System Prompt');
  });

  describe('hub section', () => {
    it('does not show hub section when no hubClient', () => {
      const panel = new AgentSettingsPanel(container);
      const agent = createMockAgent();
      panel.show(agent);

      expect(container.querySelector('.settings-hub')).toBeNull();
    });

    it('does not show hub section when hubClient has no connections', () => {
      const panel = new AgentSettingsPanel(container);
      const hubClient = createMockHubClient([]);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      expect(container.querySelector('.settings-hub')).toBeNull();
    });

    it('shows hub section when hubClient has connections', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      expect(container.querySelector('.settings-hub')).toBeTruthy();
      expect(container.querySelector('.agent-settings__hub-select')).toBeTruthy();
    });

    it('hub selector shows all connections', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
        { id: 'hub-2', name: 'Remote Hub', url: 'ws://remote:3002', connected: false, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const select = container.querySelector('.agent-settings__hub-select') as HTMLSelectElement;
      expect(select.options.length).toBe(3); // None + 2 hubs
      expect(select.options[0].value).toBe('');
      expect(select.options[1].value).toBe('hub-1');
      expect(select.options[2].value).toBe('hub-2');
    });

    it('selects current agent hub in dropdown', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
        { id: 'hub-2', name: 'Remote Hub', url: 'ws://remote:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent({ hubConnectionId: 'hub-2' });
      panel.show(agent);

      const select = container.querySelector('.agent-settings__hub-select') as HTMLSelectElement;
      expect(select.value).toBe('hub-2');
    });

    it('shows sandbox path from agent config', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent({
        hubConnectionId: 'hub-1',
        hubSandboxPath: '/home/user/sandbox',
      });
      panel.show(agent);

      const sandboxInput = container.querySelector('.settings-hub__sandbox-path') as HTMLInputElement;
      expect(sandboxInput.value).toBe('/home/user/sandbox');
    });

    it('shows empty input with placeholder when no sandbox path', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const sandboxInput = container.querySelector('.settings-hub__sandbox-path') as HTMLInputElement;
      expect(sandboxInput.value).toBe('');
      expect(sandboxInput.placeholder).toBe('(uses hub default)');
    });

    it('sandbox path change fires callback and updateConfig', () => {
      const onConfigChange = vi.fn();
      const panel = new AgentSettingsPanel(container, { onConfigChange });
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const sandboxInput = container.querySelector('.settings-hub__sandbox-path') as HTMLInputElement;
      sandboxInput.value = '/new/sandbox/path';
      sandboxInput.dispatchEvent(new Event('change'));

      expect(agent.updateConfig).toHaveBeenCalledWith({ hubSandboxPath: '/new/sandbox/path' });
      expect(onConfigChange).toHaveBeenCalledWith('agent-1', { hubSandboxPath: '/new/sandbox/path' });
    });

    it('shows hub tools for selected connection', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        {
          id: 'hub-1',
          name: 'Local Hub',
          url: 'ws://localhost:3002',
          connected: true,
          tools: [
            { name: 'bash', description: 'Run bash', input_schema: { type: 'object', properties: {} } },
            { name: 'read_file', description: 'Read file', input_schema: { type: 'object', properties: {} } },
          ],
        },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent({ hubConnectionId: 'hub-1' });
      panel.show(agent);

      const toolItems = container.querySelectorAll('.settings-hub__tool-item');
      expect(toolItems.length).toBe(2);
      expect(toolItems[0].textContent).toBe('bash');
      expect(toolItems[1].textContent).toBe('read_file');
    });

    it('updates tools list when hub selection changes', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        {
          id: 'hub-1',
          name: 'Hub 1',
          url: 'ws://localhost:3002',
          connected: true,
          tools: [{ name: 'tool-a', description: 'Tool A', input_schema: { type: 'object', properties: {} } }],
        },
        {
          id: 'hub-2',
          name: 'Hub 2',
          url: 'ws://remote:3002',
          connected: true,
          tools: [{ name: 'tool-b', description: 'Tool B', input_schema: { type: 'object', properties: {} } }],
        },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const select = container.querySelector('.agent-settings__hub-select') as HTMLSelectElement;

      // Initially no hub selected
      let toolsList = container.querySelector('.settings-hub__tools') as HTMLElement;
      expect(toolsList.textContent).toBe('(select a hub to see tools)');

      // Select hub-1
      select.value = 'hub-1';
      select.dispatchEvent(new Event('change'));
      const toolItems1 = container.querySelectorAll('.settings-hub__tool-item');
      expect(toolItems1.length).toBe(1);
      expect(toolItems1[0].textContent).toBe('tool-a');

      // Select hub-2
      select.value = 'hub-2';
      select.dispatchEvent(new Event('change'));
      const toolItems2 = container.querySelectorAll('.settings-hub__tool-item');
      expect(toolItems2.length).toBe(1);
      expect(toolItems2[0].textContent).toBe('tool-b');
    });

    it('hub change fires callback and updateConfig', () => {
      const onConfigChange = vi.fn();
      const panel = new AgentSettingsPanel(container, { onConfigChange });
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Local Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const select = container.querySelector('.agent-settings__hub-select') as HTMLSelectElement;
      select.value = 'hub-1';
      select.dispatchEvent(new Event('change'));

      expect(agent.updateConfig).toHaveBeenCalledWith({ hubConnectionId: 'hub-1' });
      expect(onConfigChange).toHaveBeenCalledWith('agent-1', { hubConnectionId: 'hub-1' });
    });
  });

  describe('hub proxy in network policy', () => {
    it('shows hub proxy toggle when hub is available', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const toggle = container.querySelector('.agent-settings__hub-proxy-toggle') as HTMLInputElement;
      expect(toggle).toBeTruthy();
      expect(toggle.checked).toBe(false); // Default is off
    });

    it('does not show hub proxy toggle when no hub available', () => {
      const panel = new AgentSettingsPanel(container);
      const agent = createMockAgent();
      panel.show(agent);

      const toggle = container.querySelector('.agent-settings__hub-proxy-toggle');
      expect(toggle).toBeNull();
    });

    it('hub proxy toggle updates agent config', () => {
      const onConfigChange = vi.fn();
      const panel = new AgentSettingsPanel(container, { onConfigChange });
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      const toggle = container.querySelector('.agent-settings__hub-proxy-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      expect(agent.updateConfig).toHaveBeenCalled();
      const updateCall = (agent.updateConfig as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(updateCall.networkPolicy?.useHubProxy).toBe(true);
    });

    it('hub proxy patterns update agent config', () => {
      const onConfigChange = vi.fn();
      const panel = new AgentSettingsPanel(container, { onConfigChange });
      const connections: HubConnection[] = [
        { id: 'hub-1', name: 'Test Hub', url: 'ws://localhost:3002', connected: true, tools: [] },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      // Enable hub proxy first
      const toggle = container.querySelector('.agent-settings__hub-proxy-toggle') as HTMLInputElement;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));

      // Enter patterns
      const textarea = container.querySelector('.agent-settings__hub-proxy-patterns') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      textarea.value = 'https://api.example.com/*\nhttps://*.internal.corp/*';
      textarea.dispatchEvent(new Event('blur'));

      expect(agent.updateConfig).toHaveBeenCalled();
      const updateCall = (agent.updateConfig as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0][0];
      expect(updateCall.networkPolicy?.hubProxyPatterns).toEqual([
        'https://api.example.com/*',
        'https://*.internal.corp/*',
      ]);
    });
  });

  describe('tool permissions', () => {
    it('shows all builtin tools as checkboxes', () => {
      const panel = new AgentSettingsPanel(container);
      const agent = createMockAgent();
      panel.show(agent);

      // Should have a builtin tools section
      const builtinSection = container.querySelector('.settings-tools__group');
      expect(builtinSection).toBeTruthy();
      expect(builtinSection?.querySelector('.settings-tools__group-label')?.textContent).toBe('Builtin Tools');

      // Should have checkboxes for all 3 mocked builtin tools
      const checkboxes = container.querySelectorAll('.tool-checkboxes .tool-checkbox input[type="checkbox"]');
      expect(checkboxes.length).toBe(3);
    });

    it('shows hub tools when hub is connected', () => {
      const panel = new AgentSettingsPanel(container);
      const connections: HubConnection[] = [
        {
          id: 'hub-1',
          name: 'Test Hub',
          url: 'ws://localhost:3002',
          connected: true,
          tools: [
            { name: 'bash', description: 'Run bash commands', input_schema: { type: 'object', properties: {} } },
            { name: 'read_file', description: 'Read files', input_schema: { type: 'object', properties: {} } },
          ],
        },
      ];
      const hubClient = createMockHubClient(connections);
      panel.setHubClient(hubClient);
      const agent = createMockAgent();
      panel.show(agent);

      // Should have hub tools section
      const hubSection = container.querySelector('.settings-tools__group--hub');
      expect(hubSection).toBeTruthy();
      expect(hubSection?.querySelector('.settings-tools__group-label')?.textContent).toBe('Hub Tools');

      // Should have checkboxes for hub tools
      const hubCheckboxes = hubSection?.querySelectorAll('.tool-checkbox--hub');
      expect(hubCheckboxes?.length).toBe(2);

      // Hub tools should have badge
      const badges = hubSection?.querySelectorAll('.tool-checkbox__badge');
      expect(badges?.length).toBe(2);
    });

    it('marks currently enabled tools as checked', () => {
      const panel = new AgentSettingsPanel(container);
      // Agent has runjs and storage enabled
      const agent = createMockAgent({
        tools: [
          { name: 'runjs', description: 'Execute JavaScript', input_schema: { type: 'object', properties: {} } },
          { name: 'storage', description: 'Key-value storage', input_schema: { type: 'object', properties: {} } },
        ],
      });
      panel.show(agent);

      const checkboxes = container.querySelectorAll('.tool-checkbox input[type="checkbox"]') as NodeListOf<HTMLInputElement>;
      // Find specific tool checkboxes
      const runjsCheckbox = Array.from(checkboxes).find(cb => cb.dataset.toolName === 'runjs');
      const domCheckbox = Array.from(checkboxes).find(cb => cb.dataset.toolName === 'dom');
      const storageCheckbox = Array.from(checkboxes).find(cb => cb.dataset.toolName === 'storage');

      expect(runjsCheckbox?.checked).toBe(true);
      expect(domCheckbox?.checked).toBe(false);
      expect(storageCheckbox?.checked).toBe(true);
    });

    it('shows "(requires restart)" when tools changed', () => {
      const panel = new AgentSettingsPanel(container);
      const agent = createMockAgent();
      panel.show(agent);

      // Initially warning should be hidden
      const warning = container.querySelector('.settings-tools__warning') as HTMLElement;
      expect(warning.style.display).toBe('none');

      // Toggle a tool
      const domCheckbox = Array.from(
        container.querySelectorAll('.tool-checkbox input[type="checkbox"]') as NodeListOf<HTMLInputElement>
      ).find(cb => cb.dataset.toolName === 'dom');
      expect(domCheckbox).toBeTruthy();
      domCheckbox!.checked = true;
      domCheckbox!.dispatchEvent(new Event('change'));

      // Warning should now be visible
      expect(warning.style.display).toBe('flex');
      expect(warning.textContent).toContain('requires restart');
    });

    it('tool toggle fires onConfigChange callback', () => {
      const onConfigChange = vi.fn();
      const panel = new AgentSettingsPanel(container, { onConfigChange });
      const agent = createMockAgent();
      panel.show(agent);

      // Toggle a tool
      const domCheckbox = Array.from(
        container.querySelectorAll('.tool-checkbox input[type="checkbox"]') as NodeListOf<HTMLInputElement>
      ).find(cb => cb.dataset.toolName === 'dom');
      domCheckbox!.checked = true;
      domCheckbox!.dispatchEvent(new Event('change'));

      expect(onConfigChange).toHaveBeenCalled();
      const [agentId, changes] = onConfigChange.mock.calls[0];
      expect(agentId).toBe('agent-1');
      expect(changes.tools).toBeDefined();
      expect(changes.tools.some((t: { name: string }) => t.name === 'dom')).toBe(true);
    });

    it('"Restart Now" button appears when tools changed and fires callback', () => {
      const onRestartAgent = vi.fn();
      const panel = new AgentSettingsPanel(container, { onRestartAgent });
      const agent = createMockAgent();
      panel.show(agent);

      // Initially restart button should be hidden (inside hidden warning)
      const warning = container.querySelector('.settings-tools__warning') as HTMLElement;
      const restartBtn = container.querySelector('.settings-tools__restart-btn') as HTMLButtonElement;
      expect(restartBtn).toBeTruthy();
      expect(warning.style.display).toBe('none');

      // Toggle a tool to trigger warning
      const domCheckbox = Array.from(
        container.querySelectorAll('.tool-checkbox input[type="checkbox"]') as NodeListOf<HTMLInputElement>
      ).find(cb => cb.dataset.toolName === 'dom');
      domCheckbox!.checked = true;
      domCheckbox!.dispatchEvent(new Event('change'));

      // Restart button should now be visible
      expect(warning.style.display).toBe('flex');
      expect(restartBtn.textContent).toBe('Restart Now');

      // Click restart button
      restartBtn.click();
      expect(onRestartAgent).toHaveBeenCalledWith('agent-1');
    });
  });
});
