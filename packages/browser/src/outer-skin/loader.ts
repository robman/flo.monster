import type { OuterSkinManifest } from '@flo-monster/core';

/** Maps domain to skin ID */
const DOMAIN_SKIN_MAP: Record<string, string> = {
  'flo.monster': 'flo-monster',
  'www.flo.monster': 'flo-monster',
  't.flo.monster': 'flo-monster',
};

/** Default skin for localhost and unknown domains */
const DEFAULT_SKIN = 'installer';

/**
 * Loaded outer skin with all assets resolved
 */
export interface LoadedOuterSkin {
  manifest: OuterSkinManifest;
  content: string;
  styles: string;
  script?: string;
}

/**
 * Get skin ID based on current domain or URL override
 */
export function getSkinId(): string {
  // Check for ?skin= URL param (dev override)
  const params = new URLSearchParams(window.location.search);
  const skinOverride = params.get('skin');
  if (skinOverride) {
    if (/^[a-zA-Z0-9_-]+$/.test(skinOverride)) {
      return skinOverride;
    }
    console.warn(`[skin] Invalid skin ID "${skinOverride}", using default`);
  }

  // Map domain to skin ID
  const hostname = window.location.hostname;
  return DOMAIN_SKIN_MAP[hostname] || DEFAULT_SKIN;
}

/**
 * Get base URL for skin assets
 */
export function getSkinBaseUrl(skinId: string): string {
  return `/skins/${skinId}`;
}

/**
 * Load an outer skin by ID
 */
export async function loadOuterSkin(skinId: string): Promise<LoadedOuterSkin> {
  const baseUrl = getSkinBaseUrl(skinId);

  // Load manifest first
  const manifestResponse = await fetch(`${baseUrl}/manifest.json`);
  if (!manifestResponse.ok) {
    throw new Error(`Failed to load skin manifest: ${manifestResponse.status}`);
  }
  const manifest: OuterSkinManifest = await manifestResponse.json();

  // Load content and styles in parallel
  const [contentResponse, stylesResponse] = await Promise.all([
    fetch(`${baseUrl}/${manifest.contentUrl}`),
    fetch(`${baseUrl}/${manifest.stylesUrl}`),
  ]);

  if (!contentResponse.ok) {
    throw new Error(`Failed to load skin content: ${contentResponse.status}`);
  }
  if (!stylesResponse.ok) {
    throw new Error(`Failed to load skin styles: ${stylesResponse.status}`);
  }

  const content = await contentResponse.text();
  const styles = await stylesResponse.text();

  // Optionally load script
  let script: string | undefined;
  if (manifest.scriptUrl) {
    const scriptResponse = await fetch(`${baseUrl}/${manifest.scriptUrl}`);
    if (scriptResponse.ok) {
      script = await scriptResponse.text();
    }
  }

  return { manifest, content, styles, script };
}

/**
 * Convenience function to load the current domain's skin
 */
export async function loadCurrentSkin(): Promise<LoadedOuterSkin> {
  const skinId = getSkinId();
  return loadOuterSkin(skinId);
}
