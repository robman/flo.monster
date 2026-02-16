/**
 * Browser context management for identifying browser instances.
 * Used for Topic 17 (multi-browser) support preparation.
 */

const BROWSER_ID_KEY = 'flo-browser-id';
const BROWSER_LABEL_KEY = 'flo-browser-label';

/**
 * Generate a UUID v4
 */
function generateUUID(): string {
  // Use crypto.randomUUID if available (modern browsers)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback for older browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Get the browser ID for this session.
 * Creates and stores a new UUID if one doesn't exist.
 * Uses sessionStorage so each browser tab/window gets a unique ID.
 */
export function getBrowserId(): string {
  if (typeof sessionStorage === 'undefined') {
    // Fallback for non-browser environments (SSR, tests)
    return generateUUID();
  }

  let id = sessionStorage.getItem(BROWSER_ID_KEY);
  if (!id) {
    id = generateUUID();
    sessionStorage.setItem(BROWSER_ID_KEY, id);
  }
  return id;
}

/**
 * Get the user-friendly label for this browser instance.
 * Returns empty string if not set.
 */
export function getBrowserLabel(): string {
  if (typeof sessionStorage === 'undefined') {
    return '';
  }
  return sessionStorage.getItem(BROWSER_LABEL_KEY) || '';
}

/**
 * Set a user-friendly label for this browser instance.
 */
export function setBrowserLabel(label: string): void {
  if (typeof sessionStorage === 'undefined') {
    return;
  }
  sessionStorage.setItem(BROWSER_LABEL_KEY, label);
}
