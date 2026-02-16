/**
 * Mobile viewport detection utilities
 */

export const MOBILE_BREAKPOINT = 768;

/**
 * Check if current viewport is mobile-sized (< 768px width)
 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
}

/**
 * Subscribe to viewport mode changes.
 * Callback is called with true when viewport becomes mobile, false when desktop.
 * Returns a cleanup function to unsubscribe.
 */
export function onViewportChange(callback: (isMobile: boolean) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);

  const handler = (e: MediaQueryListEvent) => {
    callback(e.matches);
  };

  // Modern browsers use addEventListener, older use addListener
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener('change', handler);
  } else {
    // Fallback for older browsers
    mediaQuery.addListener(handler);
  }

  // Return cleanup function
  return () => {
    if (mediaQuery.removeEventListener) {
      mediaQuery.removeEventListener('change', handler);
    } else {
      mediaQuery.removeListener(handler);
    }
  };
}
