/**
 * PWA install button handler.
 * - Chromium: beforeinstallprompt → native install prompt, fallback to guide
 * - iOS/iPadOS: show guided modal (no beforeinstallprompt support)
 * - Standalone mode: hide button entirely
 */

let deferredPrompt: Event | null = null;

function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isChromium(): boolean {
  return /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
  // iOS Safari standalone check
  if ((navigator as any).standalone === true) return true;
  // Persisted flag from appinstalled event (fallback for browsers where
  // display-mode media query doesn't match reliably in installed PWAs)
  if (localStorage.getItem('flo-app-installed') === '1') return true;
  return false;
}

function showInstallGuide(platform: 'ios' | 'chromium'): void {
  // Don't create multiple overlays
  if (document.getElementById('ios-install-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'ios-install-overlay';
  overlay.className = 'overlay';

  const card = document.createElement('div');
  card.className = 'overlay__card';

  if (platform === 'ios') {
    card.innerHTML = `
      <h2>Install flo.monster</h2>
      <p>Add this app to your home screen for the best experience:</p>
      <ol class="ios-install-steps">
        <li>Tap the <strong>Share</strong> button (square with arrow) in Safari's toolbar</li>
        <li>Scroll down and tap <strong>"Add to Home Screen"</strong></li>
        <li>Tap <strong>"Add"</strong> in the top right</li>
      </ol>
      <p class="overlay__note">The app will open full-screen with its own icon, just like a native app.</p>
      <div class="ios-install-actions">
        <button class="btn btn--primary" id="ios-install-dismiss">Got it</button>
      </div>
    `;
  } else {
    card.innerHTML = `
      <h2>Install flo.monster</h2>
      <p>Look for the <strong>install icon</strong> in your browser's address bar:</p>
      <ol class="ios-install-steps">
        <li>Click the <span class="ios-install-steps__icon">&#11015;</span> <strong>install icon</strong> at the right end of the address bar</li>
        <li>Click <strong>"Install"</strong> in the dialog that appears</li>
      </ol>
      <p class="overlay__note">The app will open in its own window with push notifications and offline support.</p>
      <div class="ios-install-actions">
        <button class="btn btn--primary" id="ios-install-dismiss">Got it</button>
      </div>
    `;
  }

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const dismiss = document.getElementById('ios-install-dismiss');
  dismiss?.addEventListener('click', () => {
    overlay.remove();
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

export function setupPwaInstall(): void {
  deferredPrompt = null;
  const btn = document.getElementById('install-btn');
  if (!btn) return;

  // Already installed as standalone — hide button
  if (isStandalone()) return;

  // iOS/iPadOS: show button immediately, click opens guide modal
  if (isIos()) {
    btn.hidden = false;
    btn.addEventListener('click', () => {
      showInstallGuide('ios');
    });
    return;
  }

  // Chromium path: listen for beforeinstallprompt, but also show button
  // as fallback since newer Chrome versions may not fire the event
  // (they show an install icon in the address bar instead).
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.hidden = false;
  });

  // On Chromium browsers, show the button after a short delay even if
  // beforeinstallprompt hasn't fired — Chrome's address bar install icon
  // means the app IS installable.
  if (isChromium()) {
    setTimeout(() => {
      if (!deferredPrompt) {
        btn.hidden = false;
      }
    }, 2000);
  }

  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      // Native install prompt available
      const prompt = deferredPrompt as any;
      prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') {
        btn.hidden = true;
      }
      deferredPrompt = null;
    } else {
      // No deferred prompt — show guide to Chrome's address bar icon
      showInstallGuide('chromium');
    }
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    deferredPrompt = null;
    localStorage.setItem('flo-app-installed', '1');
  });
}
