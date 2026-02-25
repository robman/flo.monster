/**
 * Browse tool — lets agents browse the web via headless Chromium managed by the hub.
 *
 * Action-based dispatch (same pattern as dom, state tools).
 * Each action gets or creates a Playwright Page via BrowseSessionManager,
 * performs the operation, and returns results (often including an updated
 * accessibility tree so the agent can reference interactive elements by ref).
 *
 * Accessibility snapshots are obtained via CDP (Accessibility.getFullAXTree)
 * because Playwright 1.58 removed the deprecated `page.accessibility` API.
 * The CDP response is converted to AccessibilityNode for use with the
 * project's serializeAccessibilityTree / assignElementRefs utilities.
 */

import type { Page } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { BrowseSessionManager } from '../browse-session.js';
import type { BrowseProxy } from '../browse-proxy.js';
import type { BrowseToolConfig } from '../config.js';
import { signUrl } from '../utils/signed-url.js';
import type { AccessibilityNode } from '../utils/accessibility-tree.js';
import { getAccessibilityTree, getPageMetadata } from '../utils/page-accessibility.js';
import type { ToolResult } from './index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrowseInput {
  action: string;
  url?: string;
  ref?: string;
  selector?: string;
  text?: string;
  value?: string;
  direction?: string;
  key?: string;
  extractType?: string;
  expression?: string;
  timeout?: number;
}

export interface BrowseDeps {
  sessionManager: BrowseSessionManager;
  proxy: BrowseProxy;
  config: BrowseToolConfig;
  agentId: string;
  /** Map of element refs from the most recent a11y snapshot */
  elementRefs: Map<string, AccessibilityNode>;
  /** Agent's files directory for saving screenshots */
  fileRoot?: string;
  /** Hub's external URL for constructing signed URLs */
  hubUrl?: string;
  /** HMAC signing secret for signed URLs */
  signingSecret?: Buffer;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const browseToolDef = {
  name: 'browse',
  description: `Browse the web using a headless browser. Actions:
- load: Navigate to a URL. Returns accessibility tree.
- click: Click an element by ref (e.g. "e1"), CSS selector, or text content.
- fill: Type text into a form field.
- select: Select an option from a dropdown.
- scroll: Scroll the page (up/down/top/bottom).
- query: Find elements matching a CSS selector.
- extract: Extract structured data (links/tables/text/metadata).
- screenshot: Capture the page as a JPEG image. Returns a URL you can use in <img> tags.
- evaluate: Run a JavaScript expression in the page context.
- wait_for: Wait for an element or navigation.
- press_key: Press a keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowDown").
- back: Go back in browser history.
- forward: Go forward in browser history.
- close: Close the browsing session.

Element refs (e1, e2, ...) come from the accessibility tree returned by load/click/fill/etc. Use the most recent refs.`,
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: [
          'load', 'click', 'fill', 'select', 'scroll', 'press_key',
          'query', 'extract', 'screenshot', 'evaluate', 'wait_for',
          'back', 'forward', 'close',
        ],
        description: 'The browsing action to perform',
      },
      url: { type: 'string' as const, description: 'URL to navigate to (for load action)' },
      ref: { type: 'string' as const, description: 'Element ref from accessibility tree (e.g. "e1")' },
      selector: { type: 'string' as const, description: 'CSS selector to target an element' },
      text: { type: 'string' as const, description: 'Text content to match an element, or text to type (for fill)' },
      value: { type: 'string' as const, description: 'Value to fill or select' },
      direction: { type: 'string' as const, enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
      key: { type: 'string' as const, description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")' },
      extractType: { type: 'string' as const, enum: ['links', 'tables', 'text', 'metadata'], description: 'Type of data to extract' },
      expression: { type: 'string' as const, description: 'JavaScript expression to evaluate' },
      timeout: { type: 'number' as const, description: 'Timeout in ms for wait_for (default 5000)' },
    },
    required: ['action'] as const,
  },
};

// ---------------------------------------------------------------------------
// Behavioral stealth — generate real (isTrusted:true) input events via CDP
// to avoid detection by bot-protection JS (DataDome, Cloudflare, etc.) that
// monitors mouse movement patterns, typing cadence, and interaction timing.
// ---------------------------------------------------------------------------

/** Random integer in [min, max] inclusive */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Small random delay to break machine-like timing patterns */
function humanDelay(page: Page, minMs = 50, maxMs = 200): Promise<void> {
  return page.waitForTimeout(randInt(minMs, maxMs));
}

/** Move mouse along a path with random steps (generates real mousemove events) */
async function humanMouseMove(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y, { steps: randInt(8, 18) });
}

/** Move mouse to a random viewport position (simulates idle user movement) */
async function randomMouseJitter(page: Page, vpW: number, vpH: number): Promise<void> {
  const x = randInt(100, vpW - 100);
  const y = randInt(100, vpH - 100);
  await humanMouseMove(page, x, y);
}

/**
 * Move mouse to an element's bounding box center (with small random offset)
 * before interacting. Returns true if the element was visible, false otherwise.
 */
async function moveMouseToElement(page: Page, el: ReturnType<Page['locator']>): Promise<boolean> {
  const box = await el.boundingBox();
  if (!box) return false;
  // Target the center with a small random offset (so it's not pixel-perfect)
  const x = box.x + box.width / 2 + (Math.random() - 0.5) * box.width * 0.3;
  const y = box.y + box.height / 2 + (Math.random() - 0.5) * box.height * 0.3;
  await humanMouseMove(page, x, y);
  return true;
}

// ---------------------------------------------------------------------------
// Bot-protection detection
// ---------------------------------------------------------------------------

/** Known bot-protection signatures in the accessibility tree or page title. */
const BOT_PROTECTION_SIGNALS: Array<{ pattern: RegExp; name: string }> = [
  // DataDome
  { pattern: /DataDome/i, name: 'DataDome' },
  { pattern: /Please enable JS and disable any ad blocker/i, name: 'DataDome' },
  // Cloudflare
  { pattern: /Verify you are human/i, name: 'Cloudflare' },
  { pattern: /Checking if the site connection is secure/i, name: 'Cloudflare' },
  { pattern: /Attention Required! \| Cloudflare/i, name: 'Cloudflare' },
  // PerimeterX / HUMAN Security
  { pattern: /Press & Hold/i, name: 'PerimeterX' },
  // Akamai Bot Manager
  { pattern: /Access Denied[\s\S]{0,40}Reference #/i, name: 'Akamai' },
  // Imperva / Incapsula
  { pattern: /Incapsula incident/i, name: 'Imperva' },
  // Kasada
  { pattern: /blocked by Kasada/i, name: 'Kasada' },
];

/**
 * Check the accessibility tree text for bot-protection signals.
 * Returns the protection service name if detected, null otherwise.
 */
export function detectBotProtection(tree: string): string | null {
  for (const { pattern, name } of BOT_PROTECTION_SIGNALS) {
    if (pattern.test(tree)) return name;
  }
  return null;
}

/**
 * Build the standard browse result. If bot protection is detected in the
 * accessibility tree, prepend a clear warning instructing the agent to stop
 * and notify the user for manual intervention.
 */
function buildBrowseResult(metadata: string, tree: string): ToolResult {
  const botService = detectBotProtection(tree);
  if (botService) {
    return {
      content:
        `⚠️ BOT PROTECTION DETECTED (${botService})\n\n` +
        `This page is showing a bot/CAPTCHA challenge. ` +
        `Do NOT continue browsing this site — further automated interaction will escalate the block. ` +
        `Tell the user that ${botService} bot protection is blocking access and ask them to open ` +
        `the browse stream to solve the challenge manually. If the user is not connected (no browser), ` +
        `send a push notification instead. Wait for the user to confirm before retrying.\n\n` +
        `${metadata}\n\n${tree}`,
    };
  }
  return { content: `${metadata}\n\n${tree}` };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a target element from the three possible targeting strategies:
 *   1. ref  — look up in elementRefs, use getByRole
 *   2. selector — page.locator(selector)
 *   3. text — page.getByText(text)
 *
 * Returns the Playwright Locator (already narrowed to .first()).
 */
async function resolveElement(
  page: Page,
  input: BrowseInput,
  deps: BrowseDeps,
): Promise<ReturnType<Page['locator']> | null> {
  if (input.ref) {
    const node = deps.elementRefs.get(input.ref);
    if (!node) return null;
    const locator = page.getByRole(node.role as Parameters<Page['getByRole']>[0], { name: node.name });

    // For links with a known URL, disambiguate by href when multiple elements
    // share the same role and name (e.g. duplicate "MOB-labs" links on DDG)
    if (node.url) {
      try {
        const matchIndices = await locator.evaluateAll(
          (elements, targetUrl) =>
            elements.reduce<number[]>((acc, el, i) => {
              if ((el as HTMLAnchorElement).href === targetUrl) acc.push(i);
              return acc;
            }, []),
          node.url,
        );
        if (matchIndices.length > 0) {
          return locator.nth(matchIndices[0]);
        }
      } catch {
        // Fall through to .first()
      }
    }

    return locator.first();
  }
  if (input.selector) {
    return page.locator(input.selector).first();
  }
  if (input.text) {
    return page.getByText(input.text, { exact: false }).first();
  }
  return null;
}

/**
 * If the target element is currently disabled, wait briefly for JS framework
 * initialization to enable it (e.g. Google Forms / Wiz framework renders fields
 * as disabled in server HTML, then enables after lazy controller init).
 * Returns without error if the element stays disabled — let Playwright handle it.
 */
async function waitIfDisabled(el: ReturnType<Page['locator']>): Promise<void> {
  const disabled = await el.evaluate(e => (e as HTMLInputElement).disabled || e.getAttribute('aria-disabled') === 'true').catch(() => false);
  if (disabled) {
    await el.evaluate(e => new Promise<void>(resolve => {
      const observer = new MutationObserver(() => {
        if (!(e as HTMLInputElement).disabled && e.getAttribute('aria-disabled') !== 'true') {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(e, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
      setTimeout(() => { observer.disconnect(); resolve(); }, 5000);
    })).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

async function handleLoad(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  if (!input.url) {
    return { content: 'Missing required parameter: url', is_error: true };
  }

  // Validate URL scheme
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url);
  } catch {
    return { content: `Invalid URL: ${input.url}`, is_error: true };
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { content: `Invalid URL scheme: ${parsedUrl.protocol} (only http/https allowed)`, is_error: true };
  }

  // SSRF / domain-policy validation
  const blockReason = deps.proxy.validateHostname(parsedUrl.hostname);
  if (blockReason) {
    return { content: blockReason, is_error: true };
  }

  // Wait for full page load (not just DOM) so bot-protection scripts
  // (DataDome, Cloudflare Turnstile, etc.) have time to run their JS
  // fingerprint checks and set validation cookies before we snapshot.
  await page.goto(input.url, { waitUntil: 'load', timeout: 30000 });
  // Brief additional wait for async bot-check scripts that fire after onload
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  // Behavioral stealth: move mouse after page load (a real user would move
  // their mouse while scanning the page). This generates isTrusted mousemove
  // events that bot-detection JS monitors.
  const vp = page.viewportSize();
  if (vp) {
    await randomMouseJitter(page, vp.width, vp.height);
    await humanDelay(page, 200, 600);
    await randomMouseJitter(page, vp.width, vp.height);
  }

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleClick(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  const el = await resolveElement(page, input, deps);
  if (!el) {
    return {
      content: 'Missing target: provide ref, selector, or text to identify the element to click',
      is_error: true,
    };
  }

  // Behavioral stealth: move mouse to the element before clicking.
  // Playwright's el.click() teleports the cursor — real users move smoothly.
  await moveMouseToElement(page, el);
  await humanDelay(page, 80, 250);

  // Wait for framework init if element is still disabled (e.g. Wiz lazy controllers)
  await waitIfDisabled(el);

  // Click may trigger navigation — race the click against waitForNavigation.
  // If navigation starts we wait for it; otherwise brief DOM-change delay.
  const navPromise = page.waitForNavigation({ timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  await el.click();
  const didNavigate = await navPromise;
  if (!didNavigate) {
    // No navigation — brief wait for potential DOM changes (SPA, popups, etc.)
    await page.waitForTimeout(300);
  }

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleFill(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  const fillValue = input.value ?? input.text;
  if (fillValue === undefined) {
    return { content: 'Missing required parameter: value (or text) to fill', is_error: true };
  }

  const el = await resolveElement(page, input, deps);
  if (!el) {
    return {
      content: 'Missing target: provide ref, selector, or text to identify the element to fill',
      is_error: true,
    };
  }

  // Behavioral stealth: move mouse to the field, click to focus, then type
  // character-by-character with human-like delays. el.fill() dispatches a
  // single input event with the full text — trivially detectable by
  // bot-protection scripts that monitor keystroke timing.
  await moveMouseToElement(page, el);
  await humanDelay(page, 50, 150);

  // Wait for framework init if element is still disabled (e.g. Wiz lazy controllers)
  await waitIfDisabled(el);

  await el.click();
  await page.keyboard.press('Control+a'); // Select any existing text
  await humanDelay(page, 30, 80);
  await page.keyboard.type(fillValue, { delay: randInt(35, 90) });

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleSelect(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  if (input.value === undefined) {
    return { content: 'Missing required parameter: value', is_error: true };
  }

  const el = await resolveElement(page, input, deps);
  if (!el) {
    return {
      content: 'Missing target: provide ref, selector, or text to identify the element',
      is_error: true,
    };
  }

  // Wait for framework init if element is still disabled (e.g. Wiz lazy controllers)
  await waitIfDisabled(el);

  await el.selectOption(input.value);

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleScroll(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  if (!input.direction) {
    return { content: 'Missing required parameter: direction (up/down/top/bottom)', is_error: true };
  }

  const keyMap: Record<string, string> = {
    up: 'PageUp',
    down: 'PageDown',
    top: 'Home',
    bottom: 'End',
  };

  const key = keyMap[input.direction];
  if (!key) {
    return { content: `Invalid direction: ${input.direction}. Must be up, down, top, or bottom`, is_error: true };
  }

  await page.keyboard.press(key);

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handlePressKey(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  if (!input.key) {
    return { content: 'Missing required parameter: key (e.g. "Enter", "Tab", "Escape")', is_error: true };
  }

  await page.keyboard.press(input.key);
  await page.waitForTimeout(500);

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleQuery(page: Page, input: BrowseInput): Promise<ToolResult> {
  if (!input.selector) {
    return { content: 'Missing required parameter: selector', is_error: true };
  }

  const locator = page.locator(input.selector);
  const count = await locator.count();
  const elements = await locator.all();

  const items: string[] = [];
  for (let i = 0; i < Math.min(elements.length, 50); i++) {
    const text = await elements[i].textContent();
    items.push(`${i + 1}. ${(text ?? '').trim().slice(0, 200)}`);
  }

  return {
    content: `Found ${count} element(s) matching "${input.selector}":\n${items.join('\n')}`,
  };
}

async function handleExtract(page: Page, input: BrowseInput): Promise<ToolResult> {
  if (!input.extractType) {
    return { content: 'Missing required parameter: extractType (links/tables/text/metadata)', is_error: true };
  }

  switch (input.extractType) {
    case 'links': {
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'), (a) => ({
          text: (a as HTMLAnchorElement).textContent?.trim() ?? '',
          href: (a as HTMLAnchorElement).href,
        })),
      );
      return { content: JSON.stringify(links, null, 2) };
    }

    case 'tables': {
      const tableData = await page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) return null;
        const rows: string[][] = [];
        for (const row of Array.from(table.querySelectorAll('tr'))) {
          const cells: string[] = [];
          for (const cell of Array.from(row.querySelectorAll('th, td'))) {
            cells.push((cell as HTMLElement).textContent?.trim() ?? '');
          }
          rows.push(cells);
        }
        return rows;
      });
      return { content: JSON.stringify(tableData, null, 2) };
    }

    case 'text': {
      const text = await page.evaluate(() => document.body.innerText);
      return { content: text };
    }

    case 'metadata': {
      const meta = await page.evaluate(() => ({
        title: document.title,
        description:
          (document.querySelector('meta[name="description"]') as HTMLMetaElement)?.content ?? null,
        ogTitle:
          (document.querySelector('meta[property="og:title"]') as HTMLMetaElement)?.content ?? null,
        ogDescription:
          (document.querySelector('meta[property="og:description"]') as HTMLMetaElement)?.content ?? null,
        ogImage:
          (document.querySelector('meta[property="og:image"]') as HTMLMetaElement)?.content ?? null,
        canonical:
          (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href ?? null,
      }));
      return { content: JSON.stringify(meta, null, 2) };
    }

    default:
      return {
        content: `Invalid extractType: ${input.extractType}. Must be links, tables, text, or metadata`,
        is_error: true,
      };
  }
}

async function handleScreenshot(page: Page, deps: BrowseDeps): Promise<ToolResult> {
  if (!deps.fileRoot || !deps.hubUrl || !deps.signingSecret) {
    return { content: 'Screenshot requires file serving configuration (fileRoot, hubUrl, signingSecret)', is_error: true };
  }

  const buffer = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });

  const timestamp = Date.now();
  const relativePath = `screenshots/${timestamp}.jpg`;
  const absolutePath = join(deps.fileRoot, relativePath);

  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);

  const { sig, exp } = signUrl(deps.signingSecret, deps.agentId, relativePath);
  const url = `${deps.hubUrl}/agents/${encodeURIComponent(deps.agentId)}/files/${relativePath}?sig=${sig}&exp=${exp}`;

  return { content: `Screenshot saved.\nURL: ${url}` };
}

async function handleEvaluate(page: Page, input: BrowseInput): Promise<ToolResult> {
  if (!input.expression) {
    return { content: 'Missing required parameter: expression', is_error: true };
  }

  const result = await page.evaluate(input.expression);
  return { content: JSON.stringify(result) };
}

async function handleWaitFor(page: Page, input: BrowseInput, deps: BrowseDeps): Promise<ToolResult> {
  const timeout = input.timeout ?? 5000;

  if (input.selector) {
    await page.waitForSelector(input.selector, { timeout });
  } else {
    await page.waitForLoadState('networkidle', { timeout });
  }

  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleBack(page: Page, deps: BrowseDeps): Promise<ToolResult> {
  await page.goBack();
  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleForward(page: Page, deps: BrowseDeps): Promise<ToolResult> {
  await page.goForward();
  const metadata = await getPageMetadata(page);
  const tree = await getAccessibilityTree(page, deps.elementRefs);
  return buildBrowseResult(metadata, tree);
}

async function handleClose(deps: BrowseDeps): Promise<ToolResult> {
  await deps.sessionManager.closeSession(deps.agentId);
  deps.elementRefs.clear();
  return { content: 'Browsing session closed' };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function executeBrowse(
  input: BrowseInput,
  deps: BrowseDeps,
): Promise<ToolResult> {
  try {
    // close doesn't need a page
    if (input.action === 'close') {
      return await handleClose(deps);
    }

    const page = await deps.sessionManager.getOrCreateSession(deps.agentId);
    deps.sessionManager.touchSession(deps.agentId);

    switch (input.action) {
      case 'load':
        return await handleLoad(page, input, deps);
      case 'click':
        return await handleClick(page, input, deps);
      case 'fill':
        return await handleFill(page, input, deps);
      case 'select':
        return await handleSelect(page, input, deps);
      case 'scroll':
        return await handleScroll(page, input, deps);
      case 'press_key':
        return await handlePressKey(page, input, deps);
      case 'query':
        return await handleQuery(page, input);
      case 'extract':
        return await handleExtract(page, input);
      case 'screenshot':
        return await handleScreenshot(page, deps);
      case 'evaluate':
        return await handleEvaluate(page, input);
      case 'wait_for':
        return await handleWaitFor(page, input, deps);
      case 'back':
        return await handleBack(page, deps);
      case 'forward':
        return await handleForward(page, deps);
      default:
        return { content: `Unknown browse action: ${input.action}`, is_error: true };
    }
  } catch (err) {
    return { content: `Browse error: ${(err as Error).message}`, is_error: true };
  }
}
