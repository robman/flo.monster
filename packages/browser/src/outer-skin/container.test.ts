import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OuterSkinContainer } from './container.js';
import type { LoadedOuterSkin } from './loader.js';

describe('OuterSkinContainer', () => {
  let parentElement: HTMLElement;
  let mockSkin: LoadedOuterSkin;

  beforeEach(() => {
    parentElement = document.createElement('div');
    document.body.appendChild(parentElement);

    mockSkin = {
      manifest: {
        id: 'test-skin',
        name: 'Test Skin',
        version: '1.0.0',
        contentUrl: 'content.html',
        stylesUrl: 'styles.css',
        homepage: { sections: ['test'], ctaAction: 'credentials' as const },
        navigation: {
          logoUrl: 'assets/logo.svg',
          logoAlt: 'Test',
          showDashboardLink: true,
        },
      },
      content: '<div class="test-content">Hello</div>',
      styles: '.test-content { color: blue; }',
    };
  });

  afterEach(() => {
    parentElement.remove();
  });

  it('creates container with shadow DOM', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    const containerEl = parentElement.querySelector('#outer-skin-container');
    expect(containerEl).not.toBeNull();
    expect(containerEl?.shadowRoot).not.toBeNull();
  });

  it('injects styles into shadow DOM', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    const style = container.getShadowRoot().querySelector('style');
    expect(style?.textContent).toContain('.test-content');
  });

  it('injects content into shadow DOM', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    const content = container.querySelector('.test-content');
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe('Hello');
  });

  it('shows and hides container', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    expect(container.isVisible()).toBe(false);

    container.show();
    expect(container.isVisible()).toBe(true);

    container.hide();
    expect(container.isVisible()).toBe(false);
  });

  it('rewrites asset URLs in content', () => {
    mockSkin.content = '<img src="assets/logo.svg">';
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/skins/test-skin/assets/logo.svg');
  });

  it('rewrites asset URLs in styles', () => {
    mockSkin.styles = '.bg { background: url("assets/bg.png"); }';
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    const style = container.getShadowRoot().querySelector('style');
    expect(style?.textContent).toContain("/skins/test-skin/assets/bg.png");
  });

  it('returns manifest', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    expect(container.getManifest()).toEqual(mockSkin.manifest);
  });

  it('destroys container', () => {
    const container = new OuterSkinContainer(parentElement, mockSkin, '/skins/test-skin');

    expect(parentElement.querySelector('#outer-skin-container')).not.toBeNull();

    container.destroy();

    expect(parentElement.querySelector('#outer-skin-container')).toBeNull();
  });
});
