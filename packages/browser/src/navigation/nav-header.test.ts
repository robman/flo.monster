import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { NavHeader, type NavHeaderConfig, type NavHeaderCallbacks } from './nav-header.js';

describe('NavHeader', () => {
  let parentElement: HTMLElement;
  let config: NavHeaderConfig;
  let callbacks: NavHeaderCallbacks;

  beforeEach(() => {
    parentElement = document.createElement('div');
    document.body.appendChild(parentElement);

    config = {
      logoUrl: '/logo.svg',
      logoAlt: 'Test Logo',
      showDashboardLink: true,
    };

    callbacks = {
      onLogoClick: vi.fn(),
      onDashboardClick: vi.fn(),
    };
  });

  afterEach(() => {
    parentElement.remove();
  });

  it('creates nav header element', () => {
    const nav = new NavHeader(parentElement, config, callbacks);

    const navEl = parentElement.querySelector('#nav-header');
    expect(navEl).not.toBeNull();
    expect(navEl?.classList.contains('nav-header')).toBe(true);
  });

  it('renders logo with image', () => {
    const nav = new NavHeader(parentElement, config, callbacks);

    const logo = parentElement.querySelector('.nav-header__logo img');
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute('src')).toBe('/logo.svg');
    expect(logo?.getAttribute('alt')).toBe('Test Logo');
  });

  it('renders text fallback when no logo URL', () => {
    config.logoUrl = '';
    const nav = new NavHeader(parentElement, config, callbacks);

    const logo = parentElement.querySelector('.nav-header__logo');
    expect(logo?.textContent).toBe('flo.monster');
  });

  it('triggers logo click callback', () => {
    const nav = new NavHeader(parentElement, config, callbacks);

    const logo = parentElement.querySelector('.nav-header__logo') as HTMLElement;
    logo.click();

    expect(callbacks.onLogoClick).toHaveBeenCalled();
  });

  it('is hidden in focused mode', () => {
    const nav = new NavHeader(parentElement, config, callbacks);

    nav.setMode('focused');

    const navEl = parentElement.querySelector('#nav-header') as HTMLElement;
    expect(navEl.hidden).toBe(true);
  });

  it('shows dashboard link on homepage with credentials', () => {
    const nav = new NavHeader(parentElement, config, callbacks);
    nav.setHasCredentials(true);
    nav.setMode('homepage');

    const dashboardLink = parentElement.querySelector('.nav-header__link');
    expect(dashboardLink?.textContent).toBe('Dashboard');
  });

  it('hides dashboard link on homepage without credentials', () => {
    const nav = new NavHeader(parentElement, config, callbacks);
    nav.setHasCredentials(false);
    nav.setMode('homepage');

    const links = parentElement.querySelectorAll('.nav-header__link');
    expect(links.length).toBe(0);
  });

  it('is hidden in dashboard mode', () => {
    const nav = new NavHeader(parentElement, config, callbacks);
    nav.setMode('dashboard');

    const navEl = parentElement.querySelector('#nav-header') as HTMLElement;
    expect(navEl.hidden).toBe(true);
  });

  it('triggers dashboard click callback', () => {
    const nav = new NavHeader(parentElement, config, callbacks);
    nav.setHasCredentials(true);
    nav.setMode('homepage');

    const dashboardLink = parentElement.querySelector('.nav-header__link') as HTMLElement;
    dashboardLink.click();

    expect(callbacks.onDashboardClick).toHaveBeenCalled();
  });

  it('destroys and removes from DOM', () => {
    const nav = new NavHeader(parentElement, config, callbacks);

    expect(parentElement.querySelector('#nav-header')).not.toBeNull();

    nav.destroy();

    expect(parentElement.querySelector('#nav-header')).toBeNull();
  });

  it('creates from manifest', () => {
    const manifest = {
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      contentUrl: 'content.html',
      stylesUrl: 'styles.css',
      homepage: { sections: ['test'], ctaAction: 'credentials' as const },
      navigation: {
        logoUrl: 'assets/logo.svg',
        logoAlt: 'Test',
        showDashboardLink: true,
      },
    };

    const nav = NavHeader.fromManifest(parentElement, manifest, '/skins/test', callbacks);

    const logo = parentElement.querySelector('.nav-header__logo img');
    expect(logo?.getAttribute('src')).toBe('/skins/test/assets/logo.svg');
  });
});
