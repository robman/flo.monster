/**
 * Handler for persisting agents to hub servers
 */

import type {
  SerializedSession,
  SerializedFile,
  AgentConfig,
  SessionDependencies,
  SerializedDomState,
} from '@flo-monster/core';
import { serializeSession } from '@flo-monster/core';
import type { HubClient } from './hub-client.js';
import type { MessageRelay } from './message-relay.js';
import type { AgentContainer } from '../agent/agent-container.js';
import type { SkillManager } from './skill-manager.js';
import type { ExtensionLoader } from './extension-loader.js';
import type { HookManager } from './hook-manager.js';
import { getStorageProvider } from '../storage/agent-storage.js';
import { openDB, idbGet, idbKeys } from '../utils/idb-helpers.js';

export interface PersistOptions {
  includeFiles?: boolean;
  hubConnectionId: string;
  apiKey?: string;  // Decrypted API key to transfer if hub needs it
}

export interface PersistResult {
  success: boolean;
  hubAgentId?: string;
  error?: string;
}

export class PersistHandler {
  constructor(
    private hubClient: HubClient,
    private messageRelay: MessageRelay,
    private skillManager?: SkillManager,
    private extensionLoader?: ExtensionLoader,
    private hookManager?: HookManager,
  ) {}

  /**
   * Persist an agent to a hub server
   */
  async persistAgent(
    agent: AgentContainer,
    options: PersistOptions,
  ): Promise<PersistResult> {
    try {
      const connection = this.hubClient.getConnection(options.hubConnectionId);
      if (!connection || !connection.connected) {
        return {
          success: false,
          error: 'Hub not connected: ' + options.hubConnectionId,
        };
      }

      // Load conversation history from OPFS
      const conversation = await this.messageRelay.loadConversationContext(agent.id);

      // Load storage data
      const storage = await this.loadStorageData(agent.id);

      // Optionally load files from OPFS
      let files: SerializedFile[] | undefined;
      if (options.includeFiles) {
        files = await this.loadAgentFiles(agent.id);
      }

      // Capture DOM state
      let domState: SerializedDomState | undefined;
      try {
        const captured = await agent.captureDomState();
        if (captured) {
          domState = captured;
        }
      } catch {
        // DOM state capture failed, continue without it
      }

      // Get skill dependencies
      const skillDeps = this.skillManager?.getAgentSkillDependencies(agent.id) ?? [];

      // Get extension dependencies
      const extensionDeps = this.extensionLoader?.getAgentExtensionDependencies(agent.id) ?? [];

      // Get hook config rules
      const hooks = this.hookManager?.exportConfigRules();

      const dependencies: SessionDependencies = {
        skills: skillDeps,
        extensions: extensionDeps,
        hooks: Object.keys(hooks || {}).length > 0 ? hooks : undefined,
      };

      // Create the serialized session
      const session = serializeSession(
        agent.id,
        agent.config,
        conversation,
        storage,
        {
          createdAt: Date.now(), // Would ideally come from agent metadata
          totalTokens: 0,       // Would ideally track this on the agent
          totalCost: 0,         // Would ideally track this on the agent
        },
        { files, dependencies, domState },
      );

      // Check if hub needs an API key for this provider
      const provider = agent.config.provider || 'anthropic';
      const hubHasKey = connection.sharedProviders?.includes(provider) ?? false;

      let apiKey: string | undefined;
      let apiKeyProvider: string | undefined;

      if (!hubHasKey && options.apiKey) {
        apiKey = options.apiKey;
        apiKeyProvider = provider;
      }

      // Send to hub via WebSocket
      const result = await this.sendPersistRequest(options.hubConnectionId, session, apiKey, apiKeyProvider);

      return result;
    } catch (err) {
      return {
        success: false,
        error: String(err),
      };
    }
  }

  /**
   * Restore an agent from a hub server
   */
  async restoreAgent(
    hubConnectionId: string,
    hubAgentId: string,
  ): Promise<SerializedSession | null> {
    try {
      const connection = this.hubClient.getConnection(hubConnectionId);
      if (!connection || !connection.connected) {
        return null;
      }

      const result = await this.sendRestoreRequest(hubConnectionId, hubAgentId);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Load storage data from IndexedDB for an agent
   */
  private async loadStorageData(agentId: string): Promise<Record<string, unknown>> {
    try {
      const dbName = `flo-agent-${agentId}`;
      const db = await openDB(dbName);
      const storage: Record<string, unknown> = {};

      const keys = await idbKeys(db, 'store');
      for (const key of keys) {
        storage[key] = await idbGet(db, 'store', key);
      }

      db.close();
      return storage;
    } catch {
      return {};
    }
  }

  /**
   * Load files from storage for an agent
   */
  private async loadAgentFiles(agentId: string): Promise<SerializedFile[]> {
    try {
      const provider = await getStorageProvider();
      return await provider.exportFiles(agentId);
    } catch {
      return [];
    }
  }

  /**
   * Send a persist request to the hub
   */
  private async sendPersistRequest(
    connectionId: string,
    session: SerializedSession,
    apiKey?: string,
    apiKeyProvider?: string,
  ): Promise<PersistResult> {
    try {
      const result = await this.hubClient.persistAgent(connectionId, session, [], apiKey, apiKeyProvider);
      return {
        success: result.success,
        hubAgentId: result.hubAgentId || undefined,
        error: result.error,
      };
    } catch (err) {
      return {
        success: false,
        error: String(err),
      };
    }
  }

  /**
   * Send a restore request to the hub
   */
  private async sendRestoreRequest(
    connectionId: string,
    hubAgentId: string,
  ): Promise<SerializedSession | null> {
    try {
      const session = await this.hubClient.restoreAgent(connectionId, hubAgentId);
      if (!session) {
        return null;
      }
      return session as SerializedSession;
    } catch {
      return null;
    }
  }
}
