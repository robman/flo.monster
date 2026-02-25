/**
 * Tests for anti-headless-detection stealth scripts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildStealthScript, deriveLocale, buildWorkerPatch } from '../browse-stealth.js';
import type { StealthConfig } from '../browse-stealth.js';

// --- Helpers ---

function makeConfig(overrides: Partial<StealthConfig> = {}): StealthConfig {
  return {
    chromiumVersion: '143.0.6917.0',
    chromiumMajor: '143',
    viewport: { width: 1280, height: 720 },
    locale: 'en-AU',
    ...overrides,
  };
}

// --- Tests ---

describe('buildStealthScript', () => {
  it('should return a non-empty string', () => {
    const script = buildStealthScript(makeConfig());
    expect(script.length).toBeGreaterThan(0);
  });

  it('should be a self-executing IIFE', () => {
    const script = buildStealthScript(makeConfig());
    expect(script.trimStart().startsWith('(function()')).toBe(true);
    expect(script.trimEnd().endsWith('})();')).toBe(true);
  });

  it('should be syntactically valid JavaScript', () => {
    const script = buildStealthScript(makeConfig());
    // new Function() parses the body — throws SyntaxError if invalid
    expect(() => new Function(script)).not.toThrow();
  });

  it('should contain NO arrow functions', () => {
    const script = buildStealthScript(makeConfig());
    // Check for arrow function patterns: => (but not inside strings like "=>" in comments)
    // Remove string literals first to avoid false positives
    const withoutStrings = script.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
    expect(withoutStrings).not.toContain('=>');
  });

  it('should NOT use new Proxy (avoids hasIframeProxy)', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).not.toContain('new Proxy');
  });

  it('should NOT override Function.prototype.toString globally (avoids hasToStringProxy)', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).not.toContain('Function.prototype.toString');
  });

  it('should contain _makeNativeLike helper', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('_makeNativeLike');
    expect(script).toContain('[native code]');
  });

  // --- Phase 1: window.chrome ---
  it('should patch window.chrome with runtime, app, csi, loadTimes', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('window.chrome');
    expect(script).toContain('chrome.app');
    expect(script).toContain('chrome.runtime');
    expect(script).toContain('chrome.csi');
    expect(script).toContain('chrome.loadTimes');
  });

  it('should define chrome FIRST (before navigator patches)', () => {
    const script = buildStealthScript(makeConfig());
    const chromeIdx = script.indexOf('window.chrome');
    const navigatorIdx = script.indexOf('navigator.plugins');
    expect(chromeIdx).toBeLessThan(navigatorIdx);
  });

  it('should make sendMessage and connect look native', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain("_makeNativeLike(sendMessage, 'sendMessage')");
    expect(script).toContain("_makeNativeLike(connect, 'connect')");
  });

  // --- Phase 2: Navigator patches ---
  it('should patch navigator.plugins with PDF plugins', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('PDF Viewer');
    expect(script).toContain('Chrome PDF Viewer');
    expect(script).toContain('namedItem');
    expect(script).toContain('navigator.plugins');
  });

  it('should patch navigator.mimeTypes', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain("'mimeTypes'");
    expect(script).toContain('application/pdf');
  });

  it('should patch navigator.pdfViewerEnabled', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('pdfViewerEnabled');
  });

  it('should patch navigator.userAgentData with correct version', () => {
    const script = buildStealthScript(makeConfig({ chromiumMajor: '143', chromiumVersion: '143.0.6917.0' }));
    expect(script).toContain('userAgentData');
    expect(script).toContain("version: '143'");
    expect(script).toContain("'143.0.6917.0'");
    expect(script).toContain('Google Chrome');
  });

  it('should always create userAgentData without conditional guard', () => {
    const script = buildStealthScript(makeConfig());
    // Should NOT have the old guard that checked for existing userAgentData
    expect(script).not.toContain('if (navigator.userAgentData || typeof NavigatorUAData');
  });

  it('should interpolate version correctly', () => {
    const script = buildStealthScript(makeConfig({
      chromiumVersion: '200.1.2.3',
      chromiumMajor: '200',
    }));
    expect(script).toContain("'200.1.2.3'");
    expect(script).toContain("version: '200'");
  });

  it('should set navigator.languages from locale', () => {
    const script = buildStealthScript(makeConfig({ locale: 'en-AU' }));
    expect(script).toContain("['en-AU', 'en']");
  });

  it('should handle single-segment locale', () => {
    const script = buildStealthScript(makeConfig({ locale: 'en' }));
    expect(script).toContain("['en']");
  });

  it('should patch navigator.language (singular) from locale', () => {
    const script = buildStealthScript(makeConfig({ locale: 'en-AU' }));
    expect(script).toContain("navigator, 'language'");
    expect(script).toContain("return 'en-AU'");
  });

  it('should set navigator.userAgent to real Chrome version', () => {
    const script = buildStealthScript(makeConfig());
    // UA is set to full Chrome version string (not just HeadlessChrome replace)
    expect(script).toContain('Chrome/143.0.6917.0 Safari/537.36');
    expect(script).toContain("navigator, 'userAgent'");
    expect(script).toContain("navigator, 'appVersion'");
  });

  it('should patch Notification.permission', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('Notification');
    expect(script).toContain("'default'");
  });

  it('should add navigator.share and navigator.canShare stubs', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('navigator.share');
    expect(script).toContain('navigator.canShare');
  });

  // --- Phase 3: Screen & window dimensions ---
  it('should set screen dimensions to at least 1920x1080', () => {
    const script = buildStealthScript(makeConfig({ viewport: { width: 800, height: 600 } }));
    expect(script).toContain('return 1920');
    expect(script).toContain('return 1080');
  });

  it('should interpolate viewport correctly for outer dimensions', () => {
    const script = buildStealthScript(makeConfig({ viewport: { width: 1419, height: 813 } }));
    // outerWidth = viewport + 16 = 1435
    expect(script).toContain('return 1435');
    // outerHeight = viewport + 85 = 898
    expect(script).toContain('return 898');
  });

  it('should set colorDepth and pixelDepth to 24', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('colorDepth');
    expect(script).toContain('pixelDepth');
    expect(script).toContain('return 24');
  });

  it('should set availHeight to screenH minus 48 (taskbar)', () => {
    const script = buildStealthScript(makeConfig({ viewport: { width: 1280, height: 720 } }));
    // screenH = max(720, 1080) = 1080, availHeight = 1080 - 48 = 1032
    expect(script).toContain('return 1032');
  });

  // --- Phase 4: WebGL (main thread) ---
  it('should patch WebGL with Linux-appropriate values', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('Google Inc. (Intel)');
    expect(script).toContain('ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)');
    // Should NOT contain Direct3D
    expect(script).not.toContain('Direct3D');
    // Should reference both WebGL1 and WebGL2
    expect(script).toContain('WebGLRenderingContext');
    expect(script).toContain('WebGL2RenderingContext');
  });

  it('should use correct WebGL extension constants', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('0x9245'); // UNMASKED_VENDOR_WEBGL
    expect(script).toContain('0x9246'); // UNMASKED_RENDERER_WEBGL
  });

  // --- Phase 5: Worker WebGL patch ---
  it('should NOT intercept Blob constructor (broke Google Forms Wiz framework)', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).not.toContain('BlobPatch');
    expect(script).not.toContain('window.Blob = BlobPatch');
    // OrigBlob is still used inside the Worker constructor patch
    expect(script).toContain('OrigBlob');
  });

  it('should intercept Worker constructor with URL object support', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('OrigWorker');
    expect(script).toContain('XMLHttpRequest');
    expect(script).toContain("xhr.open('GET', urlStr, false)");
    expect(script).toContain('window.Worker = PatchedWorker');
    // Should handle URL objects via toString
    expect(script).toContain('url.toString');
  });

  it('should embed Worker WebGL patch with same fake values', () => {
    const script = buildStealthScript(makeConfig());
    // The embedded worker patch string should contain the same WebGL values
    expect(script).toContain('WEBGL_WORKER_PATCH');
    // Count occurrences of the fake vendor — should appear in both main and worker patches
    const vendorOccurrences = script.split('Google Inc. (Intel)').length - 1;
    expect(vendorOccurrences).toBeGreaterThanOrEqual(2);
  });

  it('should patch navigator.languages in Worker to match main thread', () => {
    const script = buildStealthScript(makeConfig({ locale: 'en-AU' }));
    // The embedded worker patch string should contain languages override
    // It appears inside the WEBGL_WORKER_PATCH JSON string
    expect(script).toContain('navigator');
    expect(script).toContain('languages');
    // The worker patch should have the same locale as main thread
    expect(script).toContain('en-AU');
  });

  // --- Phase 6: Permissions ---
  it('should patch permissions.query for notifications', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('permissions.query');
    expect(script).toContain('notifications');
  });

  // --- Phase 7: RTCPeerConnection ---
  it('should strip iceServers from RTCPeerConnection', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('RTCPeerConnection');
    expect(script).toContain('iceServers');
    expect(script).toContain('webkitRTCPeerConnection');
  });

  // --- Phase 8: WebGPU ---
  it('should patch navigator.gpu.requestAdapter', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('navigator.gpu');
    expect(script).toContain('requestAdapter');
    expect(script).toContain('Promise.resolve(null)');
  });

  // --- Phase 9: Battery API ---
  it('should patch navigator.getBattery with realistic values', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain('getBattery');
    expect(script).toContain('0.97');
    expect(script).toContain('onlevelchange');
  });

  // --- Phase 10: NetworkInformation ---
  it('should patch navigator.connection with desktop values', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain("'connection'");
    expect(script).toContain("effectiveType");
    expect(script).toContain("'wifi'");
  });

  // --- Worker patch improvements ---
  it('should patch navigator.language (singular) in Worker to match locale', () => {
    const script = buildStealthScript(makeConfig({ locale: 'en-AU' }));
    // The worker patch JSON string should contain the language singular patch
    // Count navigator.language patches — should be in both main and worker
    expect(script).toContain("'language'");
    // Worker patch should contain the locale
    const workerSection = script.substring(script.indexOf('WEBGL_WORKER_PATCH'));
    expect(workerSection).toContain('en-AU');
  });

  it('should patch navigator.gpu in Worker to avoid SwiftShader leak', () => {
    const script = buildStealthScript(makeConfig());
    // The WEBGL_WORKER_PATCH string should contain gpu patching
    // The worker patch is JSON-stringified, so extract a large section
    const workerPatchStart = script.indexOf('WEBGL_WORKER_PATCH');
    const workerSection = script.substring(workerPatchStart, workerPatchStart + 5000);
    expect(workerSection).toContain('gpu');
    expect(workerSection).toContain('requestAdapter');
  });

  // --- navigator.platform ---
  it('should patch navigator.platform', () => {
    const script = buildStealthScript(makeConfig());
    expect(script).toContain("navigator, 'platform'");
    expect(script).toContain('Linux x86_64');
  });

  // --- Worker userAgent and userAgentData ---
  it('should patch navigator.userAgent in Worker', () => {
    const script = buildStealthScript(makeConfig());
    const workerPatchStart = script.indexOf('WEBGL_WORKER_PATCH');
    const workerSection = script.substring(workerPatchStart, workerPatchStart + 5000);
    expect(workerSection).toContain('userAgent');
    expect(workerSection).toContain('Chrome/143.0.6917.0');
  });

  it('should patch navigator.userAgentData in Worker with correct architecture', () => {
    const script = buildStealthScript(makeConfig());
    const workerPatchStart = script.indexOf('WEBGL_WORKER_PATCH');
    const workerSection = script.substring(workerPatchStart, workerPatchStart + 5000);
    expect(workerSection).toContain('userAgentData');
    expect(workerSection).toContain("architecture: 'x86'");
  });

  // --- Architecture format ---
  it('should use correct architecture format in getHighEntropyValues', () => {
    const script = buildStealthScript(makeConfig());
    // Chrome returns 'x86' not 'x86_64' for architecture
    expect(script).toContain("architecture: 'x86'");
    expect(script).toContain("bitness: '64'");
  });

  // --- buildWorkerPatch export ---
  it('should export buildWorkerPatch function', () => {
    const patch = buildWorkerPatch({
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
      languages: "['en-AU', 'en']",
      locale: 'en-AU',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.6917.0 Safari/537.36',
      platform: 'Linux x86_64',
      chromiumVersion: '143.0.6917.0',
      chromiumMajor: '143',
    });
    expect(typeof patch).toBe('string');
    expect(patch.length).toBeGreaterThan(0);
    expect(patch).toContain('en-AU');
    expect(patch).toContain('requestAdapter');
    expect(patch).toContain('0x9245');
    expect(patch).toContain('Chrome/143.0.6917.0');
    expect(patch).toContain('Linux x86_64');
    expect(patch).toContain('userAgentData');
  });
});

describe('deriveLocale', () => {
  let originalDateTimeFormat: typeof Intl.DateTimeFormat;

  beforeEach(() => {
    originalDateTimeFormat = Intl.DateTimeFormat;
  });

  afterEach(() => {
    // Restore original
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: originalDateTimeFormat,
      writable: true,
      configurable: true,
    });
  });

  it('should return a valid locale string', () => {
    const locale = deriveLocale();
    // Should be something like "xx-YY" or "xx"
    expect(locale).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
  });

  it('should map America/New_York to en-US', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'America/New_York' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('en-US');
  });

  it('should map Australia/Sydney to en-AU', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'Australia/Sydney' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('en-AU');
  });

  it('should map Europe/London to en-GB', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'Europe/London' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('en-GB');
  });

  it('should map Asia/Tokyo to ja-JP', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'Asia/Tokyo' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('ja-JP');
  });

  it('should map Europe/Berlin to de-DE', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'Europe/Berlin' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('de-DE');
  });

  it('should default to en-US for unknown timezone', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() {
        return { resolvedOptions: function() { return { timeZone: 'Antarctica/McMurdo' }; } };
      },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('en-US');
  });

  it('should default to en-US if Intl throws', () => {
    Object.defineProperty(Intl, 'DateTimeFormat', {
      value: function() { throw new Error('Intl not available'); },
      writable: true,
      configurable: true,
    });
    expect(deriveLocale()).toBe('en-US');
  });
});
