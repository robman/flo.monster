import type { ToolPluginRegistry, NetworkApproval } from '@flo-monster/core';
import type { HookManager } from '../hook-manager.js';
import type { HubClient } from '../hub-client.js';
import type { ExtensionLoader } from '../extension-loader.js';
import type { AuditManager } from '../audit-manager.js';
import type { AgentStorageProvider } from '../../storage/agent-storage.js';
import type { NetworkIndicator } from '../../ui/network-indicator.js';
import type { NetworkApprovalDialog } from '../../ui/network-approval-dialog.js';

export interface ProxySettings {
  corsProxyUrl?: string;
  useBuiltinProxy?: boolean;
}

/**
 * Shared context object passed to handler functions.
 * Provides access to MessageRelay's dependencies without exposing the full class.
 */
export interface RelayContext {
  pluginRegistry: ToolPluginRegistry | null;
  hookManager: HookManager | null;
  hubClient: HubClient | null;
  extensionLoader: ExtensionLoader | null;
  auditManager: AuditManager | null;
  networkIndicator: NetworkIndicator | null;
  proxySettings: ProxySettings;
  networkApprovals: Map<string, NetworkApproval>;
  approvalDialog: NetworkApprovalDialog | null;
  setApprovalDialog(dialog: NetworkApprovalDialog): void;
  getProvider(): Promise<AgentStorageProvider>;
}
