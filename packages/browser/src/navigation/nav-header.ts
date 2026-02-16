import type { OuterSkinManifest } from '@flo-monster/core';

export type NavMode = 'homepage' | 'dashboard' | 'focused';

export interface NavHeaderConfig {
  /** Logo URL from skin manifest */
  logoUrl: string;
  /** Logo alt text */
  logoAlt: string;
  /** Whether to show dashboard link (when on homepage with credentials) */
  showDashboardLink: boolean;
}

export interface NavHeaderCallbacks {
  onLogoClick: () => void;
  onDashboardClick: () => void;
}

/**
 * Navigation header with logo and context-sensitive links.
 * Shows:
 * - Logo (left) - always visible, clicks to homepage
 * - Dashboard link (right) - when on homepage with credentials
 * - Home link (right) - when on dashboard
 * - Hidden entirely when in focused agent view
 */
export class NavHeader {
  private container: HTMLElement;
  private mode: NavMode = 'homepage';
  private hasCredentials = false;
  private config: NavHeaderConfig;
  private callbacks: NavHeaderCallbacks;

  constructor(
    parentElement: HTMLElement,
    config: NavHeaderConfig,
    callbacks: NavHeaderCallbacks
  ) {
    this.config = config;
    this.callbacks = callbacks;

    this.container = document.createElement('nav');
    this.container.id = 'nav-header';
    this.container.className = 'nav-header';

    parentElement.insertBefore(this.container, parentElement.firstChild);
    this.render();
  }

  /**
   * Update navigation mode
   */
  setMode(mode: NavMode): void {
    this.mode = mode;
    this.render();
  }

  /**
   * Update credentials status
   */
  setHasCredentials(hasCredentials: boolean): void {
    this.hasCredentials = hasCredentials;
    this.render();
  }

  /**
   * Get current mode
   */
  getMode(): NavMode {
    return this.mode;
  }

  private render(): void {
    // Hidden in focused mode and dashboard mode (top-bar handles dashboard nav)
    if (this.mode === 'focused' || this.mode === 'dashboard') {
      this.container.hidden = true;
      return;
    }

    this.container.hidden = false;
    this.container.innerHTML = '';

    // Logo (left side)
    const logo = document.createElement('a');
    logo.className = 'nav-header__logo';
    logo.href = '#';
    logo.addEventListener('click', (e) => {
      e.preventDefault();
      this.callbacks.onLogoClick();
    });

    if (this.config.logoUrl) {
      const logoImg = document.createElement('img');
      logoImg.src = this.config.logoUrl;
      logoImg.alt = this.config.logoAlt;
      logoImg.className = 'nav-header__logo-img';
      logo.appendChild(logoImg);
    } else {
      // Fallback text logo
      logo.textContent = 'flo.monster';
    }

    this.container.appendChild(logo);

    // Right side links
    const links = document.createElement('div');
    links.className = 'nav-header__links';

    // Dashboard link (shown on homepage when has credentials)
    if (this.mode === 'homepage' && this.hasCredentials && this.config.showDashboardLink) {
      const dashboardLink = document.createElement('a');
      dashboardLink.className = 'nav-header__link';
      dashboardLink.href = '#';
      dashboardLink.textContent = 'Dashboard';
      dashboardLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.callbacks.onDashboardClick();
      });
      links.appendChild(dashboardLink);
    }

    this.container.appendChild(links);
  }

  /**
   * Create from skin manifest
   */
  static fromManifest(
    parentElement: HTMLElement,
    manifest: OuterSkinManifest,
    baseUrl: string,
    callbacks: NavHeaderCallbacks
  ): NavHeader {
    const nav = manifest.navigation || {};
    const config: NavHeaderConfig = {
      logoUrl: nav.logoUrl ? `${baseUrl}/${nav.logoUrl}` : '',
      logoAlt: nav.logoAlt || '',
      showDashboardLink: nav.showDashboardLink ?? false,
    };
    return new NavHeader(parentElement, config, callbacks);
  }

  /**
   * Destroy and remove from DOM
   */
  destroy(): void {
    this.container.remove();
  }
}
