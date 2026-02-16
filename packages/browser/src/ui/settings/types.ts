/**
 * Shared types for settings panel sections
 */

import type { NetworkPolicy } from '@flo-monster/core';
import type { PersistenceLayer, AppSettings, WebToolRouting } from '../../shell/persistence.js';
import type { ExtensionLoader } from '../../shell/extension-loader.js';
import type { HubClient } from '../../shell/hub-client.js';
import type { KeyStore } from '../../shell/key-store.js';

export interface SettingsSectionDeps {
  persistence: PersistenceLayer;
  extensionLoader?: ExtensionLoader;
  hubClient?: HubClient;
  keyStore?: KeyStore;
  onApiKeyChange?: (key: string, provider?: string) => void;
  onApiKeyDelete?: (provider?: string, hash?: string) => void;
  onProxySettingsChange?: (settings: { corsProxyUrl?: string; useBuiltinProxy?: boolean }) => void;
}

export type { NetworkPolicy, AppSettings, WebToolRouting };
