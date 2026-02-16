import { describe, it, expect } from 'vitest';
import { generateBootstrapScript } from './iframe-template.js';

describe('iframe-template capabilities', () => {
  const script = generateBootstrapScript('test-agent');

  describe('platform detection', () => {
    it('includes platformInfo IIFE', () => {
      expect(script).toContain('var platformInfo = (function()');
    });

    it('parses user agent for browser detection', () => {
      expect(script).toContain('navigator.userAgent');
      expect(script).toContain("browser = 'Chrome'");
      expect(script).toContain("browser = 'Safari'");
      expect(script).toContain("browser = 'Firefox'");
      expect(script).toContain("browser = 'Edge'");
      expect(script).toContain("browser = 'Opera'");
    });

    it('detects OS from user agent', () => {
      expect(script).toContain("os = 'iOS'");
      expect(script).toContain("os = 'macOS'");
      expect(script).toContain("os = 'Windows'");
      expect(script).toContain("os = 'Android'");
      expect(script).toContain("os = 'Linux'");
      expect(script).toContain("os = 'ChromeOS'");
    });

    it('detects device type', () => {
      expect(script).toContain("device = 'mobile'");
      expect(script).toContain("device = 'tablet'");
    });

    it('detects touch capability', () => {
      expect(script).toContain("'ontouchstart' in window");
      expect(script).toContain('navigator.maxTouchPoints');
    });

    it('includes devicePixelRatio', () => {
      expect(script).toContain('window.devicePixelRatio');
    });
  });

  describe('viewport helper', () => {
    it('has getViewportInfo function', () => {
      expect(script).toContain('function getViewportInfo()');
    });

    it('reads window dimensions', () => {
      expect(script).toContain('window.innerWidth');
      expect(script).toContain('window.innerHeight');
    });

    it('computes orientation from dimensions', () => {
      expect(script).toContain("w >= h ? 'landscape' : 'portrait'");
    });

    it('includes currentViewState', () => {
      expect(script).toContain('viewState: currentViewState');
    });
  });

  describe('currentViewState tracking', () => {
    it('declares currentViewState variable', () => {
      expect(script).toContain("var currentViewState = 'max'");
    });

    it('updates currentViewState on set_view_state', () => {
      expect(script).toContain('currentViewState = data.state');
    });
  });

  describe('capabilities request handler', () => {
    it('has handleCapabilitiesRequest function', () => {
      expect(script).toContain('function handleCapabilitiesRequest(msg, workerId)');
    });

    it('handles probe action locally', () => {
      expect(script).toContain("if (msg.action === 'probe')");
      expect(script).toContain('handleProbe(probe,');
    });

    it('forwards snapshot to shell via trackAndRelay', () => {
      expect(script).toContain("trackAndRelay({ type: 'capabilities_request'");
      expect(script).toContain('iframeData: iframeData');
    });

    it('forwards network and tool probes to shell', () => {
      expect(script).toContain("probe === 'network' || probe === 'tool'");
    });

    it('handles async probe results (Promise)', () => {
      expect(script).toContain("typeof probeResult.then === 'function'");
    });
  });

  describe('probe handler', () => {
    it('has handleProbe function', () => {
      expect(script).toContain('function handleProbe(probe, args)');
    });

    it('detects WebGL support', () => {
      expect(script).toContain("case 'webgl':");
      expect(script).toContain("canvas.getContext('webgl2')");
      expect(script).toContain('WEBGL_debug_renderer_info');
    });

    it('detects WebAudio support', () => {
      expect(script).toContain("case 'webaudio':");
      expect(script).toContain('AudioContext');
    });

    it('detects WebRTC support', () => {
      expect(script).toContain("case 'webrtc':");
      expect(script).toContain('RTCPeerConnection');
    });

    it('detects WebGPU support', () => {
      expect(script).toContain("case 'webgpu':");
      expect(script).toContain('navigator.gpu');
    });

    it('detects WASM support', () => {
      expect(script).toContain("case 'wasm':");
      expect(script).toContain('WebAssembly');
    });

    it('detects OffscreenCanvas support', () => {
      expect(script).toContain("case 'offscreencanvas':");
      expect(script).toContain('OffscreenCanvas');
    });

    it('detects SharedArrayBuffer support with reason', () => {
      expect(script).toContain("case 'sharedarraybuffer':");
      expect(script).toContain('cross-origin isolation');
    });

    it('detects storage quota', () => {
      expect(script).toContain("case 'storage':");
      expect(script).toContain('navigator.storage.estimate');
    });
  });

  describe('resize listener', () => {
    it('sets up resize event listener with debounce', () => {
      expect(script).toContain("window.addEventListener('resize'");
      expect(script).toContain('resizeTimer');
      expect(script).toContain('setTimeout(broadcastViewportUpdate, 250)');
    });

    it('sets up orientation change listener', () => {
      expect(script).toContain('window.screen.orientation');
      expect(script).toContain("addEventListener('change'");
    });

    it('has broadcastViewportUpdate function', () => {
      expect(script).toContain('function broadcastViewportUpdate()');
      expect(script).toContain('getViewportInfo()');
    });
  });

  describe('setupWorkerHandler routing', () => {
    it('routes capabilities_request to handleCapabilitiesRequest', () => {
      expect(script).toContain("msg.type === 'capabilities_request'");
      expect(script).toContain('handleCapabilitiesRequest(msg, workerId)');
    });
  });

  describe('shell message routing', () => {
    it('routes capabilities_result back to worker', () => {
      expect(script).toContain("case 'capabilities_result':");
    });
  });
});
