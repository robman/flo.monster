/**
 * Anti-headless-detection init scripts for persistent browser context.
 *
 * Patchright's built-in stealth requires channel:'chrome' (Google Chrome binary),
 * which is unavailable on ARM64 Linux. This module generates init scripts that
 * patch the browser environment to pass CreepJS and similar detectors.
 *
 * IMPORTANT: All injected JS uses ES5 function syntax (no arrow functions).
 * CreepJS checks for arrow functions as a signal of injected code.
 */

export interface StealthConfig {
  /** Full Chromium version, e.g. "143.0.6917.0" */
  chromiumVersion: string;
  /** Major version number, e.g. "143" */
  chromiumMajor: string;
  /** Browser viewport dimensions */
  viewport: { width: number; height: number };
  /** Locale string, e.g. "en-AU" */
  locale: string;
  /** Sections to skip (for debugging stealth issues) */
  skipSections?: Set<string>;
}

/** Timezone-to-locale lookup table */
const TZ_LOCALE_MAP: Record<string, string> = {
  'America/New_York': 'en-US',
  'America/Chicago': 'en-US',
  'America/Denver': 'en-US',
  'America/Los_Angeles': 'en-US',
  'America/Anchorage': 'en-US',
  'Pacific/Honolulu': 'en-US',
  'America/Toronto': 'en-CA',
  'America/Vancouver': 'en-CA',
  'Europe/London': 'en-GB',
  'Europe/Dublin': 'en-IE',
  'Europe/Berlin': 'de-DE',
  'Europe/Paris': 'fr-FR',
  'Europe/Madrid': 'es-ES',
  'Europe/Rome': 'it-IT',
  'Europe/Amsterdam': 'nl-NL',
  'Europe/Brussels': 'nl-BE',
  'Europe/Zurich': 'de-CH',
  'Europe/Vienna': 'de-AT',
  'Europe/Stockholm': 'sv-SE',
  'Europe/Oslo': 'nb-NO',
  'Europe/Copenhagen': 'da-DK',
  'Europe/Helsinki': 'fi-FI',
  'Europe/Warsaw': 'pl-PL',
  'Europe/Prague': 'cs-CZ',
  'Europe/Bucharest': 'ro-RO',
  'Europe/Athens': 'el-GR',
  'Europe/Istanbul': 'tr-TR',
  'Europe/Moscow': 'ru-RU',
  'Europe/Kiev': 'uk-UA',
  'Europe/Lisbon': 'pt-PT',
  'Asia/Tokyo': 'ja-JP',
  'Asia/Seoul': 'ko-KR',
  'Asia/Shanghai': 'zh-CN',
  'Asia/Hong_Kong': 'zh-HK',
  'Asia/Taipei': 'zh-TW',
  'Asia/Singapore': 'en-SG',
  'Asia/Kolkata': 'hi-IN',
  'Asia/Calcutta': 'hi-IN',
  'Asia/Dubai': 'ar-AE',
  'Asia/Bangkok': 'th-TH',
  'Asia/Jakarta': 'id-ID',
  'Australia/Sydney': 'en-AU',
  'Australia/Melbourne': 'en-AU',
  'Australia/Brisbane': 'en-AU',
  'Australia/Perth': 'en-AU',
  'Australia/Adelaide': 'en-AU',
  'Pacific/Auckland': 'en-NZ',
  'America/Sao_Paulo': 'pt-BR',
  'America/Argentina/Buenos_Aires': 'es-AR',
  'America/Mexico_City': 'es-MX',
  'Africa/Johannesburg': 'en-ZA',
  'Africa/Cairo': 'ar-EG',
  'Africa/Lagos': 'en-NG',
};

/**
 * Derive a locale from the system timezone.
 * Falls back to 'en-US' if the timezone is not in our lookup table.
 */
export function deriveLocale(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TZ_LOCALE_MAP[tz] ?? 'en-US';
  } catch {
    return 'en-US';
  }
}

/**
 * Build the stealth init script for injection via context.addInitScript().
 * Returns a self-executing IIFE string.
 */
export function buildStealthScript(config: StealthConfig): string {
  const { chromiumVersion, chromiumMajor, viewport, locale, skipSections } = config;
  const skip = skipSections ?? new Set<string>();

  // Derive languages from locale (e.g. "en-AU" → ["en-AU", "en"])
  const lang = locale.split('-')[0];
  const languages = lang === locale ? `['${locale}']` : `['${locale}', '${lang}']`;

  // Screen dimensions: at least 1920x1080
  const screenW = Math.max(viewport.width, 1920);
  const screenH = Math.max(viewport.height, 1080);

  // WebGL fake values — Linux-appropriate
  const webglVendor = 'Google Inc. (Intel)';
  const webglRenderer = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)';

  // Build the worker patch as a string constant to embed (WebGL + locale + UA + platform)
  const realUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36`;
  const workerWebGLPatch = buildWorkerPatch({
    vendor: webglVendor,
    renderer: webglRenderer,
    languages,
    locale,
    userAgent: realUA,
    platform: 'Linux x86_64',
    chromiumVersion,
    chromiumMajor,
  });

  return `(function() {

  // ---- Helper: make a function look native ----
  // NOTE: No 'use strict' — delete on non-configurable properties throws in strict mode.
  // Function.prototype is {writable:true, configurable:false}, so delete always fails.
  // We use .bind() for functions that need no prototype (sendMessage, connect).
  function _makeNativeLike(fn, name) {
    // For bound functions, prototype is already absent.
    // For regular functions, set it to undefined (can't delete non-configurable).
    if ('prototype' in fn) fn.prototype = undefined;
    var nativeStr = 'function ' + name + '() { [native code] }';
    Object.defineProperty(fn, 'toString', {
      value: function() { return nativeStr; },
      writable: true,
      configurable: true,
      enumerable: false
    });
    Object.defineProperty(fn, 'name', {
      value: name,
      writable: false,
      configurable: true,
      enumerable: false
    });
  }

  // ==== Phase 1: window.chrome ====
  // Must be defined FIRST so it appears early in Object.keys(window).
  // CreepJS hasHighChromeIndex: flags if chrome is in last 50 keys.
  // NOTE: Chromium defines a minimal window.chrome even in headless,
  // so we must patch the existing object, not skip when it exists.
  var chrome = window.chrome || {};
  {

    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        getDetails: function getDetails() { return null; },
        getIsInstalled: function getIsInstalled() { return false; },
        installState: function installState(cb) { if (cb) cb('disabled'); }
      };
    }

    if (!chrome.runtime) {
      var runtime = {};
      // .bind() creates bound functions which naturally lack .prototype
      // (native chrome.runtime.sendMessage has no prototype)
      var sendMessage = (function() {
        throw new TypeError('Invalid invocation');
      }).bind(null);
      _makeNativeLike(sendMessage, 'sendMessage');
      runtime.sendMessage = sendMessage;

      var connect = (function() {
        throw new TypeError('Invalid invocation');
      }).bind(null);
      _makeNativeLike(connect, 'connect');
      runtime.connect = connect;

      runtime.onMessage = { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } };
      runtime.onConnect = { addListener: function() {}, removeListener: function() {}, hasListeners: function() { return false; } };
      runtime.id = undefined;
      chrome.runtime = runtime;
    }

    chrome.csi = function csi() {
      return { startE: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 };
    };
    _makeNativeLike(chrome.csi, 'csi');

    chrome.loadTimes = function loadTimes() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true
      };
    };
    _makeNativeLike(chrome.loadTimes, 'loadTimes');

    window.chrome = chrome;
  }

  // ==== Phase 2: Navigator patches ====

  // --- navigator.plugins ---
  var pluginData = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
  ];
  var mimeData = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' },
    { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format' }
  ];

  try {
    var fakePlugins = [];
    var fakeMimes = [];

    for (var p = 0; p < pluginData.length; p++) {
      var pd = pluginData[p];
      var plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { value: pd.name, enumerable: true },
        filename: { value: pd.filename, enumerable: true },
        description: { value: pd.description, enumerable: true },
        length: { value: mimeData.length, enumerable: true }
      });
      fakePlugins.push(plugin);
    }

    for (var m = 0; m < mimeData.length; m++) {
      var md = mimeData[m];
      var mime = Object.create(MimeType.prototype);
      Object.defineProperties(mime, {
        type: { value: md.type, enumerable: true },
        suffixes: { value: md.suffixes, enumerable: true },
        description: { value: md.description, enumerable: true },
        enabledPlugin: { value: fakePlugins[0], enumerable: true }
      });
      fakeMimes.push(mime);
    }

    // Cross-reference: each plugin gets indexed MimeType children
    for (var pi = 0; pi < fakePlugins.length; pi++) {
      for (var mi = 0; mi < fakeMimes.length; mi++) {
        Object.defineProperty(fakePlugins[pi], mi, {
          value: fakeMimes[mi],
          enumerable: true
        });
      }
    }

    // Build PluginArray from PluginArray.prototype (not a plain Array)
    var pluginArray = Object.create(PluginArray.prototype);
    for (var idx = 0; idx < fakePlugins.length; idx++) {
      Object.defineProperty(pluginArray, idx, {
        value: fakePlugins[idx],
        enumerable: true,
        configurable: true
      });
    }
    // Named properties (non-enumerable)
    for (var ni = 0; ni < fakePlugins.length; ni++) {
      Object.defineProperty(pluginArray, fakePlugins[ni].name, {
        value: fakePlugins[ni],
        enumerable: false,
        configurable: true
      });
    }
    Object.defineProperty(pluginArray, 'length', {
      get: function() { return fakePlugins.length; },
      configurable: true
    });
    var pluginItem = function item(i) { return fakePlugins[i] || null; };
    _makeNativeLike(pluginItem, 'item');
    pluginArray.item = pluginItem;
    var pluginNamedItem = function namedItem(name) {
      for (var i = 0; i < fakePlugins.length; i++) {
        if (fakePlugins[i].name === name) return fakePlugins[i];
      }
      return null;
    };
    _makeNativeLike(pluginNamedItem, 'namedItem');
    pluginArray.namedItem = pluginNamedItem;
    var pluginRefresh = function refresh() {};
    _makeNativeLike(pluginRefresh, 'refresh');
    pluginArray.refresh = pluginRefresh;
    pluginArray[Symbol.iterator] = function() {
      var i = 0;
      var plugins = fakePlugins;
      return {
        next: function() {
          if (i < plugins.length) return { value: plugins[i++], done: false };
          return { value: undefined, done: true };
        }
      };
    };

    // Build MimeTypeArray from MimeTypeArray.prototype (not a plain Array)
    var mimeTypeArray = Object.create(MimeTypeArray.prototype);
    for (var midx = 0; midx < fakeMimes.length; midx++) {
      Object.defineProperty(mimeTypeArray, midx, {
        value: fakeMimes[midx],
        enumerable: true,
        configurable: true
      });
    }
    // Named properties for mime types (non-enumerable)
    for (var mni = 0; mni < fakeMimes.length; mni++) {
      Object.defineProperty(mimeTypeArray, fakeMimes[mni].type, {
        value: fakeMimes[mni],
        enumerable: false,
        configurable: true
      });
    }
    Object.defineProperty(mimeTypeArray, 'length', {
      get: function() { return fakeMimes.length; },
      configurable: true
    });
    var mimeItem = function item(i) { return fakeMimes[i] || null; };
    _makeNativeLike(mimeItem, 'item');
    mimeTypeArray.item = mimeItem;
    var mimeNamedItem = function namedItem(type) {
      for (var i = 0; i < fakeMimes.length; i++) {
        if (fakeMimes[i].type === type) return fakeMimes[i];
      }
      return null;
    };
    _makeNativeLike(mimeNamedItem, 'namedItem');
    mimeTypeArray.namedItem = mimeNamedItem;
    mimeTypeArray[Symbol.iterator] = function() {
      var i = 0;
      var mimes = fakeMimes;
      return {
        next: function() {
          if (i < mimes.length) return { value: mimes[i++], done: false };
          return { value: undefined, done: true };
        }
      };
    };

    Object.defineProperty(navigator, 'plugins', {
      get: function() { return pluginArray; },
      configurable: true
    });

    Object.defineProperty(navigator, 'mimeTypes', {
      get: function() { return mimeTypeArray; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.pdfViewerEnabled ---
  try {
    Object.defineProperty(navigator, 'pdfViewerEnabled', {
      get: function() { return true; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.languages ---
  try {
    Object.defineProperty(navigator, 'languages', {
      get: function() { return ${languages}; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.language (singular) ---
  try {
    Object.defineProperty(navigator, 'language', {
      get: function() { return '${locale}'; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.userAgentData ---
${skip.has('userAgentData') ? '  // SKIPPED: userAgentData' : `  try {
    var brands = [
      { brand: 'Chromium', version: '${chromiumMajor}' },
      { brand: 'Not_A Brand', version: '24' },
      { brand: 'Google Chrome', version: '${chromiumMajor}' }
    ];
    var uaData = {
      brands: brands,
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: brands,
          mobile: false,
          platform: 'Linux',
          platformVersion: '6.8.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: '${chromiumVersion}',
          fullVersionList: [
            { brand: 'Chromium', version: '${chromiumVersion}' },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
            { brand: 'Google Chrome', version: '${chromiumVersion}' }
          ]
        });
      },
      toJSON: function() {
        return { brands: brands, mobile: false, platform: 'Linux' };
      }
    };
    Object.defineProperty(navigator, 'userAgentData', {
      get: function() { return uaData; },
      configurable: true,
      enumerable: true
    });
  } catch(e) {}`}

  // --- navigator.userAgent ---
  // Always set to real version (--user-agent flag may use a placeholder version)
  try {
    var realUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36';
    Object.defineProperty(navigator, 'userAgent', {
      get: function() { return realUA; },
      configurable: true
    });
    var realAppVersion = '5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumVersion} Safari/537.36';
    Object.defineProperty(navigator, 'appVersion', {
      get: function() { return realAppVersion; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.platform ---
  try {
    Object.defineProperty(navigator, 'platform', {
      get: function() { return 'Linux x86_64'; },
      configurable: true
    });
  } catch(e) {}

  // --- Notification.permission ---
  try {
    Object.defineProperty(Notification, 'permission', {
      get: function() { return 'default'; },
      configurable: true
    });
  } catch(e) {}

  // --- navigator.share / navigator.canShare ---
  try {
    if (!navigator.share) {
      navigator.share = function share() {
        return Promise.reject(new DOMException('Share canceled', 'AbortError'));
      };
      _makeNativeLike(navigator.share, 'share');
    }
    if (!navigator.canShare) {
      navigator.canShare = function canShare() { return false; };
      _makeNativeLike(navigator.canShare, 'canShare');
    }
  } catch(e) {}

  // ==== Phase 3: Screen & window dimensions ====
  try {
    Object.defineProperty(screen, 'width', { get: function() { return ${screenW}; } });
    Object.defineProperty(screen, 'height', { get: function() { return ${screenH}; } });
    Object.defineProperty(screen, 'availWidth', { get: function() { return ${screenW}; } });
    Object.defineProperty(screen, 'availHeight', { get: function() { return ${screenH - 48}; } });
    Object.defineProperty(screen, 'colorDepth', { get: function() { return 24; } });
    Object.defineProperty(screen, 'pixelDepth', { get: function() { return 24; } });
    Object.defineProperty(window, 'outerWidth', { get: function() { return ${viewport.width + 16}; } });
    Object.defineProperty(window, 'outerHeight', { get: function() { return ${viewport.height + 85}; } });
  } catch(e) {}

  // ==== Phase 4: WebGL renderer (main thread) ====
  var UNMASKED_VENDOR = 0x9245;
  var UNMASKED_RENDERER = 0x9246;
  var FAKE_VENDOR = '${webglVendor}';
  var FAKE_RENDERER = '${webglRenderer}';

  function patchGetParameter(proto) {
    if (!proto) return;
    var original = proto.getParameter;
    if (!original) return;
    proto.getParameter = function getParameter(param) {
      if (param === UNMASKED_VENDOR) return FAKE_VENDOR;
      if (param === UNMASKED_RENDERER) return FAKE_RENDERER;
      return original.call(this, param);
    };
  }

  try {
    patchGetParameter(WebGLRenderingContext.prototype);
  } catch(e) {}
  try {
    patchGetParameter(WebGL2RenderingContext.prototype);
  } catch(e) {}

  // ==== Phase 5: Worker WebGL patch ====
  // CreepJS checks WebGL renderer from a Web Worker via OffscreenCanvas.
  // Init scripts don't run in Workers, so we intercept the Worker constructor
  // to prepend patches into blob: URL workers.
  // NOTE: Previously also patched window.Blob to inject into ALL JS blobs,
  // but that broke Google Forms' Wiz framework (Deferred double-fire from
  // prepended code in non-Worker JS blobs). Now Worker-only.
${skip.has('workerPatch') ? '  // SKIPPED: workerPatch' : `  try {
    var WEBGL_WORKER_PATCH = ${JSON.stringify(workerWebGLPatch)};

    var OrigWorker = window.Worker;
    var OrigBlob = window.Blob;
    var PatchedWorker = function Worker(url, opts) {
      var urlStr = (url && typeof url.toString === 'function') ? url.toString() : String(url);
      if (urlStr.startsWith('blob:')) {
        try {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', urlStr, false);
          xhr.send();
          if (xhr.status === 200) {
            var patched = WEBGL_WORKER_PATCH + '\\n' + xhr.responseText;
            var blob = new OrigBlob([patched], { type: 'application/javascript' });
            var newUrl = URL.createObjectURL(blob);
            var w = new OrigWorker(newUrl, opts);
            URL.revokeObjectURL(newUrl);
            return w;
          }
        } catch(e) {}
      }
      return new OrigWorker(url, opts);
    };
    Object.defineProperty(PatchedWorker, 'prototype', {
      value: OrigWorker.prototype,
      writable: false,
      configurable: false,
      enumerable: false
    });
    _makeNativeLike(PatchedWorker, 'Worker');
    window.Worker = PatchedWorker;
  } catch(e) {}`}

  // ==== Phase 6: Permissions ====
${skip.has('permissions') ? '  // SKIPPED: permissions' : `  try {
    var origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function query(desc) {
      if (desc && desc.name === 'notifications') {
        return Promise.resolve({ state: 'default', onchange: null });
      }
      return origQuery(desc);
    };
  } catch(e) {}`}

  // ==== Phase 7: RTCPeerConnection ====
  // Strip STUN/TURN servers as belt-and-suspenders with launch flags
  try {
    var OrigRTC = window.RTCPeerConnection;
    if (OrigRTC) {
      window.RTCPeerConnection = function RTCPeerConnection(config, constraints) {
        if (config) {
          config = Object.assign({}, config);
          config.iceServers = [];
        }
        return new OrigRTC(config, constraints);
      };
      window.RTCPeerConnection.prototype = OrigRTC.prototype;
      _makeNativeLike(window.RTCPeerConnection, 'RTCPeerConnection');
    }
    if (window.webkitRTCPeerConnection) {
      var OrigWebkitRTC = window.webkitRTCPeerConnection;
      window.webkitRTCPeerConnection = function webkitRTCPeerConnection(config, constraints) {
        if (config) {
          config = Object.assign({}, config);
          config.iceServers = [];
        }
        return new OrigWebkitRTC(config, constraints);
      };
      window.webkitRTCPeerConnection.prototype = OrigWebkitRTC.prototype;
      _makeNativeLike(window.webkitRTCPeerConnection, 'webkitRTCPeerConnection');
    }
  } catch(e) {}

  // ==== Phase 8: WebGPU ====
  // Headless Chromium may not expose navigator.gpu at all.
  // Create a stub so fingerprinters see it exists (like real Chrome).
  try {
    if (!navigator.gpu) {
      Object.defineProperty(navigator, 'gpu', {
        get: function() {
          return {
            requestAdapter: function requestAdapter() {
              return Promise.resolve(null);
            },
            getPreferredCanvasFormat: function getPreferredCanvasFormat() {
              return 'bgra8unorm';
            }
          };
        },
        configurable: true,
        enumerable: true
      });
    } else {
      var origRequestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
      navigator.gpu.requestAdapter = function requestAdapter() {
        return Promise.resolve(null);
      };
    }
  } catch(e) {}

  // ==== Phase 9: Battery API ====
  // Servers always show 100% charging. Fake a realistic laptop battery.
  try {
    if (navigator.getBattery) {
      var origGetBattery = navigator.getBattery.bind(navigator);
      navigator.getBattery = function getBattery() {
        return Promise.resolve({
          charging: true,
          chargingTime: 0,
          dischargingTime: Infinity,
          level: 0.97,
          addEventListener: function() {},
          removeEventListener: function() {},
          dispatchEvent: function() { return true; },
          onchargingchange: null,
          onchargingtimechange: null,
          ondischargingtimechange: null,
          onlevelchange: null
        });
      };
      _makeNativeLike(navigator.getBattery, 'getBattery');
    }
  } catch(e) {}

  // ==== Phase 10: NetworkInformation ====
  // Fake realistic desktop connection info to avoid server network fingerprint.
  try {
    var connInfo = {
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      downlinkMax: Infinity,
      saveData: false,
      type: 'wifi',
      onchange: null,
      addEventListener: function() {},
      removeEventListener: function() {},
      dispatchEvent: function() { return true; }
    };
    Object.defineProperty(navigator, 'connection', {
      get: function() { return connInfo; },
      configurable: true,
      enumerable: true
    });
  } catch(e) {}

})();`;
}

/**
 * Build the patch code that gets injected into Web Workers.
 * Patches WebGL renderer (must match main thread to avoid hasBadWebGL),
 * navigator.languages and navigator.language (must match main thread to avoid locale mismatch),
 * and WebGPU (avoid SwiftShader leak in worker contexts).
 */
export function buildWorkerPatch(config: {
  vendor: string;
  renderer: string;
  languages: string;
  locale: string;
  userAgent: string;
  platform: string;
  chromiumVersion: string;
  chromiumMajor: string;
}): string {
  return `(function() {
  var UNMASKED_VENDOR = 0x9245;
  var UNMASKED_RENDERER = 0x9246;
  var FAKE_VENDOR = ${JSON.stringify(config.vendor)};
  var FAKE_RENDERER = ${JSON.stringify(config.renderer)};
  function patchProto(name) {
    try {
      var proto = self[name];
      if (!proto || !proto.prototype || !proto.prototype.getParameter) return;
      var orig = proto.prototype.getParameter;
      proto.prototype.getParameter = function(param) {
        if (param === UNMASKED_VENDOR) return FAKE_VENDOR;
        if (param === UNMASKED_RENDERER) return FAKE_RENDERER;
        return orig.call(this, param);
      };
    } catch(e) {}
  }
  patchProto('WebGLRenderingContext');
  patchProto('WebGL2RenderingContext');
  try {
    Object.defineProperty(self.navigator, 'languages', {
      get: function() { return ${config.languages}; },
      configurable: true
    });
  } catch(e) {}
  try {
    Object.defineProperty(self.navigator, 'language', {
      get: function() { return '${config.locale}'; },
      configurable: true
    });
  } catch(e) {}
  try {
    Object.defineProperty(self.navigator, 'userAgent', {
      get: function() { return ${JSON.stringify(config.userAgent)}; },
      configurable: true
    });
  } catch(e) {}
  try {
    Object.defineProperty(self.navigator, 'appVersion', {
      get: function() { return ${JSON.stringify(config.userAgent.replace('Mozilla/', ''))}; },
      configurable: true
    });
  } catch(e) {}
  try {
    Object.defineProperty(self.navigator, 'platform', {
      get: function() { return ${JSON.stringify(config.platform)}; },
      configurable: true
    });
  } catch(e) {}
  try {
    var wBrands = [
      { brand: 'Chromium', version: '${config.chromiumMajor}' },
      { brand: 'Not_A Brand', version: '24' },
      { brand: 'Google Chrome', version: '${config.chromiumMajor}' }
    ];
    var wUaData = {
      brands: wBrands,
      mobile: false,
      platform: 'Linux',
      getHighEntropyValues: function(hints) {
        return Promise.resolve({
          brands: wBrands,
          mobile: false,
          platform: 'Linux',
          platformVersion: '6.8.0',
          architecture: 'x86',
          bitness: '64',
          model: '',
          uaFullVersion: '${config.chromiumVersion}',
          fullVersionList: [
            { brand: 'Chromium', version: '${config.chromiumVersion}' },
            { brand: 'Not_A Brand', version: '24.0.0.0' },
            { brand: 'Google Chrome', version: '${config.chromiumVersion}' }
          ]
        });
      },
      toJSON: function() {
        return { brands: wBrands, mobile: false, platform: 'Linux' };
      }
    };
    Object.defineProperty(self.navigator, 'userAgentData', {
      get: function() { return wUaData; },
      configurable: true,
      enumerable: true
    });
  } catch(e) {}
  try {
    if (self.navigator && self.navigator.gpu) {
      self.navigator.gpu.requestAdapter = function requestAdapter() {
        return Promise.resolve(null);
      };
    }
  } catch(e) {}
})();`;
}
