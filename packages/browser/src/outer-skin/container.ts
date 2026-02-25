import type { OuterSkinManifest } from '@flo-monster/core';
import type { LoadedOuterSkin } from './loader.js';

/**
 * Container for outer skin content using shadow DOM for style isolation.
 * The outer skin content is rendered in a shadow root to prevent style
 * bleeding between the skin and the shell.
 */
export class OuterSkinContainer {
  private container: HTMLElement;
  private shadowRoot: ShadowRoot;
  private manifest: OuterSkinManifest;
  private baseUrl: string;

  constructor(
    parentElement: HTMLElement,
    skin: LoadedOuterSkin,
    baseUrl: string
  ) {
    this.manifest = skin.manifest;
    this.baseUrl = baseUrl;

    // Create container element
    this.container = document.createElement('div');
    this.container.id = 'outer-skin-container';
    this.container.style.display = 'none';

    // Attach shadow root
    this.shadowRoot = this.container.attachShadow({ mode: 'open' });

    // Inject styles
    const styleElement = document.createElement('style');
    styleElement.textContent = this.rewriteAssetUrls(skin.styles);
    this.shadowRoot.appendChild(styleElement);

    // Inject content
    const contentWrapper = document.createElement('div');
    contentWrapper.className = 'outer-skin-content';
    contentWrapper.innerHTML = this.rewriteAssetUrls(skin.content);
    this.shadowRoot.appendChild(contentWrapper);

    // Execute script if present
    if (skin.script) {
      this.executeScript(skin.script);
    }

    // Append to parent
    parentElement.appendChild(this.container);
  }

  /**
   * Rewrite relative asset URLs to absolute URLs based on skin base URL.
   * Handles url(), src=, href= patterns.
   */
  private rewriteAssetUrls(content: string): string {
    const baseUrl = this.baseUrl;

    // Rewrite url() in CSS
    content = content.replace(
      /url\(['"]?(?!data:|https?:|\/\/)(\.?\/?assets\/[^'")\s]+)['"]?\)/gi,
      (_match, path: string) => {
        const cleanPath = path.replace(/^\.?\//, '');
        return `url('${baseUrl}/${cleanPath}')`;
      }
    );

    // Rewrite src=, href=, poster= in HTML for assets
    content = content.replace(
      /(src|href|poster)=["'](?!data:|https?:|\/\/|#)(\.?\/?assets\/[^"']+)["']/gi,
      (_match, attr: string, path: string) => {
        const cleanPath = path.replace(/^\.?\//, '');
        return `${attr}="${baseUrl}/${cleanPath}"`;
      }
    );

    return content;
  }

  /**
   * Execute script in the shadow DOM context.
   * The script runs with access to the shadow root.
   */
  private executeScript(scriptContent: string): void {
    try {
      // Create a function that receives the shadow root as context
      const scriptFn = new Function('shadowRoot', 'container', scriptContent);
      scriptFn(this.shadowRoot, this);
    } catch (err) {
      console.error('[OuterSkinContainer] Failed to execute script:', err);
    }
  }

  /**
   * Show the outer skin container
   */
  show(): void {
    this.container.style.display = 'block';
    // Set body + container background to match skin (iOS Safari samples body bg for chrome)
    const bg = this.manifest.backgroundColor;
    if (bg) {
      document.body.style.background = bg;
      this.container.style.background = bg;
    }
    // Hide pre-rendered homepage content (SEO) when shadow DOM skin takes over
    const prerendered = document.getElementById('prerendered-homepage');
    if (prerendered) {
      prerendered.style.display = 'none';
    }
  }

  /**
   * Hide the outer skin container
   */
  hide(): void {
    this.container.style.display = 'none';
    // Reset body background (CSS classes like mode-focused take over)
    document.body.style.background = '';
  }

  /**
   * Check if container is visible
   */
  isVisible(): boolean {
    return this.container.style.display !== 'none';
  }

  /**
   * Get the shadow root for external access (e.g., for event binding)
   */
  getShadowRoot(): ShadowRoot {
    return this.shadowRoot;
  }

  /**
   * Get the manifest
   */
  getManifest(): OuterSkinManifest {
    return this.manifest;
  }

  /**
   * Query an element within the shadow DOM
   */
  querySelector<T extends Element>(selector: string): T | null {
    return this.shadowRoot.querySelector<T>(selector);
  }

  /**
   * Query all elements within the shadow DOM
   */
  querySelectorAll<T extends Element>(selector: string): NodeListOf<T> {
    return this.shadowRoot.querySelectorAll<T>(selector);
  }

  /**
   * Destroy the container and remove from DOM
   */
  destroy(): void {
    this.container.remove();
  }
}
