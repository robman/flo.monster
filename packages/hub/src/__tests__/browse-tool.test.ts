import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSigningSecret } from '../utils/signed-url.js';
import { executeBrowse, browseToolDef, detectBotProtection, type BrowseInput, type BrowseDeps } from '../tools/browse.js';
import type { AccessibilityNode } from '../utils/accessibility-tree.js';

// ---------------------------------------------------------------------------
// Mock accessibility-tree utils — called by the real code
// ---------------------------------------------------------------------------
vi.mock('../utils/accessibility-tree.js', () => ({
  assignElementRefs: vi.fn((root: AccessibilityNode) => {
    const refs = new Map<string, AccessibilityNode>();
    let counter = 0;
    function walk(node: AccessibilityNode): void {
      const INTERACTIVE = new Set([
        'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox',
        'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
        'option', 'treeitem',
      ]);
      if (INTERACTIVE.has(node.role)) {
        counter++;
        refs.set(`e${counter}`, node);
      }
      if (node.children) {
        for (const c of node.children) walk(c);
      }
    }
    walk(root);
    return refs;
  }),
  serializeAccessibilityTree: vi.fn(() => '- WebArea "Test Page"\n  - heading "Hello" [level=1]\n  - link "Click me" [ref=e1]\n  - textbox "Search" [ref=e2]\n  - button "Submit" [ref=e3]'),
}));

// ---------------------------------------------------------------------------
// Mock fs/promises — prevent actual file I/O during screenshot tests
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock page
// ---------------------------------------------------------------------------

function createMockPage() {
  const locatorFirst = {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    textContent: vi.fn().mockResolvedValue('Some text'),
    boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 40 }),
    evaluate: vi.fn().mockResolvedValue(false), // element not disabled
  };

  const locator = {
    first: vi.fn().mockReturnValue(locatorFirst),
    all: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    textContent: vi.fn().mockResolvedValue('text'),
  };

  // Mock CDP session returned by page.context().newCDPSession(page)
  const mockCdpSession = {
    send: vi.fn().mockResolvedValue({
      nodes: [
        {
          nodeId: '1',
          role: { type: 'role', value: 'WebArea' },
          name: { type: 'computedString', value: 'Test Page' },
          childIds: ['2', '3', '4', '5'],
        },
        {
          nodeId: '2',
          role: { type: 'role', value: 'heading' },
          name: { type: 'computedString', value: 'Hello' },
          properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
        },
        {
          nodeId: '3',
          role: { type: 'role', value: 'link' },
          name: { type: 'computedString', value: 'Click me' },
          properties: [{ name: 'url', value: { type: 'string', value: 'https://example.com/link' } }],
        },
        {
          nodeId: '4',
          role: { type: 'role', value: 'textbox' },
          name: { type: 'computedString', value: 'Search' },
        },
        {
          nodeId: '5',
          role: { type: 'role', value: 'button' },
          name: { type: 'computedString', value: 'Submit' },
        },
      ],
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const mockContext = {
    newCDPSession: vi.fn().mockResolvedValue(mockCdpSession),
  };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue('Test Page'),
    url: vi.fn().mockReturnValue('https://example.com'),
    context: vi.fn().mockReturnValue(mockContext),
    locator: vi.fn().mockReturnValue(locator),
    getByText: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
        boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 40 }),
        evaluate: vi.fn().mockResolvedValue(false),
      }),
    }),
    getByRole: vi.fn().mockReturnValue({
      first: vi.fn().mockReturnValue({
        click: vi.fn().mockResolvedValue(undefined),
        fill: vi.fn().mockResolvedValue(undefined),
        selectOption: vi.fn().mockResolvedValue(undefined),
        boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 40 }),
        evaluate: vi.fn().mockResolvedValue(false),
      }),
    }),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
      type: vi.fn().mockResolvedValue(undefined),
    },
    mouse: { move: vi.fn().mockResolvedValue(undefined) },
    viewportSize: vi.fn().mockReturnValue({ width: 1419, height: 813 }),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-png')),
    evaluate: vi.fn().mockResolvedValue({ result: 'test' }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    goForward: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockRejectedValue(new Error('timeout')),
  };

  return { page, locator, locatorFirst, mockCdpSession, mockContext };
}

// ---------------------------------------------------------------------------
// Mock session manager
// ---------------------------------------------------------------------------

function createMockSessionManager(page: ReturnType<typeof createMockPage>['page']) {
  return {
    getOrCreateSession: vi.fn().mockResolvedValue(page),
    touchSession: vi.fn(),
    closeSession: vi.fn().mockResolvedValue(undefined),
    hasSession: vi.fn().mockReturnValue(true),
  };
}

// ---------------------------------------------------------------------------
// Mock proxy
// ---------------------------------------------------------------------------

function createMockProxy() {
  return {
    validateHostname: vi.fn().mockReturnValue(null), // null = valid
  };
}

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

function createMockConfig() {
  return {
    enabled: true,
    maxConcurrentSessions: 3,
    sessionTimeoutMinutes: 30,
    allowedDomains: [] as string[],
    blockedDomains: [] as string[],
    blockPrivateIPs: true,
    rateLimitPerDomain: 10,
    viewport: { width: 1419, height: 813 },
  };
}

// ---------------------------------------------------------------------------
// Build deps helper
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<BrowseDeps>): BrowseDeps & {
  mockPage: ReturnType<typeof createMockPage>['page'];
  mockLocator: ReturnType<typeof createMockPage>['locator'];
  mockLocatorFirst: ReturnType<typeof createMockPage>['locatorFirst'];
  mockCdpSession: ReturnType<typeof createMockPage>['mockCdpSession'];
  mockContext: ReturnType<typeof createMockPage>['mockContext'];
} {
  const { page, locator, locatorFirst, mockCdpSession, mockContext } = createMockPage();
  const sessionManager = createMockSessionManager(page);
  const proxy = createMockProxy();
  const config = createMockConfig();
  const elementRefs = new Map<string, AccessibilityNode>();

  return {
    sessionManager: sessionManager as unknown as BrowseDeps['sessionManager'],
    proxy: proxy as unknown as BrowseDeps['proxy'],
    config,
    agentId: 'test-agent',
    elementRefs,
    mockPage: page,
    mockLocator: locator,
    mockLocatorFirst: locatorFirst,
    mockCdpSession,
    mockContext,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('browse tool', () => {
  describe('browseToolDef', () => {
    it('has the correct name', () => {
      expect(browseToolDef.name).toBe('browse');
    });

    it('requires action', () => {
      expect(browseToolDef.input_schema.required).toContain('action');
    });

    it('lists all actions in enum', () => {
      const actions = browseToolDef.input_schema.properties.action.enum;
      expect(actions).toContain('load');
      expect(actions).toContain('click');
      expect(actions).toContain('fill');
      expect(actions).toContain('select');
      expect(actions).toContain('scroll');
      expect(actions).toContain('query');
      expect(actions).toContain('extract');
      expect(actions).toContain('screenshot');
      expect(actions).toContain('evaluate');
      expect(actions).toContain('wait_for');
      expect(actions).toContain('press_key');
      expect(actions).toContain('back');
      expect(actions).toContain('forward');
      expect(actions).toContain('close');
    });
  });

  // -----------------------------------------------------------------------
  // load
  // -----------------------------------------------------------------------
  describe('load action', () => {
    it('navigates to a valid URL and returns a11y tree', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.goto).toHaveBeenCalledWith(
        'https://example.com',
        { waitUntil: 'load', timeout: 30000 },
      );
      // Additional networkidle wait for bot-protection scripts
      expect(deps.mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 5000 });
      expect(result.content).toContain('URL: https://example.com');
      expect(result.content).toContain('Title: Test Page');
      expect(result.content).toContain('WebArea');
    });

    it('returns error when URL is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'load' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('url');
    });

    it('returns error for invalid URL', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'load', url: 'not-a-url' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Invalid URL');
    });

    it('returns error for non-http/https URL scheme', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'load', url: 'ftp://example.com/file' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Invalid URL scheme');
    });

    it('returns error when hostname is blocked by proxy', async () => {
      const deps = createDeps();
      (deps.proxy.validateHostname as ReturnType<typeof vi.fn>).mockReturnValue('Blocked: private IP (127.0.0.1)');

      const result = await executeBrowse({ action: 'load', url: 'http://127.0.0.1/admin' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Blocked');
    });

    it('touches the session after getting page', async () => {
      const deps = createDeps();
      await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);
      expect(deps.sessionManager.touchSession).toHaveBeenCalledWith('test-agent');
    });
  });

  // -----------------------------------------------------------------------
  // click
  // -----------------------------------------------------------------------
  describe('click action', () => {
    it('clicks by ref using getByRole', async () => {
      const deps = createDeps();
      // Populate elementRefs as if a prior load happened
      deps.elementRefs.set('e1', { role: 'link', name: 'Click me' });

      const result = await executeBrowse({ action: 'click', ref: 'e1' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.getByRole).toHaveBeenCalledWith('link', { name: 'Click me' });
      expect(result.content).toContain('URL:');
    });

    it('clicks by CSS selector', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'click', selector: '#submit-btn' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.locator).toHaveBeenCalledWith('#submit-btn');
    });

    it('clicks by text', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'click', text: 'Sign in' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.getByText).toHaveBeenCalledWith('Sign in', { exact: false });
    });

    it('returns error when no target is provided', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'click' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing target');
    });

    it('returns error when ref is not in elementRefs', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'click', ref: 'e99' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing target');
    });

    it('waits for navigation or falls back to brief timeout after click', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e1', { role: 'button', name: 'Go' });
      await executeBrowse({ action: 'click', ref: 'e1' }, deps);
      // waitForNavigation is called to detect navigation
      expect(deps.mockPage.waitForNavigation).toHaveBeenCalledWith({ timeout: 2000 });
      // When no navigation occurs, falls back to brief DOM-change wait
      expect(deps.mockPage.waitForTimeout).toHaveBeenCalledWith(300);
    });

    it('skips post-click DOM wait when navigation occurs after click', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e1', { role: 'link', name: 'Go' });
      // Simulate successful navigation
      deps.mockPage.waitForNavigation.mockResolvedValue(undefined);
      await executeBrowse({ action: 'click', ref: 'e1' }, deps);
      expect(deps.mockPage.waitForNavigation).toHaveBeenCalledWith({ timeout: 2000 });
      // waitForTimeout is called for humanDelay but NOT the 300ms post-click DOM wait
      const timeoutCalls = deps.mockPage.waitForTimeout.mock.calls;
      const has300msDomWait = timeoutCalls.some((call: any[]) => call[0] === 300);
      expect(has300msDomWait).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // fill
  // -----------------------------------------------------------------------
  describe('fill action', () => {
    it('fills by ref with value using keyboard.type for human-like input', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e2', { role: 'textbox', name: 'Search' });

      const result = await executeBrowse({ action: 'fill', ref: 'e2', value: 'hello' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.getByRole).toHaveBeenCalledWith('textbox', { name: 'Search' });
      // Fill now uses click + Ctrl+A + keyboard.type for human-like keystroke timing
      const first = deps.mockPage.getByRole('textbox', { name: 'Search' }).first();
      expect(first.click).toHaveBeenCalled();
      expect(deps.mockPage.keyboard.press).toHaveBeenCalledWith('Control+a');
      expect(deps.mockPage.keyboard.type).toHaveBeenCalledWith('hello', expect.objectContaining({ delay: expect.any(Number) }));
    });

    it('uses text as fill value when value is not provided', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e2', { role: 'textbox', name: 'Search' });

      const result = await executeBrowse({ action: 'fill', ref: 'e2', text: 'fallback text' }, deps);
      expect(result.is_error).toBeUndefined();
    });

    it('returns error when no value/text is provided', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e2', { role: 'textbox', name: 'Search' });

      const result = await executeBrowse({ action: 'fill', ref: 'e2' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('value');
    });

    it('returns error when no target is provided', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'fill', value: 'hello' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing target');
    });
  });

  // -----------------------------------------------------------------------
  // select
  // -----------------------------------------------------------------------
  describe('select action', () => {
    it('selects an option by ref with value', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e3', { role: 'combobox', name: 'Country' });

      const result = await executeBrowse({ action: 'select', ref: 'e3', value: 'US' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.getByRole).toHaveBeenCalledWith('combobox', { name: 'Country' });
    });

    it('returns error when value is missing', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e3', { role: 'combobox', name: 'Country' });

      const result = await executeBrowse({ action: 'select', ref: 'e3' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('value');
    });

    it('returns error when no target is provided', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'select', value: 'US' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Missing target');
    });
  });

  // -----------------------------------------------------------------------
  // scroll
  // -----------------------------------------------------------------------
  describe('scroll action', () => {
    it.each([
      ['up', 'PageUp'],
      ['down', 'PageDown'],
      ['top', 'Home'],
      ['bottom', 'End'],
    ] as const)('scrolls %s → keyboard %s', async (direction, key) => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'scroll', direction }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.keyboard.press).toHaveBeenCalledWith(key);
    });

    it('returns error when direction is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'scroll' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('direction');
    });

    it('returns error for invalid direction', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'scroll', direction: 'left' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Invalid direction');
    });
  });

  // -----------------------------------------------------------------------
  // press_key
  // -----------------------------------------------------------------------
  describe('press_key action', () => {
    it('presses a key and returns updated tree', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'press_key', key: 'Enter' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
      expect(deps.mockPage.waitForTimeout).toHaveBeenCalledWith(500);
      expect(result.content).toContain('URL:');
      expect(result.content).toContain('WebArea');
    });

    it('returns error when key is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'press_key' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('key');
    });

    it('works with modifier keys', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'press_key', key: 'Escape' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.keyboard.press).toHaveBeenCalledWith('Escape');
    });

    it('works with arrow keys', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'press_key', key: 'ArrowDown' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.keyboard.press).toHaveBeenCalledWith('ArrowDown');
    });
  });

  // -----------------------------------------------------------------------
  // query
  // -----------------------------------------------------------------------
  describe('query action', () => {
    it('returns element count for matching selector', async () => {
      const deps = createDeps();
      deps.mockLocator.count.mockResolvedValue(3);
      deps.mockLocator.all.mockResolvedValue([
        { textContent: vi.fn().mockResolvedValue('Item 1') },
        { textContent: vi.fn().mockResolvedValue('Item 2') },
        { textContent: vi.fn().mockResolvedValue('Item 3') },
      ]);

      const result = await executeBrowse({ action: 'query', selector: '.item' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.locator).toHaveBeenCalledWith('.item');
      expect(result.content).toContain('3 element(s)');
      expect(result.content).toContain('Item 1');
      expect(result.content).toContain('Item 2');
      expect(result.content).toContain('Item 3');
    });

    it('returns error when selector is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'query' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('selector');
    });

    it('handles zero matches', async () => {
      const deps = createDeps();
      deps.mockLocator.count.mockResolvedValue(0);
      deps.mockLocator.all.mockResolvedValue([]);

      const result = await executeBrowse({ action: 'query', selector: '.nothing' }, deps);
      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('0 element(s)');
    });
  });

  // -----------------------------------------------------------------------
  // extract
  // -----------------------------------------------------------------------
  describe('extract action', () => {
    it('extracts links via page.evaluate', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockResolvedValue([
        { text: 'Home', href: 'https://example.com/' },
      ]);

      const result = await executeBrowse({ action: 'extract', extractType: 'links' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.evaluate).toHaveBeenCalled();
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual([{ text: 'Home', href: 'https://example.com/' }]);
    });

    it('extracts tables via page.evaluate', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockResolvedValue([['Name', 'Age'], ['Alice', '30']]);

      const result = await executeBrowse({ action: 'extract', extractType: 'tables' }, deps);

      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed).toEqual([['Name', 'Age'], ['Alice', '30']]);
    });

    it('extracts text via page.evaluate', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockResolvedValue('Hello world');

      const result = await executeBrowse({ action: 'extract', extractType: 'text' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(result.content).toBe('Hello world');
    });

    it('extracts metadata via page.evaluate', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockResolvedValue({
        title: 'Test',
        description: 'A test page',
        ogTitle: null,
        ogDescription: null,
        ogImage: null,
        canonical: null,
      });

      const result = await executeBrowse({ action: 'extract', extractType: 'metadata' }, deps);

      expect(result.is_error).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.title).toBe('Test');
      expect(parsed.description).toBe('A test page');
    });

    it('returns error when extractType is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'extract' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('extractType');
    });

    it('returns error for invalid extractType', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'extract', extractType: 'images' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Invalid extractType');
    });
  });

  // -----------------------------------------------------------------------
  // screenshot
  // -----------------------------------------------------------------------
  describe('screenshot action', () => {
    it('saves JPEG and returns signed URL', async () => {
      const secret = generateSigningSecret();
      const deps = createDeps({
        fileRoot: '/tmp/test-agent/files',
        hubUrl: 'https://hub.example.com:9999',
        signingSecret: secret,
      });
      const result = await executeBrowse({ action: 'screenshot' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 80, fullPage: false });
      expect(result.content).toContain('Screenshot saved.');
      expect(result.content).toContain('https://hub.example.com:9999/agents/test-agent/files/screenshots/');
      expect(result.content).toContain('sig=');
      expect(result.content).toContain('exp=');
    });

    it('returns error when file serving deps are missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'screenshot' }, deps);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('file serving configuration');
    });
  });

  // -----------------------------------------------------------------------
  // evaluate
  // -----------------------------------------------------------------------
  describe('evaluate action', () => {
    it('returns stringified result', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockResolvedValue({ count: 42 });

      const result = await executeBrowse({ action: 'evaluate', expression: 'document.title' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.evaluate).toHaveBeenCalledWith('document.title');
      expect(JSON.parse(result.content)).toEqual({ count: 42 });
    });

    it('returns error when expression is missing', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'evaluate' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('expression');
    });
  });

  // -----------------------------------------------------------------------
  // wait_for
  // -----------------------------------------------------------------------
  describe('wait_for action', () => {
    it('waits for selector when provided', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'wait_for', selector: '#loaded', timeout: 3000 }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.waitForSelector).toHaveBeenCalledWith('#loaded', { timeout: 3000 });
    });

    it('waits for network idle when no selector', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'wait_for' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.waitForLoadState).toHaveBeenCalledWith('networkidle', { timeout: 5000 });
    });

    it('uses default timeout of 5000', async () => {
      const deps = createDeps();
      await executeBrowse({ action: 'wait_for', selector: '.spinner' }, deps);
      expect(deps.mockPage.waitForSelector).toHaveBeenCalledWith('.spinner', { timeout: 5000 });
    });

    it('returns a11y tree after waiting', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'wait_for', selector: '#loaded' }, deps);
      expect(result.content).toContain('URL:');
      expect(result.content).toContain('WebArea');
    });
  });

  // -----------------------------------------------------------------------
  // back / forward
  // -----------------------------------------------------------------------
  describe('back action', () => {
    it('calls page.goBack and returns a11y tree', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'back' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.goBack).toHaveBeenCalled();
      expect(result.content).toContain('URL:');
    });
  });

  describe('forward action', () => {
    it('calls page.goForward and returns a11y tree', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'forward' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(deps.mockPage.goForward).toHaveBeenCalled();
      expect(result.content).toContain('URL:');
    });
  });

  // -----------------------------------------------------------------------
  // close
  // -----------------------------------------------------------------------
  describe('close action', () => {
    it('closes the session and clears elementRefs', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e1', { role: 'link', name: 'old' });

      const result = await executeBrowse({ action: 'close' }, deps);

      expect(result.is_error).toBeUndefined();
      expect(result.content).toContain('closed');
      expect(deps.sessionManager.closeSession).toHaveBeenCalledWith('test-agent');
      expect(deps.elementRefs.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------
  describe('unknown action', () => {
    it('returns error for unrecognized action', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'hover' } as BrowseInput, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Unknown browse action');
    });
  });

  // -----------------------------------------------------------------------
  // error propagation
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('propagates session manager errors as is_error', async () => {
      const deps = createDeps();
      (deps.sessionManager.getOrCreateSession as ReturnType<typeof vi.fn>)
        .mockRejectedValue(new Error('Maximum concurrent sessions reached'));

      const result = await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Maximum concurrent sessions');
    });

    it('propagates page.goto timeout as is_error', async () => {
      const deps = createDeps();
      deps.mockPage.goto.mockRejectedValue(new Error('Timeout 30000ms exceeded'));

      const result = await executeBrowse({ action: 'load', url: 'https://slow-site.com' }, deps);

      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Timeout');
    });

    it('propagates click errors as is_error', async () => {
      const deps = createDeps();
      deps.elementRefs.set('e1', { role: 'button', name: 'Gone' });
      deps.mockPage.getByRole.mockReturnValue({
        first: vi.fn().mockReturnValue({
          click: vi.fn().mockRejectedValue(new Error('Element is not visible')),
          boundingBox: vi.fn().mockResolvedValue({ x: 100, y: 100, width: 200, height: 40 }),
          evaluate: vi.fn().mockResolvedValue(false),
        }),
      });

      const result = await executeBrowse({ action: 'click', ref: 'e1' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Element is not visible');
    });

    it('propagates evaluate errors', async () => {
      const deps = createDeps();
      deps.mockPage.evaluate.mockRejectedValue(new Error('Execution context was destroyed'));

      const result = await executeBrowse({ action: 'evaluate', expression: 'bad()' }, deps);
      expect(result.is_error).toBe(true);
      expect(result.content).toContain('Execution context was destroyed');
    });
  });

  // -----------------------------------------------------------------------
  // elementRefs mutation
  // -----------------------------------------------------------------------
  describe('elementRefs updates', () => {
    it('updates elementRefs after load', async () => {
      const deps = createDeps();
      expect(deps.elementRefs.size).toBe(0);

      await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);

      // assignElementRefs mock returns refs for link, textbox, button
      expect(deps.elementRefs.size).toBeGreaterThan(0);
      expect(deps.elementRefs.has('e1')).toBe(true);
    });

    it('clears old refs and replaces with new ones on each snapshot', async () => {
      const deps = createDeps();
      // Seed with old data
      deps.elementRefs.set('e99', { role: 'link', name: 'old' });

      await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);

      // Old ref should be gone
      expect(deps.elementRefs.has('e99')).toBe(false);
      // New refs from the mock snapshot should exist
      expect(deps.elementRefs.has('e1')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Bot-protection detection
  // -----------------------------------------------------------------------
  describe('bot-protection detection', () => {
    it('detects DataDome challenge iframe', () => {
      const tree = '- RootWebArea "etsy.com"\n  - Iframe "DataDome Device Check"';
      expect(detectBotProtection(tree)).toBe('DataDome');
    });

    it('detects DataDome block page', () => {
      const tree = '- RootWebArea "etsy.com"\n  - paragraph\n    - StaticText "Please enable JS and disable any ad blocker"';
      expect(detectBotProtection(tree)).toBe('DataDome');
    });

    it('detects Cloudflare verification', () => {
      const tree = '- RootWebArea "Just a moment..."\n  - heading "Verify you are human"';
      expect(detectBotProtection(tree)).toBe('Cloudflare');
    });

    it('detects Cloudflare secure connection check', () => {
      const tree = '- heading "Checking if the site connection is secure"';
      expect(detectBotProtection(tree)).toBe('Cloudflare');
    });

    it('detects Cloudflare Attention Required', () => {
      const tree = '- RootWebArea "Attention Required! | Cloudflare"';
      expect(detectBotProtection(tree)).toBe('Cloudflare');
    });

    it('detects PerimeterX challenge', () => {
      const tree = '- heading "Press & Hold to confirm"';
      expect(detectBotProtection(tree)).toBe('PerimeterX');
    });

    it('detects Akamai block', () => {
      const tree = '- heading "Access Denied"\n  - paragraph "Reference #18.abc123"';
      expect(detectBotProtection(tree)).toBe('Akamai');
    });

    it('detects Imperva/Incapsula', () => {
      const tree = '- paragraph "Incapsula incident ID: 123456"';
      expect(detectBotProtection(tree)).toBe('Imperva');
    });

    it('returns null for normal pages', () => {
      const tree = '- RootWebArea "Example Store"\n  - heading "Welcome"\n  - link "Shop Now"\n  - textbox "Search"';
      expect(detectBotProtection(tree)).toBeNull();
    });

    it('does not flag normal pages via executeBrowse', async () => {
      const deps = createDeps();
      const result = await executeBrowse({ action: 'load', url: 'https://example.com' }, deps);
      expect(result.content).not.toContain('BOT PROTECTION DETECTED');
    });
  });
});
