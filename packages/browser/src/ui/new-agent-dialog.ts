import { getModelsForProvider, getAvailableProviders } from '@flo-monster/core';
import type { ToolDef, StoredTemplate } from '@flo-monster/core';
import type { HubClient } from '../shell/hub-client.js';
import type { TemplateManager } from '../shell/template-manager.js';
import { TemplateDialog } from './template-dialog.js';
import { DEFAULT_SYSTEM_PROMPT } from '../shell/agent-manager.js';

export interface NewAgentResult {
  type: 'custom';
  name: string;
  model: string;
  provider: string;
  systemPrompt: string;
  selectedTools: string[];
  hubConnectionId?: string;
  hubSandboxPath?: string;
  maxTokens?: number;
  tokenBudget?: number;
  costBudgetUsd?: number;
  networkPolicy?: { mode: string; domains?: string[] };
  contextMode?: string;
  recentTurns?: number;
  sandboxPermissions?: { camera?: boolean; microphone?: boolean; geolocation?: boolean };
}

export interface NewAgentFromTemplateResult {
  type: 'template';
  templateName: string;
  agentName: string;
  overrides: {
    model?: string;
    maxTokens?: number;
  };
}

export class NewAgentDialog {
  private overlay: HTMLElement | null = null;
  private hubClient: HubClient | null = null;
  private templateManager: TemplateManager | null = null;

  setHubClient(client: HubClient): void {
    this.hubClient = client;
  }

  setTemplateManager(manager: TemplateManager): void {
    this.templateManager = manager;
  }

  private createSection(title: string, content: HTMLElement, open = false): HTMLElement {
    const details = document.createElement('details');
    details.className = 'settings-section';
    if (open) details.open = true;

    const summary = document.createElement('summary');
    summary.className = 'settings-section__title';
    summary.textContent = title;

    details.appendChild(summary);
    details.appendChild(content);
    return details;
  }

  show(availableTools: ToolDef[], agentNumber: number): Promise<NewAgentResult | NewAgentFromTemplateResult | null> {
    return new Promise((resolve) => {
      // Create overlay
      this.overlay = document.createElement('div');
      this.overlay.className = 'overlay';

      const card = document.createElement('div');
      card.className = 'overlay__card new-agent-dialog';
      card.style.display = 'flex';
      card.style.flexDirection = 'column';

      // Check if templates are available
      const templates = this.templateManager?.listTemplates() ?? [];
      const hasTemplates = templates.length > 0;

      // Build the header
      const header = document.createElement('h2');
      header.textContent = 'New Agent';
      card.appendChild(header);

      // Create tabs if templates are available
      let customTab: HTMLButtonElement | null = null;
      let templateTab: HTMLButtonElement | null = null;
      let customPane: HTMLElement;
      let templatePane: HTMLElement | null = null;

      if (hasTemplates) {
        const tabBar = document.createElement('div');
        tabBar.className = 'new-agent-tabs';

        customTab = document.createElement('button');
        customTab.type = 'button';
        customTab.className = 'new-agent-tab new-agent-tab--active';
        customTab.textContent = 'Custom';
        tabBar.appendChild(customTab);

        templateTab = document.createElement('button');
        templateTab.type = 'button';
        templateTab.className = 'new-agent-tab';
        templateTab.textContent = 'From Template';
        tabBar.appendChild(templateTab);

        card.appendChild(tabBar);
      }

      // Custom pane content
      customPane = document.createElement('div');
      customPane.className = 'new-agent-pane new-agent-pane--active';
      customPane.id = 'custom-pane';

      const form = document.createElement('form');
      form.className = 'new-agent-form';

      // --- Top-level fields (always visible) ---

      // Name field
      const nameField = document.createElement('div');
      nameField.className = 'form-field';
      const nameLabel = document.createElement('label');
      nameLabel.className = 'form-field__label';
      nameLabel.setAttribute('for', 'agent-name');
      nameLabel.textContent = 'Name';
      const nameInput = document.createElement('input');
      nameInput.className = 'form-field__input';
      nameInput.id = 'agent-name';
      nameInput.type = 'text';
      nameInput.value = `Agent ${agentNumber}`;
      nameField.appendChild(nameLabel);
      nameField.appendChild(nameInput);
      form.appendChild(nameField);

      // Provider field
      const providerField = document.createElement('div');
      providerField.className = 'form-field';
      const providerLabel = document.createElement('label');
      providerLabel.className = 'form-field__label';
      providerLabel.setAttribute('for', 'agent-provider');
      providerLabel.textContent = 'Provider';
      const providerSelect = document.createElement('select');
      providerSelect.className = 'form-field__select';
      providerSelect.id = 'agent-provider';
      providerField.appendChild(providerLabel);
      providerField.appendChild(providerSelect);
      form.appendChild(providerField);

      // Model field
      const modelField = document.createElement('div');
      modelField.className = 'form-field';
      const modelLabel = document.createElement('label');
      modelLabel.className = 'form-field__label';
      modelLabel.setAttribute('for', 'agent-model');
      modelLabel.textContent = 'Model';
      const modelSelect = document.createElement('select');
      modelSelect.className = 'form-field__select';
      modelSelect.id = 'agent-model';
      const modelInput = document.createElement('input');
      modelInput.className = 'form-field__input';
      modelInput.id = 'agent-model-input';
      modelInput.type = 'text';
      modelInput.placeholder = 'e.g. llama3.2, qwen2.5-coder';
      modelInput.style.display = 'none';
      const ollamaHint = document.createElement('small');
      ollamaHint.className = 'form-field__hint';
      ollamaHint.id = 'ollama-hint';
      ollamaHint.textContent = 'Requires a model with tool use support. See ollama.com/search?c=tools';
      ollamaHint.style.display = 'none';
      modelField.appendChild(modelLabel);
      modelField.appendChild(modelSelect);
      modelField.appendChild(modelInput);
      modelField.appendChild(ollamaHint);
      form.appendChild(modelField);

      // --- Collapsible sections ---

      // System Prompt section
      const promptContent = document.createElement('div');
      const promptTextarea = document.createElement('textarea');
      promptTextarea.className = 'form-field__textarea agent-settings__prompt';
      promptTextarea.id = 'agent-prompt';
      promptTextarea.rows = 8;
      promptTextarea.value = DEFAULT_SYSTEM_PROMPT;
      promptContent.appendChild(promptTextarea);
      form.appendChild(this.createSection('System Prompt', promptContent));

      // Tools section
      const toolsContent = document.createElement('div');
      const toolCheckboxesDiv = document.createElement('div');
      toolCheckboxesDiv.className = 'tool-checkboxes';
      toolCheckboxesDiv.id = 'tool-checkboxes';
      toolsContent.appendChild(toolCheckboxesDiv);
      form.appendChild(this.createSection('Tools', toolsContent));

      // Budget section
      const budgetContent = document.createElement('div');
      budgetContent.style.display = 'flex';
      budgetContent.style.flexDirection = 'column';
      budgetContent.style.gap = 'var(--spacing-sm)';
      const maxTokensField = document.createElement('div');
      maxTokensField.className = 'form-field';
      const maxTokensLabel = document.createElement('label');
      maxTokensLabel.className = 'form-field__label';
      maxTokensLabel.setAttribute('for', 'agent-max-tokens');
      maxTokensLabel.textContent = 'Max Tokens per Response';
      const maxTokensInput = document.createElement('input');
      maxTokensInput.className = 'form-field__input';
      maxTokensInput.id = 'agent-max-tokens';
      maxTokensInput.type = 'number';
      maxTokensInput.placeholder = '4096';
      maxTokensField.appendChild(maxTokensLabel);
      maxTokensField.appendChild(maxTokensInput);
      budgetContent.appendChild(maxTokensField);
      const costField = document.createElement('div');
      costField.className = 'form-field';
      const costLabel = document.createElement('label');
      costLabel.className = 'form-field__label';
      costLabel.setAttribute('for', 'agent-cost-budget');
      costLabel.textContent = 'Cost Budget (USD)';
      const costInput = document.createElement('input');
      costInput.className = 'form-field__input';
      costInput.id = 'agent-cost-budget';
      costInput.type = 'number';
      costInput.step = '0.01';
      costInput.placeholder = 'No limit';
      costField.appendChild(costLabel);
      costField.appendChild(costInput);
      budgetContent.appendChild(costField);
      form.appendChild(this.createSection('Budget', budgetContent));

      // Network Policy section
      const networkContent = document.createElement('div');
      networkContent.style.display = 'flex';
      networkContent.style.flexDirection = 'column';
      networkContent.style.gap = 'var(--spacing-sm)';
      const modeField = document.createElement('div');
      modeField.className = 'form-field';
      const modeLabel = document.createElement('label');
      modeLabel.className = 'form-field__label';
      modeLabel.setAttribute('for', 'agent-network-mode');
      modeLabel.textContent = 'Mode';
      const modeSelect = document.createElement('select');
      modeSelect.className = 'form-field__select';
      modeSelect.id = 'agent-network-mode';
      for (const [val, text] of [['allow-all', 'Allow All'], ['allowlist', 'Allowlist'], ['blocklist', 'Blocklist']]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        modeSelect.appendChild(opt);
      }
      modeField.appendChild(modeLabel);
      modeField.appendChild(modeSelect);
      networkContent.appendChild(modeField);
      const domainsField = document.createElement('div');
      domainsField.className = 'form-field';
      const domainsLabel = document.createElement('label');
      domainsLabel.className = 'form-field__label';
      domainsLabel.setAttribute('for', 'agent-network-domains');
      domainsLabel.textContent = 'Domains (one per line)';
      const domainsTextarea = document.createElement('textarea');
      domainsTextarea.className = 'form-field__textarea';
      domainsTextarea.id = 'agent-network-domains';
      domainsTextarea.rows = 3;
      domainsTextarea.placeholder = 'example.com';
      domainsField.appendChild(domainsLabel);
      domainsField.appendChild(domainsTextarea);
      networkContent.appendChild(domainsField);
      form.appendChild(this.createSection('Network Policy', networkContent));

      // Hub section (conditional)
      const hubContent = document.createElement('div');
      hubContent.style.display = 'flex';
      hubContent.style.flexDirection = 'column';
      hubContent.style.gap = 'var(--spacing-sm)';
      const hubField = document.createElement('div');
      hubField.className = 'form-field';
      const hubLabel = document.createElement('label');
      hubLabel.className = 'form-field__label';
      hubLabel.setAttribute('for', 'agent-hub');
      hubLabel.textContent = 'Hub Connection';
      const hubSelect = document.createElement('select');
      hubSelect.className = 'form-field__select new-agent-hub-select';
      hubSelect.id = 'agent-hub';
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = 'None (first available)';
      hubSelect.appendChild(noneOption);
      hubField.appendChild(hubLabel);
      hubField.appendChild(hubSelect);
      hubContent.appendChild(hubField);
      const sandboxField = document.createElement('div');
      sandboxField.className = 'form-field';
      sandboxField.id = 'sandbox-section';
      sandboxField.style.display = 'none';
      const sandboxLabel = document.createElement('label');
      sandboxLabel.className = 'form-field__label';
      sandboxLabel.setAttribute('for', 'agent-sandbox-path');
      sandboxLabel.textContent = 'Sandbox Path (optional)';
      const sandboxInput = document.createElement('input');
      sandboxInput.className = 'form-field__input new-agent-sandbox-path';
      sandboxInput.id = 'agent-sandbox-path';
      sandboxInput.type = 'text';
      sandboxInput.placeholder = '/path/to/sandbox';
      sandboxField.appendChild(sandboxLabel);
      sandboxField.appendChild(sandboxInput);
      hubContent.appendChild(sandboxField);
      // Only add hub section if hub is available
      let hubSectionEl: HTMLElement | null = null;
      if (this.hubClient) {
        const connections = this.hubClient.getConnections();
        if (connections.length > 0) {
          for (const conn of connections) {
            const option = document.createElement('option');
            option.value = conn.id;
            option.textContent = conn.name + (conn.connected ? '' : ' (disconnected)');
            hubSelect.appendChild(option);
          }
          hubSelect.addEventListener('change', () => {
            sandboxField.style.display = hubSelect.value ? 'block' : 'none';
          });
          hubSectionEl = this.createSection('Hub', hubContent);
          form.appendChild(hubSectionEl);
        }
      }

      // Context Strategy section
      const contextContent = document.createElement('div');
      contextContent.style.display = 'flex';
      contextContent.style.flexDirection = 'column';
      contextContent.style.gap = 'var(--spacing-sm)';
      const contextModeField = document.createElement('div');
      contextModeField.className = 'form-field';
      const contextModeLabel = document.createElement('label');
      contextModeLabel.className = 'form-field__label';
      contextModeLabel.setAttribute('for', 'agent-context-mode');
      contextModeLabel.textContent = 'Context Mode';
      const contextModeSelect = document.createElement('select');
      contextModeSelect.className = 'form-field__select';
      contextModeSelect.id = 'agent-context-mode';
      for (const [val, text] of [['slim', 'Slim (recommended)'], ['full', 'Full']]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        contextModeSelect.appendChild(opt);
      }
      contextModeField.appendChild(contextModeLabel);
      contextModeField.appendChild(contextModeSelect);
      contextContent.appendChild(contextModeField);
      const recentTurnsField = document.createElement('div');
      recentTurnsField.className = 'form-field';
      const recentTurnsLabel = document.createElement('label');
      recentTurnsLabel.className = 'form-field__label';
      recentTurnsLabel.setAttribute('for', 'agent-recent-turns');
      recentTurnsLabel.textContent = 'Recent Turns (slim mode)';
      const recentTurnsInput = document.createElement('input');
      recentTurnsInput.className = 'form-field__input';
      recentTurnsInput.id = 'agent-recent-turns';
      recentTurnsInput.type = 'number';
      recentTurnsInput.placeholder = '3';
      recentTurnsField.appendChild(recentTurnsLabel);
      recentTurnsField.appendChild(recentTurnsInput);
      contextContent.appendChild(recentTurnsField);
      form.appendChild(this.createSection('Context Strategy', contextContent));

      // Sandbox Permissions section
      const sandboxPermsContent = document.createElement('div');
      sandboxPermsContent.style.display = 'flex';
      sandboxPermsContent.style.flexDirection = 'column';
      sandboxPermsContent.style.gap = 'var(--spacing-sm)';
      for (const [id, label] of [['agent-perm-camera', 'Camera'], ['agent-perm-mic', 'Microphone'], ['agent-perm-geo', 'Geolocation']]) {
        const toggleRow = document.createElement('label');
        toggleRow.style.display = 'flex';
        toggleRow.style.alignItems = 'center';
        toggleRow.style.gap = 'var(--spacing-sm)';
        toggleRow.style.cursor = 'pointer';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;
        const span = document.createElement('span');
        span.textContent = label;
        span.style.fontSize = '13px';
        span.style.color = 'var(--color-text-secondary)';
        toggleRow.appendChild(checkbox);
        toggleRow.appendChild(span);
        sandboxPermsContent.appendChild(toggleRow);
      }
      form.appendChild(this.createSection('Sandbox Permissions', sandboxPermsContent));

      customPane.appendChild(form);

      // Scrollable body wraps panes
      const scrollBody = document.createElement('div');
      scrollBody.className = 'new-agent-dialog__body';
      scrollBody.style.flex = '1';
      scrollBody.style.overflowY = 'auto';
      scrollBody.style.minHeight = '0';
      scrollBody.appendChild(customPane);

      const cleanup = () => {
        if (this.overlay) {
          this.overlay.remove();
          this.overlay = null;
        }
      };

      // Template pane content (only if templates available)
      if (hasTemplates) {
        templatePane = document.createElement('div');
        templatePane.className = 'new-agent-pane';
        templatePane.id = 'template-pane';
        this.renderTemplateList(templatePane, templates, cleanup, resolve);
        scrollBody.appendChild(templatePane);

        // Tab switching
        customTab!.addEventListener('click', () => {
          customTab!.classList.add('new-agent-tab--active');
          templateTab!.classList.remove('new-agent-tab--active');
          customPane.classList.add('new-agent-pane--active');
          templatePane!.classList.remove('new-agent-pane--active');
        });

        templateTab!.addEventListener('click', () => {
          templateTab!.classList.add('new-agent-tab--active');
          customTab!.classList.remove('new-agent-tab--active');
          templatePane!.classList.add('new-agent-pane--active');
          customPane.classList.remove('new-agent-pane--active');
        });
      }

      card.appendChild(scrollBody);

      // --- Persistent footer actions ---
      const actions = document.createElement('div');
      actions.className = 'form-actions new-agent-dialog__footer';
      actions.style.flexShrink = '0';
      actions.style.borderTop = '1px solid var(--color-border)';
      actions.style.paddingTop = 'var(--spacing-md)';
      actions.style.marginTop = 'var(--spacing-sm)';
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn';
      cancelBtn.id = 'dialog-cancel';
      cancelBtn.textContent = 'Cancel';
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.className = 'btn btn--primary';
      submitBtn.textContent = 'Create';
      submitBtn.addEventListener('click', () => {
        form.requestSubmit();
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(submitBtn);
      card.appendChild(actions);

      this.overlay.appendChild(card);
      document.body.appendChild(this.overlay);

      // Populate provider select
      const providers = getAvailableProviders();
      for (const provider of providers) {
        const option = document.createElement('option');
        option.value = provider;
        option.textContent = provider.charAt(0).toUpperCase() + provider.slice(1);
        if (provider === 'anthropic') option.selected = true;
        providerSelect.appendChild(option);
      }

      // Populate model select (filtered by provider)
      function populateModels(provider: string) {
        if (provider === 'ollama') {
          modelSelect.style.display = 'none';
          modelInput.style.display = '';
          ollamaHint.style.display = '';
        } else {
          modelSelect.style.display = '';
          modelInput.style.display = 'none';
          ollamaHint.style.display = 'none';
          modelSelect.innerHTML = '';
          const models = getModelsForProvider(provider);
          for (const model of models) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.displayName;
            modelSelect.appendChild(option);
          }
          if (modelSelect.options.length > 0) {
            modelSelect.selectedIndex = 0;
          }
        }
      }
      populateModels('anthropic');

      // Provider change updates models
      providerSelect.addEventListener('change', () => {
        populateModels(providerSelect.value);
      });

      // Populate tool checkboxes safely
      for (const t of availableTools) {
        const label = document.createElement('label');
        label.className = 'tool-checkbox';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = t.name;
        checkbox.checked = true;
        const span = document.createElement('span');
        span.textContent = t.name;
        label.appendChild(checkbox);
        label.appendChild(span);
        toolCheckboxesDiv.appendChild(label);
      }

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const nameVal = nameInput.value.trim() || `Agent ${agentNumber}`;
        const providerVal = providerSelect.value;
        const modelVal = providerVal === 'ollama'
          ? modelInput.value.trim()
          : modelSelect.value;
        const promptVal = promptTextarea.value;
        const checkboxes = toolCheckboxesDiv.querySelectorAll('input[type="checkbox"]:checked');

        const maxTokensVal = (form.querySelector('#agent-max-tokens') as HTMLInputElement).value;
        const costBudgetVal = (form.querySelector('#agent-cost-budget') as HTMLInputElement).value;
        const networkModeVal = (form.querySelector('#agent-network-mode') as HTMLSelectElement).value;
        const networkDomainsVal = (form.querySelector('#agent-network-domains') as HTMLTextAreaElement).value;
        const contextModeVal = (form.querySelector('#agent-context-mode') as HTMLSelectElement).value;
        const recentTurnsVal = (form.querySelector('#agent-recent-turns') as HTMLInputElement).value;
        const cameraChecked = (form.querySelector('#agent-perm-camera') as HTMLInputElement).checked;
        const micChecked = (form.querySelector('#agent-perm-mic') as HTMLInputElement).checked;
        const geoChecked = (form.querySelector('#agent-perm-geo') as HTMLInputElement).checked;

        const result: NewAgentResult = {
          type: 'custom',
          name: nameVal,
          model: modelVal,
          provider: providerVal,
          systemPrompt: promptVal,
          selectedTools: Array.from(checkboxes).map(cb => (cb as HTMLInputElement).value),
          hubConnectionId: hubSelect?.value || undefined,
          hubSandboxPath: (form.querySelector('#agent-sandbox-path') as HTMLInputElement)?.value.trim() || undefined,
        };

        // Add optional fields only if set
        if (maxTokensVal) result.maxTokens = parseInt(maxTokensVal, 10);
        if (costBudgetVal) result.costBudgetUsd = parseFloat(costBudgetVal);
        if (networkModeVal !== 'allow-all') {
          const domains = networkDomainsVal.trim().split('\n').map(d => d.trim()).filter(Boolean);
          result.networkPolicy = { mode: networkModeVal, domains: domains.length > 0 ? domains : undefined };
        }
        if (contextModeVal !== 'slim') result.contextMode = contextModeVal;
        if (recentTurnsVal) result.recentTurns = parseInt(recentTurnsVal, 10);
        if (cameraChecked || micChecked || geoChecked) {
          result.sandboxPermissions = {};
          if (cameraChecked) result.sandboxPermissions.camera = true;
          if (micChecked) result.sandboxPermissions.microphone = true;
          if (geoChecked) result.sandboxPermissions.geolocation = true;
        }

        cleanup();
        resolve(result);
      });
    });
  }

  hide(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private renderTemplateList(
    container: HTMLElement,
    templates: StoredTemplate[],
    cleanup: () => void,
    resolve: (result: NewAgentResult | NewAgentFromTemplateResult | null) => void,
  ): void {
    const list = document.createElement('div');
    list.className = 'template-list';

    for (const template of templates) {
      const item = document.createElement('div');
      item.className = 'template-list__item';

      const info = document.createElement('div');
      info.className = 'template-list__info';

      const name = document.createElement('h4');
      name.className = 'template-list__name';
      name.textContent = template.manifest.name;
      info.appendChild(name);

      // Built-in badge
      if (template.source.type === 'builtin') {
        const badge = document.createElement('span');
        badge.className = 'template-card__badge template-card__badge--builtin';
        badge.textContent = 'Built-in';
        info.appendChild(badge);
      }

      const desc = document.createElement('p');
      desc.className = 'template-list__description';
      desc.textContent = template.manifest.description;
      info.appendChild(desc);

      const version = document.createElement('span');
      version.className = 'template-list__version';
      version.textContent = `v${template.manifest.version}`;
      info.appendChild(version);

      item.appendChild(info);

      const useBtn = document.createElement('button');
      useBtn.className = 'btn btn--primary';
      useBtn.type = 'button';
      useBtn.textContent = 'Use';
      useBtn.addEventListener('click', async () => {
        // Show template dialog for configuration
        const templateDialog = new TemplateDialog();
        const dialogResult = await templateDialog.show(template);

        if (dialogResult) {
          cleanup();
          resolve({
            type: 'template',
            templateName: dialogResult.templateName,
            agentName: dialogResult.agentName,
            overrides: dialogResult.overrides,
          });
        }
      });
      item.appendChild(useBtn);

      list.appendChild(item);
    }

    // Cancel button for template pane
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      cleanup();
      resolve(null);
    });
    actions.appendChild(cancelBtn);

    container.appendChild(list);
    container.appendChild(actions);
  }
}
