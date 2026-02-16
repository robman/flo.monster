import type { NetworkPolicy, HookRulesConfig, StoredSkill, StoredTemplate, AgentViewState, AgentConfig } from '@flo-monster/core';
import type { KeyEntry } from './key-store.js';
import type { SavedAgentState } from './agent-manager.js';

export interface SavedHubConnection {
  url: string;
  name: string;
  token?: string;              // deprecated, migration only
  encryptedToken?: string;     // base64 ciphertext
  tokenIv?: string;            // base64 IV
}

export interface KeyStoreData {
  entries: KeyEntry[];
  defaults: Record<string, string>;
}

export type WebToolRouting = 'auto' | 'api' | 'hub' | 'browser';

export interface AppSettings {
  defaultModel: string;
  defaultProvider?: string;
  defaultBudget?: { maxTokens?: number; maxCostUsd?: number };
  enabledExtensions: string[];
  defaultNetworkPolicy?: NetworkPolicy;
  corsProxyUrl?: string;  // e.g., "https://proxy.flo.monster"
  useBuiltinProxy?: boolean;  // Default true for dev
  hubConnections?: SavedHubConnection[];
  keyStoreData?: KeyStoreData;
  defaultWebToolRouting?: WebToolRouting;  // Default routing for web_fetch/web_search
  defaultHubSandboxPath?: string;  // Default sandbox path for hub tools
  hookRules?: HookRulesConfig;  // Declarative hook rules configuration
  installedSkills?: StoredSkill[];  // NEW: installed skills
  installedTemplates?: StoredTemplate[];  // Installed agent templates
  apiBaseUrl?: string;  // e.g., 'https://api.flo.monster' — routes API requests to external domain
  apiKeySource?: 'local' | 'hub';  // Which API key source to use
  hubForApiKey?: string;           // Connection ID of hub providing API key
  hasSeenHomepage?: boolean;       // Set to true after first successful credential setup
  globalUsage?: { input_tokens: number; output_tokens: number };  // Global token usage for cost display
}

export interface AgentMetadata {
  id: string;
  name: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  totalCost: number;
  terminated: boolean;
  viewState?: AgentViewState;  // Defaults to 'max' if not specified
}

export interface PersistedConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: Array<{
    id: string;
    name: string;
    input: string;
    result?: string;
    isError?: boolean;
  }>;
}

const DB_NAME = 'flo-app';
const DB_VERSION = 1;
const STORE_SETTINGS = 'settings';
const STORE_AGENTS = 'agents';
const STORE_CONVERSATIONS = 'conversations';

export class PersistenceLayer {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_AGENTS)) {
          db.createObjectStore(STORE_AGENTS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
          db.createObjectStore(STORE_CONVERSATIONS, { keyPath: 'agentId' });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  // === Settings ===

  async getSettings(): Promise<AppSettings> {
    const defaults: AppSettings = {
      defaultModel: 'claude-sonnet-4-20250514',
      enabledExtensions: [],
    };

    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const store = tx.objectStore(STORE_SETTINGS);
      const request = store.get('app-settings');

      request.onsuccess = () => {
        if (request.result) {
          resolve({ ...defaults, ...request.result.value });
        } else {
          resolve(defaults);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveSettings(settings: AppSettings): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_SETTINGS).put({ key: 'app-settings', value: settings });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Agents ===

  async saveAgent(
    config: {
      id: string;
      name: string;
      model: string;
      systemPrompt?: string;
      tools: Array<Record<string, unknown>>;
      maxTokens: number;
    },
    metadata: AgentMetadata,
  ): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AGENTS, 'readwrite');
      tx.objectStore(STORE_AGENTS).put({
        id: metadata.id,
        config,
        metadata,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadAgent(id: string): Promise<{ config: Record<string, unknown>; metadata: AgentMetadata } | null> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AGENTS, 'readonly');
      const request = tx.objectStore(STORE_AGENTS).get(id);
      request.onsuccess = () => {
        if (request.result) {
          resolve({ config: request.result.config, metadata: request.result.metadata });
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  }

  async listAgents(): Promise<AgentMetadata[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AGENTS, 'readonly');
      const request = tx.objectStore(STORE_AGENTS).getAll();
      request.onsuccess = () => {
        resolve((request.result || []).map((r: { metadata: AgentMetadata }) => r.metadata));
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteAgent(id: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_AGENTS, STORE_CONVERSATIONS], 'readwrite');
      tx.objectStore(STORE_AGENTS).delete(id);
      tx.objectStore(STORE_CONVERSATIONS).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async updateAgentMetadata(id: string, updates: Partial<AgentMetadata>): Promise<void> {
    const existing = await this.loadAgent(id);
    if (!existing) return;

    const updated = { ...existing.metadata, ...updates };
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_AGENTS, 'readwrite');
      tx.objectStore(STORE_AGENTS).put({
        id,
        config: existing.config,
        metadata: updated,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Agent Registry (for reload persistence) ===

  /**
   * Save the active agent registry for reload persistence.
   * This stores the minimal state needed to restore agents after a page reload.
   */
  async saveAgentRegistry(agents: SavedAgentState[]): Promise<void> {
    const db = this.ensureDb();
    console.log(`[flo:persist] IDB saveAgentRegistry: writing ${agents.length} agent(s) to '${STORE_SETTINGS}' store`);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_SETTINGS).put({
        key: 'agent-registry',
        value: agents,
        savedAt: Date.now(),
      });
      tx.oncomplete = () => {
        console.log(`[flo:persist] IDB saveAgentRegistry: tx complete — ${agents.length} agent(s) saved`);
        resolve();
      };
      tx.onerror = () => {
        console.error(`[flo:persist] IDB saveAgentRegistry: tx error`, tx.error);
        reject(tx.error);
      };
    });
  }

  /**
   * Load the saved agent registry for reload restoration.
   * Returns empty array if no saved registry exists.
   */
  async loadAgentRegistry(): Promise<SavedAgentState[]> {
    const db = this.ensureDb();
    console.log(`[flo:persist] IDB loadAgentRegistry: reading from '${STORE_SETTINGS}' store`);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const request = tx.objectStore(STORE_SETTINGS).get('agent-registry');
      request.onsuccess = () => {
        if (request.result && Array.isArray(request.result.value)) {
          const agents = request.result.value;
          const savedAt = request.result.savedAt;
          const ageSec = savedAt ? ((Date.now() - savedAt) / 1000).toFixed(1) : '?';
          console.log(`[flo:persist] IDB loadAgentRegistry: found ${agents.length} agent(s), saved ${ageSec}s ago`, agents.map((a: SavedAgentState) => `${a.name}(${a.state})`));
          resolve(agents);
        } else {
          console.log(`[flo:persist] IDB loadAgentRegistry: no saved registry found (result: ${JSON.stringify(request.result)})`);
          resolve([]);
        }
      };
      request.onerror = () => {
        console.error(`[flo:persist] IDB loadAgentRegistry: error`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear the agent registry (e.g., after successful restore or explicit clear)
   */
  async clearAgentRegistry(): Promise<void> {
    const db = this.ensureDb();
    console.log(`[flo:persist] IDB clearAgentRegistry: deleting 'agent-registry' key`);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      tx.objectStore(STORE_SETTINGS).delete('agent-registry');
      tx.oncomplete = () => {
        console.log(`[flo:persist] IDB clearAgentRegistry: tx complete`);
        resolve();
      };
      tx.onerror = () => {
        console.error(`[flo:persist] IDB clearAgentRegistry: tx error`, tx.error);
        reject(tx.error);
      };
    });
  }

  // === Conversations ===

  async appendMessage(agentId: string, message: PersistedConversationMessage): Promise<void> {
    // Load existing conversation
    const existing = await this.loadConversation(agentId);
    existing.push(message);

    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put({
        agentId,
        messages: existing,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadConversation(agentId: string): Promise<PersistedConversationMessage[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
      const request = tx.objectStore(STORE_CONVERSATIONS).get(agentId);
      request.onsuccess = () => {
        resolve(request.result?.messages || []);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteConversation(agentId: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_CONVERSATIONS, 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).delete(agentId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // === Data Management ===

  async clearAll(): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_SETTINGS, STORE_AGENTS, STORE_CONVERSATIONS],
        'readwrite',
      );
      tx.objectStore(STORE_SETTINGS).clear();
      tx.objectStore(STORE_AGENTS).clear();
      tx.objectStore(STORE_CONVERSATIONS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async exportData(): Promise<string> {
    const db = this.ensureDb();

    const getAll = (storeName: string): Promise<unknown[]> => {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    };

    const [settings, agents, conversations] = await Promise.all([
      getAll(STORE_SETTINGS),
      getAll(STORE_AGENTS),
      getAll(STORE_CONVERSATIONS),
    ]);

    return JSON.stringify({ settings, agents, conversations }, null, 2);
  }

  async importData(json: string): Promise<void> {
    const data = JSON.parse(json);

    // Schema validation
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid import data: expected an object');
    }
    if (data.settings !== undefined && !Array.isArray(data.settings)) {
      throw new Error('Invalid import data: settings must be an array');
    }
    if (data.agents !== undefined && !Array.isArray(data.agents)) {
      throw new Error('Invalid import data: agents must be an array');
    }
    if (data.conversations !== undefined && !Array.isArray(data.conversations)) {
      throw new Error('Invalid import data: conversations must be an array');
    }

    // Clear existing data
    await this.clearAll();

    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [STORE_SETTINGS, STORE_AGENTS, STORE_CONVERSATIONS],
        'readwrite',
      );

      if (data.settings) {
        for (const item of data.settings) {
          tx.objectStore(STORE_SETTINGS).put(item);
        }
      }
      if (data.agents) {
        for (const item of data.agents) {
          tx.objectStore(STORE_AGENTS).put(item);
        }
      }
      if (data.conversations) {
        for (const item of data.conversations) {
          tx.objectStore(STORE_CONVERSATIONS).put(item);
        }
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ensureDb(): IDBDatabase {
    if (!this.db) {
      throw new Error('Database not opened. Call open() first.');
    }
    return this.db;
  }
}
