/**
 * Session manager for headless Chrome via Playwright.
 *
 * Each agent gets its own Chrome process via launchPersistentContext().
 * Anti-detection init scripts (browse-stealth.ts) are injected via
 * context.addInitScript() to patch navigator, WebGL, screen dimensions,
 * etc. and pass CreepJS and similar headless detectors.
 *
 * Hub-persisted agents get a persistent browser data dir at
 * {agentStorePath}/{agentId}/browser/ for cookie/state persistence.
 * Non-persisted agents get a temp dir at /tmp/flo-browse-{agentId}/.
 */

import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import type { AccessibilityNode } from './utils/accessibility-tree.js';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { buildStealthScript, deriveLocale, buildWorkerPatch } from './browse-stealth.js';

export interface BrowseSessionConfig {
  /** Port of the BrowseProxy that mediates all headless browser traffic */
  proxyPort: number;
  /** Maximum number of concurrent browser sessions across all agents */
  maxConcurrentSessions: number;
  /** Auto-close sessions after this many minutes of inactivity */
  sessionTimeoutMinutes: number;
  /** Default viewport dimensions for new sessions */
  viewport: { width: number; height: number };
  /** Path to agent store root, e.g. ~/.flo-monster/agents/ */
  agentStorePath?: string;
  /** Log page console output and JS errors to hub stdout */
  debug?: boolean;
  /** Disable anti-headless-detection stealth patches (for debugging). Default true. */
  stealth?: boolean;
  /** Skip specific stealth sections: 'userAgentData', 'workerPatch', 'permissions' */
  skipStealthSections?: string[];
}

export interface BrowseSession {
  context: BrowserContext;
  page: Page;
  agentId: string;
  /** Date.now() timestamp of last activity */
  lastActivity: number;
  /** Browser data directory (persistent or temp) */
  browserDataDir: string;
}

/** Interval (ms) between session timeout sweeps */
const CLEANUP_INTERVAL_MS = 60_000;

export class BrowseSessionManager {
  private sessions = new Map<string, BrowseSession>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private elementRefs = new Map<string, Map<string, AccessibilityNode>>();

  constructor(private config: BrowseSessionConfig) {}

  /**
   * Start the session manager (cleanup interval).
   * No shared browser to launch — each session gets its own process.
   */
  start(): void {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);
  }

  /**
   * Determine the browser data directory for an agent.
   * Hub-persisted agents (whose agent store dir exists) get persistent storage.
   * Others get a temp directory.
   */
  async getBrowserDataDir(agentId: string): Promise<string> {
    if (this.config.agentStorePath) {
      const agentDir = join(this.config.agentStorePath, agentId);
      try {
        const s = await stat(agentDir);
        if (s.isDirectory()) {
          return join(agentDir, 'browser');
        }
      } catch {
        // Agent store dir doesn't exist — use temp
      }
    }
    return join('/tmp', `flo-browse-${agentId}`);
  }

  /**
   * Get or create a browsing session for an agent.
   * Each agent gets its own Chrome process via launchPersistentContext.
   */
  async getOrCreateSession(agentId: string): Promise<Page> {
    // Return existing session if one exists
    const existing = this.sessions.get(agentId);
    if (existing) {
      this.touchSession(agentId);
      return existing.page;
    }

    // Enforce concurrent session limit
    if (this.sessions.size >= this.config.maxConcurrentSessions) {
      throw new Error(
        `Maximum concurrent sessions reached (${this.config.maxConcurrentSessions}). ` +
        'Close an existing session before creating a new one.',
      );
    }

    const browserDataDir = await this.getBrowserDataDir(agentId);
    await mkdir(browserDataDir, { recursive: true });

    const locale = deriveLocale();

    const context = await chromium.launchPersistentContext(browserDataDir, {
      headless: false,
      args: [
        '--headless=new',
        `--proxy-server=http://127.0.0.1:${this.config.proxyPort}`,
        // Block WebRTC from leaking the hub's public IP via STUN
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--enforce-webrtc-ip-permission-check',
        // Disable navigator.webdriver at C++ level (avoids JS lie detection)
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: this.config.viewport,
      ignoreHTTPSErrors: true,
      locale,
    });

    // Get Chromium version for stealth script interpolation
    const chromiumVersion = context.browser()?.version() ?? '130.0.0.0';
    const chromiumMajor = chromiumVersion.split('.')[0];
    const realUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;

    const stealth = this.config.stealth !== false; // default true

    if (stealth) {
      // Inject anti-headless-detection init script (runs before page scripts on every navigation)
      await context.addInitScript(buildStealthScript({
        chromiumVersion,
        chromiumMajor,
        viewport: this.config.viewport,
        locale,
        skipSections: this.config.skipStealthSections?.length
          ? new Set(this.config.skipStealthSections)
          : undefined,
      }));
    }

    // Set UA + Client Hints at C++ level via CDP (fixes Sec-CH-UA version mismatch)
    const defaultPage = context.pages()[0];
    if (defaultPage) {
      const cdp = await context.newCDPSession(defaultPage);
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: realUA,
        acceptLanguage: `${locale},${locale.split('-')[0]};q=0.9`,
        platform: 'Linux',
        userAgentMetadata: {
          brands: [
            { brand: 'Chromium', version: chromiumMajor },
            { brand: 'Not_A Brand', version: '24' },
            { brand: 'Google Chrome', version: chromiumMajor },
          ],
          fullVersionList: [
            { brand: 'Chromium', version: chromiumVersion },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
            { brand: 'Google Chrome', version: chromiumVersion },
          ],
          platform: 'Linux',
          platformVersion: '6.8.0',
          architecture: 'x86',
          model: '',
          mobile: false,
          bitness: '64',
        },
      } as any);  // 'as any' because Playwright types don't include userAgentMetadata
      await cdp.detach();
    }

    if (stealth) {
      // Build worker patch for ServiceWorker interception
      const lang = locale.split('-')[0];
      const languages = lang === locale ? `['${locale}']` : `['${locale}', '${lang}']`;
      const workerPatchStr = buildWorkerPatch({
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
        languages,
        locale,
        userAgent: realUA,
        platform: 'Linux x86_64',
        chromiumVersion,
        chromiumMajor,
      });

      // Rewrite UA header + intercept ServiceWorker scripts to inject stealth patches
      await context.route('**/*', async (route) => {
        const request = route.request();
        const headers = { ...request.headers() };

        // Intercept ServiceWorker script fetches to prepend worker patches
        if (headers['service-worker'] === 'script') {
          try {
            const response = await route.fetch({
              headers: { ...headers, 'user-agent': realUA },
            });
            const body = await response.text();
            const patchedBody = workerPatchStr + '\n' + body;
            await route.fulfill({
              response,
              body: patchedBody,
            });
            return;
          } catch {
            // Fall through to normal handling if interception fails
          }
        }

        headers['user-agent'] = realUA;
        await route.continue({ headers });
      });
    } else {
      // Even without stealth, rewrite UA header to match CDP override
      await context.route('**/*', async (route) => {
        const headers = { ...route.request().headers(), 'user-agent': realUA };
        await route.continue({ headers });
      });
    }

    // Apply CDP UA override to any new pages opened in this context
    context.on('page', async (newPage) => {
      try {
        const cdp = await context.newCDPSession(newPage);
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent: realUA,
          acceptLanguage: `${locale},${locale.split('-')[0]};q=0.9`,
          platform: 'Linux',
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: chromiumMajor },
              { brand: 'Not_A Brand', version: '24' },
              { brand: 'Google Chrome', version: chromiumMajor },
            ],
            fullVersionList: [
              { brand: 'Chromium', version: chromiumVersion },
              { brand: 'Not_A Brand', version: '24.0.0.0' },
              { brand: 'Google Chrome', version: chromiumVersion },
            ],
            platform: 'Linux',
            platformVersion: '6.8.0',
            architecture: 'x86',
            model: '',
            mobile: false,
            bitness: '64',
          },
        } as any);
        await cdp.detach();
      } catch {
        // Page may have closed before CDP session was established
      }
    });

    // Persistent context opens a default page — use it if available
    const page = context.pages()[0] || await context.newPage();

    // Debug: log page console output and JS errors to hub stdout
    if (this.config.debug) {
      const tag = `[browse:${agentId.slice(0, 8)}]`;
      page.on('console', msg => console.log(`${tag} console.${msg.type()}: ${msg.text()}`));
      page.on('pageerror', err => console.log(`${tag} PAGE ERROR: ${err.message}\n${err.stack || ''}`));
    }

    this.sessions.set(agentId, {
      context,
      page,
      agentId,
      lastActivity: Date.now(),
      browserDataDir,
    });

    return page;
  }

  /**
   * Update the last activity timestamp for an agent's session.
   */
  touchSession(agentId: string): void {
    const session = this.sessions.get(agentId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /**
   * Close a specific agent's browsing session.
   * Closes the browser context (and its Chrome process).
   * Removes temp browser data dirs but preserves persistent ones.
   */
  async closeSession(agentId: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) {
      return;
    }

    await session.context.close();
    this.sessions.delete(agentId);
    this.elementRefs.delete(agentId);

    // Clean up temp browser data dirs (non-persisted agents)
    if (session.browserDataDir.startsWith('/tmp/flo-browse-')) {
      await rm(session.browserDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Close all sessions and shut down.
   */
  async closeAll(): Promise<void> {
    // Clear the cleanup interval first
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close each session's browser context (each is its own Chrome process)
    for (const session of this.sessions.values()) {
      await session.context.close();
    }
    this.sessions.clear();
    this.elementRefs.clear();
  }

  /**
   * Check if a session exists for a given agent.
   */
  hasSession(agentId: string): boolean {
    return this.sessions.has(agentId);
  }

  /**
   * Get an existing session for an agent without creating one.
   * Returns undefined if no session exists.
   */
  getSession(agentId: string): BrowseSession | undefined {
    return this.sessions.get(agentId);
  }

  /**
   * Get the Playwright Page for an agent's browse session (if it exists).
   */
  getPage(agentId: string): Page | undefined {
    return this.sessions.get(agentId)?.page;
  }

  /**
   * Get or create the element refs map for an agent.
   * Element refs store accessibility node IDs from the last a11y snapshot.
   */
  getElementRefs(agentId: string): Map<string, AccessibilityNode> {
    let refs = this.elementRefs.get(agentId);
    if (!refs) {
      refs = new Map();
      this.elementRefs.set(agentId, refs);
    }
    return refs;
  }

  /**
   * Get the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Re-key a browse session from one agent ID to another.
   * Used when a browser agent is persisted to the hub — the session
   * transfers from the browser agent ID to the new hub agent ID.
   */
  rekeySession(oldId: string, newId: string): boolean {
    const session = this.sessions.get(oldId);
    if (!session) return false;
    this.sessions.delete(oldId);
    session.agentId = newId;
    this.sessions.set(newId, session);
    // Transfer element refs too
    const refs = this.elementRefs.get(oldId);
    if (refs) {
      this.elementRefs.set(newId, refs);
      this.elementRefs.delete(oldId);
    }
    return true;
  }

  /**
   * Sweep sessions that have exceeded the inactivity timeout.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const timeoutMs = this.config.sessionTimeoutMinutes * 60 * 1000;

    for (const [agentId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > timeoutMs) {
        await session.context.close();
        this.sessions.delete(agentId);
        this.elementRefs.delete(agentId);
        // Clean up temp browser data dirs
        if (session.browserDataDir.startsWith('/tmp/flo-browse-')) {
          await rm(session.browserDataDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }
}
