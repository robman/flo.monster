/**
 * Standalone diagnostic: verify playwright-core stealth injection.
 * Run from packages/hub/: npx tsx test-playwright-core.ts
 */

import { chromium } from 'playwright-core';
import { buildStealthScript, deriveLocale, buildWorkerPatch } from './src/browse-stealth.js';
import { mkdir, rm } from 'node:fs/promises';

const TEMP_DIR = '/tmp/flo-playwright-diag';

async function run() {
  console.log('=== playwright-core Stealth Diagnostic ===\n');

  await rm(TEMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TEMP_DIR, { recursive: true });

  const locale = deriveLocale();
  console.log(`Locale: ${locale}`);

  // No --user-agent flag: CDP + init script + route handler cover UA.
  // The old Chrome/130 placeholder was leaking through UA reduction.
  const ctx = await chromium.launchPersistentContext(TEMP_DIR, {
    headless: false,
    args: [
      '--headless=new',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--enforce-webrtc-ip-permission-check',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1419, height: 813 },
    ignoreHTTPSErrors: true,
    locale,
  });

  const v = ctx.browser()?.version() ?? '130.0.0.0';
  const major = v.split('.')[0];
  console.log(`Chromium version: ${v}`);

  // Build and inject stealth script
  const stealthScript = buildStealthScript({
    chromiumVersion: v,
    chromiumMajor: major,
    viewport: { width: 1419, height: 813 },
    locale,
  });
  console.log(`Stealth script size: ${stealthScript.length} chars`);

  await ctx.addInitScript(stealthScript);

  // CDP UA override with Client Hints metadata
  const realUA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  const defaultPage = ctx.pages()[0];
  if (defaultPage) {
    const cdp = await ctx.newCDPSession(defaultPage);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: realUA,
      acceptLanguage: `${locale},${locale.split('-')[0]};q=0.9`,
      platform: 'Linux',
      userAgentMetadata: {
        brands: [
          { brand: 'Chromium', version: major },
          { brand: 'Not_A Brand', version: '24' },
          { brand: 'Google Chrome', version: major },
        ],
        fullVersionList: [
          { brand: 'Chromium', version: v },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
          { brand: 'Google Chrome', version: v },
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
    console.log('CDP Emulation.setUserAgentOverride: OK');
  }

  // Route handler to set real UA in HTTP headers
  await ctx.route('**/*', async (route) => {
    const headers = { ...route.request().headers() };
    headers['user-agent'] = realUA;
    await route.continue({ headers });
  });

  // Navigate to trigger init script
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('data:text/html,<h1>Stealth Test</h1>');

  // Run via eval to catch errors
  const evalResult = await page.evaluate((script: string) => {
    try {
      eval(script);
      return { success: true, error: null };
    } catch (e: any) {
      return { success: false, error: e.message, stack: e.stack };
    }
  }, stealthScript);

  if (!evalResult.success) {
    console.log(`\nSTEALTH SCRIPT ERROR: ${evalResult.error}`);
    console.log(`Stack: ${evalResult.stack}\n`);
  } else {
    console.log('Stealth script eval: OK\n');
  }

  // Check all patches
  console.log('=== Patch Results ===');

  const results = await page.evaluate(async () => {
    const w = window as any;
    let uadArch: string | null = null;
    try {
      const hev = await (navigator as any).userAgentData?.getHighEntropyValues?.(['architecture', 'bitness', 'platform']);
      if (hev) uadArch = hev.architecture + '_' + hev.bitness;
    } catch {}
    return {
      chromeExists: typeof w.chrome !== 'undefined',
      chromeApp: typeof w.chrome?.app !== 'undefined',
      chromeRuntime: typeof w.chrome?.runtime !== 'undefined',
      chromeCsi: typeof w.chrome?.csi,
      chromeLoadTimes: typeof w.chrome?.loadTimes,
      sendMessageProto: w.chrome?.runtime?.sendMessage
        ? 'prototype' in w.chrome.runtime.sendMessage
        : 'N/A',
      userAgent: navigator.userAgent,
      webdriver: (navigator as any).webdriver,
      uaContainsHeadless: navigator.userAgent.includes('HeadlessChrome'),
      uaVersion: navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || 'unknown',
      plugins: navigator.plugins?.length ?? 0,
      pluginsInstanceOf: navigator.plugins instanceof PluginArray,
      mimeTypes: navigator.mimeTypes?.length ?? 0,
      mimeTypesInstanceOf: navigator.mimeTypes instanceof MimeTypeArray,
      pdfViewerEnabled: (navigator as any).pdfViewerEnabled,
      language: navigator.language,
      languages: navigator.languages,
      userAgentData: !!(navigator as any).userAgentData,
      uadBrands: (navigator as any).userAgentData?.brands?.map((b: any) => `${b.brand}/${b.version}`),
      uadPlatform: (navigator as any).userAgentData?.platform,
      screenWidth: screen.width,
      screenHeight: screen.height,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      colorDepth: screen.colorDepth,
      notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'N/A',
      hasGPU: 'gpu' in navigator,
      gpuRequestAdapter: typeof (navigator as any).gpu?.requestAdapter,
      hasConnection: 'connection' in navigator,
      connectionType: (navigator as any).connection?.type,
      connectionEffective: (navigator as any).connection?.effectiveType,
      platform: navigator.platform,
      uadArch,
    };
  });

  const ok = (v: boolean) => v ? 'OK' : 'FAIL';

  console.log(`window.chrome exists?       ${results.chromeExists}  ${ok(results.chromeExists)}`);
  console.log(`chrome.app exists?           ${results.chromeApp}  ${ok(results.chromeApp)}`);
  console.log(`chrome.runtime exists?       ${results.chromeRuntime}  ${ok(results.chromeRuntime)}`);
  console.log(`chrome.csi type:             ${results.chromeCsi}  ${ok(results.chromeCsi === 'function')}`);
  console.log(`chrome.loadTimes type:       ${results.chromeLoadTimes}  ${ok(results.chromeLoadTimes === 'function')}`);
  console.log(`sendMessage has prototype?   ${results.sendMessageProto}  ${ok(results.sendMessageProto === false)}`);
  console.log(`navigator.userAgent:         ${results.userAgent}`);
  console.log(`navigator.webdriver:         ${results.webdriver}  ${ok(results.webdriver === false)}`);
  console.log(`UA HeadlessChrome?           ${results.uaContainsHeadless ? 'YES' : 'NO'}  ${ok(!results.uaContainsHeadless)}`);
  console.log(`UA version matches real?     ${results.uaVersion === major ? 'YES' : `NO (${results.uaVersion} vs ${major})`}  ${ok(results.uaVersion === major)}`);
  console.log(`plugins count:               ${results.plugins}  ${ok(results.plugins === 3)}`);
  console.log(`plugins instanceof:          ${results.pluginsInstanceOf}  ${ok(results.pluginsInstanceOf)}`);
  console.log(`mimeTypes count:             ${results.mimeTypes}  ${ok(results.mimeTypes === 2)}`);
  console.log(`mimeTypes instanceof:        ${results.mimeTypesInstanceOf}  ${ok(results.mimeTypesInstanceOf)}`);
  console.log(`pdfViewerEnabled:            ${results.pdfViewerEnabled}  ${ok(results.pdfViewerEnabled === true)}`);
  console.log(`navigator.language:          ${results.language}  ${ok(results.language === locale)}`);
  console.log(`navigator.languages:         ${JSON.stringify(results.languages)}  ${ok(results.languages?.length >= 2)}`);
  console.log(`navigator.userAgentData:     ${results.userAgentData}  ${ok(results.userAgentData)}`);
  if (results.uadBrands) console.log(`userAgentData brands:        ${results.uadBrands.join(', ')}`);
  if (results.uadPlatform) console.log(`userAgentData platform:      ${results.uadPlatform}`);
  console.log(`screen.width:                ${results.screenWidth}  ${ok(results.screenWidth >= 1920)}`);
  console.log(`screen.height:               ${results.screenHeight}  ${ok(results.screenHeight >= 1080)}`);
  console.log(`outerWidth:                  ${results.outerWidth}  ${ok(results.outerWidth > 1419)}`);
  console.log(`outerHeight:                 ${results.outerHeight}  ${ok(results.outerHeight > 813)}`);
  console.log(`colorDepth:                  ${results.colorDepth}  ${ok(results.colorDepth === 24)}`);
  console.log(`Notification.permission:     ${results.notificationPermission}  ${ok(results.notificationPermission === 'default')}`);
  console.log(`navigator.gpu exists?        ${results.hasGPU}  ${ok(results.hasGPU)}`);
  console.log(`gpu.requestAdapter type:     ${results.gpuRequestAdapter}  ${ok(results.gpuRequestAdapter === 'function')}`);
  console.log(`navigator.connection:        ${results.hasConnection ? `${results.connectionEffective}/${results.connectionType}` : 'N/A'}  ${ok(results.hasConnection && results.connectionType === 'wifi')}`);
  console.log(`navigator.platform:          ${results.platform}  ${ok(results.platform === 'Linux x86_64')}`);
  console.log(`uad architecture:            ${results.uadArch ?? 'N/A'}  ${ok(results.uadArch === 'x86_64')}`);

  // WebGL main thread
  const webgl = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl');
      if (!gl) return { vendor: 'N/A', renderer: 'N/A' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return { vendor: 'no ext', renderer: 'no ext' };
      return {
        vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
      };
    } catch (e: any) {
      return { vendor: 'error', renderer: e.message };
    }
  });
  console.log(`WebGL vendor:                ${webgl.vendor}  ${ok(webgl.vendor.includes('Intel'))}`);
  console.log(`WebGL renderer:              ${webgl.renderer}  ${ok(webgl.renderer.includes('Intel'))}`);

  // WebGL Worker (the key test for Blob intercept)
  console.log('\n--- Worker WebGL Test ---');
  const workerWebgl = await page.evaluate(() => {
    return new Promise<{vendor: string, renderer: string}>((resolve) => {
      const code = `
        try {
          var canvas = new OffscreenCanvas(1, 1);
          var gl = canvas.getContext('webgl');
          if (!gl) { postMessage({vendor:'no gl', renderer:'no gl'}); }
          else {
            var ext = gl.getExtension('WEBGL_debug_renderer_info');
            if (!ext) { postMessage({vendor:'no ext', renderer:'no ext'}); }
            else {
              postMessage({
                vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL),
                renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
              });
            }
          }
        } catch(e) { postMessage({vendor:'error', renderer:e.message}); }
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      w.onmessage = (e: any) => { resolve(e.data); w.terminate(); };
      w.onerror = () => { resolve({vendor:'worker error', renderer:'worker error'}); w.terminate(); };
      setTimeout(() => { resolve({vendor:'timeout', renderer:'timeout'}); w.terminate(); }, 5000);
    });
  });
  console.log(`Worker WebGL vendor:         ${workerWebgl.vendor}  ${ok(workerWebgl.vendor.includes('Intel'))}`);
  console.log(`Worker WebGL renderer:        ${workerWebgl.renderer}  ${ok(workerWebgl.renderer.includes('Intel'))}`);

  // Worker identity test (UA, language, platform, architecture)
  console.log('\n--- Worker Identity Test ---');
  const workerExtra = await page.evaluate(() => {
    return new Promise<{language: string, languages: string, hasGPU: boolean, userAgent: string, platform: string, uadArch: string | null}>((resolve) => {
      const code = `
        (async function() {
          try {
            var uadArch = null;
            try {
              var hev = await self.navigator.userAgentData.getHighEntropyValues(['architecture', 'bitness']);
              uadArch = hev.architecture + '_' + hev.bitness;
            } catch(e) {}
            postMessage({
              language: self.navigator.language,
              languages: JSON.stringify(self.navigator.languages),
              hasGPU: !!self.navigator.gpu,
              userAgent: self.navigator.userAgent,
              platform: self.navigator.platform,
              uadArch: uadArch,
            });
          } catch(e) { postMessage({language:'error', languages:'error', hasGPU: false, userAgent:'error', platform:'error', uadArch: null}); }
        })();
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      const w = new Worker(url);
      w.onmessage = (e: any) => { resolve(e.data); w.terminate(); };
      w.onerror = () => { resolve({language:'error', languages:'error', hasGPU: false, userAgent:'error', platform:'error', uadArch: null}); w.terminate(); };
      setTimeout(() => { resolve({language:'timeout', languages:'timeout', hasGPU: false, userAgent:'timeout', platform:'timeout', uadArch: null}); w.terminate(); }, 5000);
    });
  });
  console.log(`Worker UA:                   ${workerExtra.userAgent.substring(0, 60)}...`);
  console.log(`Worker UA HeadlessChrome?     ${workerExtra.userAgent.includes('HeadlessChrome') ? 'YES' : 'NO'}  ${ok(!workerExtra.userAgent.includes('HeadlessChrome'))}`);
  console.log(`Worker platform:             ${workerExtra.platform}  ${ok(workerExtra.platform === 'Linux x86_64')}`);
  console.log(`Worker uad arch:             ${workerExtra.uadArch ?? 'N/A'}  ${ok(workerExtra.uadArch === 'x86_64')}`);
  console.log(`Worker language:             ${workerExtra.language}  ${ok(workerExtra.language === locale)}`);
  console.log(`Worker languages:            ${workerExtra.languages}  ${ok(workerExtra.languages.includes(locale))}`);
  console.log(`Worker navigator.gpu:        ${workerExtra.hasGPU}  (info only)`);

  // Battery API test
  console.log('\n--- Battery API Test ---');
  const battery = await page.evaluate(async () => {
    try {
      const b = await (navigator as any).getBattery();
      return { level: b.level, charging: b.charging, available: true };
    } catch {
      return { level: -1, charging: false, available: false };
    }
  });
  if (battery.available) {
    console.log(`Battery level:               ${(battery.level * 100).toFixed(0)}%  ${ok(battery.level < 1.0)}`);
    console.log(`Battery charging:            ${battery.charging}`);
  } else {
    console.log(`Battery API:                 not available`);
  }

  // Count pass/fail
  const checks = [
    results.chromeExists, results.chromeApp, results.chromeRuntime,
    results.chromeCsi === 'function', results.chromeLoadTimes === 'function',
    results.webdriver === false, !results.uaContainsHeadless, results.uaVersion === major,
    results.plugins === 3, results.pluginsInstanceOf,
    results.mimeTypes === 2, results.mimeTypesInstanceOf,
    results.pdfViewerEnabled, results.language === locale,
    results.languages?.length >= 2, results.userAgentData,
    results.screenWidth >= 1920, results.screenHeight >= 1080,
    results.outerWidth > 1419, results.outerHeight > 813,
    results.colorDepth === 24, results.notificationPermission === 'default',
    results.hasGPU, results.hasConnection && results.connectionType === 'wifi',
    results.platform === 'Linux x86_64', results.uadArch === 'x86_64',
    webgl.vendor.includes('Intel'), webgl.renderer.includes('Intel'),
    workerWebgl.vendor.includes('Intel'), workerWebgl.renderer.includes('Intel'),
    !workerExtra.userAgent.includes('HeadlessChrome'),
    workerExtra.platform === 'Linux x86_64', workerExtra.uadArch === 'x86_64',
    workerExtra.language === locale, workerExtra.languages.includes(locale),
    !battery.available || battery.level < 1.0,
  ];
  const passed = checks.filter(Boolean).length;
  console.log(`\n=== ${passed}/${checks.length} checks passed ===`);

  await ctx.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
