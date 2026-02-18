/**
 * Generates just the bootstrap JavaScript for agent iframes.
 * Used for injecting into custom template srcdoc.
 */
export function generateBootstrapScript(agentId: string): string {
  return `<script data-flo-bootstrap>
(function() {
  // Prevent re-initialization if script is re-executed (e.g., from restored DOM state)
  // This preserves the workers map and flo API from the original initialization
  if (window.flo && window.flo._initialized) return;

  // ============================================================================
  // State
  // ============================================================================
  var workers = {};  // workerId -> Worker
  var requestSources = {};  // requestId -> workerId
  var agentId = ${JSON.stringify(agentId)};
  var eventListeners = {};  // key (selector::workerId) -> { events, workerId, handler, options }
  var eventWaiters = {};    // id -> { selector, event, workerId, handler, timeoutId }
  var pendingAsks = {};     // id -> { resolve, reject, timeout }
  var pendingSrcdocTools = {};  // id -> { resolve, reject, timeout }
  var pendingPermissions = {};  // id -> { resolve, reject, timeout }
  var pendingMediaRequests = {};  // id -> { resolve, reject, timeout }
  var mediaConnections = {};      // id -> { pc: RTCPeerConnection, stream: MediaStream|null }
  var pendingSpeechSessions = {};  // id -> { session, oninterim }
  var pendingSpeechRequests = {};  // id -> { resolve, reject, timeout } (for speak/voices)
  var pendingGeoRequests = {};  // id -> { resolve, reject, timeout }
  var activeGeoWatches = {};    // id -> { onposition, onerror }
  var MAX_EVENT_QUEUE_SIZE = 100;

  // ============================================================================
  // Reactive State — flo.state cache, onChange handlers, escalation rules
  // ============================================================================
  var stateCache = {};
  var stateChangeHandlers = {};  // handlerId -> { keyOrPattern, callback }
  var stateEscalationRules = {};  // key -> { condition: fn|true, message: string|null }
  var statePersistTimer = null;
  var stateLoaded = false;
  var stateLoadPendingId = null;
  var stateLoadQueue = [];  // queued state_request messages waiting for state to load
  var nextHandlerId = 0;
  var currentViewState = 'max';

  // ============================================================================
  // Shared Helpers — ID generation, message relay, pending request resolution
  // ============================================================================

  /** Generate a unique ID with the given prefix (matches @flo-monster/core/utils/ids pattern). */
  function generateId(prefix) {
    return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  /** Send a message to the parent shell, stamped with agentId. */
  function relayToShell(msg) {
    msg.agentId = agentId;
    parent.postMessage(msg, '*');
  }

  /** Send a message to a specific worker (if it exists). */
  function relayToWorker(workerId, msg) {
    var w = workers[workerId];
    if (w) w.postMessage(msg);
  }

  /** Send a message to every active worker. */
  function broadcastToWorkers(msg) {
    var ids = Object.keys(workers);
    for (var i = 0; i < ids.length; i++) {
      workers[ids[i]].postMessage(msg);
    }
  }

  /**
   * Resolve or reject a pending request from a map (pendingAsks, pendingSrcdocTools, etc.),
   * clean it up, and clear its timeout. Returns true if the entry existed.
   *
   * Usage: resolvePendingRequest(pendingAsks, id, result, errorMsg)
   *   - If errorMsg is truthy, calls pending.reject(new Error(errorMsg))
   *   - Otherwise calls pending.resolve(result)
   */
  function resolvePendingRequest(map, id, result, errorMsg) {
    var entry = map[id];
    if (!entry) return false;
    clearTimeout(entry.timeout);
    delete map[id];
    if (errorMsg) {
      entry.reject(new Error(errorMsg));
    } else {
      entry.resolve(result);
    }
    return true;
  }

  /**
   * Register a pending request in a map with a timeout that auto-rejects.
   * Returns the { resolve, reject, timeout } entry that was stored.
   */
  function registerPendingRequest(map, id, resolve, reject, timeoutMs, timeoutMsg) {
    var timeout = setTimeout(function() {
      delete map[id];
      reject(new Error(timeoutMsg));
    }, timeoutMs);
    var entry = { resolve: resolve, reject: reject, timeout: timeout };
    map[id] = entry;
    return entry;
  }

  /**
   * Track a request's source worker so responses can be routed back,
   * then relay the message to the shell.
   */
  function trackAndRelay(msg, workerId) {
    requestSources[msg.id] = workerId;
    msg.agentId = agentId;
    msg.workerId = workerId;
    parent.postMessage(msg, '*');
  }

  // ============================================================================
  // Event Handling — listeners, waiters, serialization, debouncing
  // ============================================================================

  function createDebouncedHandler(fn, delay) {
    if (!delay || delay <= 0) return fn;
    var timeoutId = null;
    return function() {
      var args = arguments;
      var self = this;
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(function() {
        timeoutId = null;
        fn.apply(self, args);
      }, delay);
    };
  }

  function resolveTargetWorker(element, defaultWorkerId) {
    // Check for data-agent attribute on element or ancestors
    var agentAttr = element.closest('[data-agent]');
    if (agentAttr) {
      var targetId = agentAttr.getAttribute('data-agent');
      if (workers[targetId]) return targetId;
    }
    return defaultWorkerId || 'main';
  }

  function serializeEvent(e, selector) {
    var target = e.target;
    var result = {
      type: e.type,
      selector: selector,
      timestamp: Date.now(),
      target: {
        tagName: target.tagName || '',
        id: target.id || '',
        className: target.className || '',
        value: target.value,
        textContent: (target.textContent || '').substring(0, 100),
        dataset: {}
      }
    };
    // Copy dataset
    if (target.dataset) {
      var keys = Object.keys(target.dataset);
      for (var i = 0; i < keys.length; i++) {
        result.target.dataset[keys[i]] = target.dataset[keys[i]];
      }
    }
    // Include form data for submit events
    if (e.type === 'submit' && target.tagName === 'FORM') {
      result.formData = serializeFormData(target);
    }
    return result;
  }

  function serializeFormData(form) {
    var data = {};
    var formData = new FormData(form);
    formData.forEach(function(value, key) {
      if (typeof value === 'string') {
        data[key] = value;
      }
    });
    return data;
  }

  function handleListenCommand(id, selector, events, workerId, options) {
    try {
      var key = selector + '::' + workerId;

      // Remove existing listener for this selector/worker combo
      if (eventListeners[key]) {
        var existing = eventListeners[key];
        existing.events.forEach(function(ev) {
          document.removeEventListener(ev, existing.handler, true);
        });
        delete eventListeners[key];
      }

      var handler = createDebouncedHandler(function(e) {
        if (e.target.matches && (e.target.matches(selector) || e.target.closest(selector))) {
          var targetWorker = resolveTargetWorker(e.target, workerId);
          var eventData = serializeEvent(e, selector);
          relayToWorker(targetWorker, { type: 'dom_event', event: eventData });
        }
      }, (options && options.debounce) || 0);

      events.forEach(function(ev) {
        document.addEventListener(ev, handler, true);  // Capture phase
      });

      eventListeners[key] = {
        selector: selector,
        events: events,
        workerId: workerId,
        handler: handler,
        options: options || {}
      };

      relayToWorker(workerId, { type: 'dom_listen_result', id: id, success: true });
    } catch (err) {
      relayToWorker(workerId, { type: 'dom_listen_result', id: id, success: false, error: err.message });
    }
  }

  function handleUnlistenCommand(id, selector, workerId) {
    try {
      var key = selector + '::' + workerId;
      if (eventListeners[key]) {
        var existing = eventListeners[key];
        existing.events.forEach(function(ev) {
          document.removeEventListener(ev, existing.handler, true);
        });
        delete eventListeners[key];
      }
      relayToWorker(workerId, { type: 'dom_listen_result', id: id, success: true });
    } catch (err) {
      relayToWorker(workerId, { type: 'dom_listen_result', id: id, success: false, error: err.message });
    }
  }

  function handleGetListenersCommand(id, workerId) {
    var listeners = [];
    var keys = Object.keys(eventListeners);
    for (var i = 0; i < keys.length; i++) {
      var entry = eventListeners[keys[i]];
      listeners.push({
        selector: entry.selector,
        events: entry.events,
        workerId: entry.workerId,
        options: entry.options
      });
    }
    relayToWorker(workerId, { type: 'dom_listeners_result', id: id, listeners: listeners });
  }

  function handleWaitForCommand(id, selector, event, timeout, workerId) {
    var handler = function(e) {
      if (e.target.matches && (e.target.matches(selector) || e.target.closest(selector))) {
        document.removeEventListener(event, handler, true);
        if (eventWaiters[id]) {
          clearTimeout(eventWaiters[id].timeoutId);
          delete eventWaiters[id];
        }
        var eventData = serializeEvent(e, selector);
        relayToWorker(workerId, { type: 'dom_wait_result', id: id, event: eventData });
      }
    };

    document.addEventListener(event, handler, true);

    var timeoutMs = timeout || 30000;
    var timeoutId = setTimeout(function() {
      document.removeEventListener(event, handler, true);
      delete eventWaiters[id];
      relayToWorker(workerId, {
        type: 'dom_wait_result',
        id: id,
        error: 'Timeout waiting for ' + event + ' on ' + selector
      });
    }, timeoutMs);

    eventWaiters[id] = {
      selector: selector,
      event: event,
      workerId: workerId,
      handler: handler,
      timeoutId: timeoutId
    };
  }

  /** Collect all registered event listeners as a serializable array. */
  function collectListeners() {
    var listeners = [];
    var keys = Object.keys(eventListeners);
    for (var i = 0; i < keys.length; i++) {
      var entry = eventListeners[keys[i]];
      listeners.push({
        selector: entry.selector,
        events: entry.events,
        workerId: entry.workerId,
        options: entry.options
      });
    }
    return listeners;
  }

  // ============================================================================
  // State Helpers — onChange, escalation, persistence
  // ============================================================================

  function shallowCopy(obj) {
    var copy = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) copy[keys[i]] = obj[keys[i]];
    return copy;
  }

  function fireOnChange(key, newVal, oldVal) {
    var ids = Object.keys(stateChangeHandlers);
    for (var i = 0; i < ids.length; i++) {
      var h = stateChangeHandlers[ids[i]];
      var match = false;
      if (h.keyOrPattern === key) {
        match = true;
      } else if (h.keyOrPattern.charAt(h.keyOrPattern.length - 1) === '*') {
        var prefix = h.keyOrPattern.slice(0, -1);
        if (key.indexOf(prefix) === 0) match = true;
      }
      if (match) {
        try { h.callback(newVal, oldVal, key); } catch (e) { console.warn('[flo.state] onChange error:', e); }
      }
    }
  }

  function checkEscalation(key, value) {
    var rule = stateEscalationRules[key];
    if (!rule) return;
    var shouldEscalate = false;
    if (rule.condition === true) {
      shouldEscalate = true;
    } else {
      try { shouldEscalate = rule.condition(value); } catch (e) { console.warn('[flo.state] escalation condition error:', e); }
    }
    if (shouldEscalate) {
      if (__isOffline()) {
        __floOfflineEscalationsOccurred = true;
        return; // Drop escalation, will notify on reconnect
      }
      var msg = {
        type: 'agent_notify',
        event: 'state_escalation',
        data: { key: key, value: value, message: rule.message || null, snapshot: shallowCopy(stateCache) }
      };
      var wids = Object.keys(workers);
      for (var i = 0; i < wids.length; i++) {
        workers[wids[i]].postMessage(msg);
      }
    }
  }

  function scheduleStatePersist() {
    if (statePersistTimer) clearTimeout(statePersistTimer);
    statePersistTimer = setTimeout(flushState, 500);
  }

  function flushState() {
    statePersistTimer = null;
    var rules = {};
    var rkeys = Object.keys(stateEscalationRules);
    for (var i = 0; i < rkeys.length; i++) {
      var r = stateEscalationRules[rkeys[i]];
      rules[rkeys[i]] = {
        condition: r.condition === true ? 'always' : r.condition.toString(),
        message: r.message || null
      };
    }
    var blob = { state: stateCache, escalationRules: rules };
    var id = generateId('state-persist');
    relayToShell({ type: 'storage_request', id: id, action: 'set', key: '__flo_state', value: JSON.stringify(blob) });
  }

  function handleStateRequest(data, workerId) {
    var result;
    switch (data.action) {
      case 'get':
        result = { result: stateCache[data.key] };
        break;
      case 'get_all':
        result = { result: shallowCopy(stateCache) };
        break;
      case 'set':
        var oldVal = stateCache[data.key];
        stateCache[data.key] = data.value;
        fireOnChange(data.key, data.value, oldVal);
        checkEscalation(data.key, data.value);
        scheduleStatePersist();
        result = { result: 'ok' };
        break;
      case 'delete':
        var oldDelVal = stateCache[data.key];
        delete stateCache[data.key];
        fireOnChange(data.key, undefined, oldDelVal);
        scheduleStatePersist();
        result = { result: 'ok' };
        break;
      case 'escalation_rules':
        var ruleList = [];
        var rkeys = Object.keys(stateEscalationRules);
        for (var i = 0; i < rkeys.length; i++) {
          var r = stateEscalationRules[rkeys[i]];
          ruleList.push({
            key: rkeys[i],
            condition: r.condition === true ? 'always' : r.condition.toString(),
            message: r.message || null
          });
        }
        result = { result: ruleList };
        break;
      case 'escalate':
        stateEscalationRules[data.key] = {
          condition: data.condition === 'always' || data.condition === true ? true : new Function('val', 'return ' + data.condition),
          message: data.message || null
        };
        scheduleStatePersist();
        result = { result: 'ok' };
        break;
      case 'clear_escalation':
        delete stateEscalationRules[data.key];
        scheduleStatePersist();
        result = { result: 'ok' };
        break;
      default:
        result = { error: 'Unknown state action: ' + data.action };
    }
    relayToWorker(workerId, { type: 'state_result', id: data.id, result: result.result, error: result.error });
  }

  // ============================================================================
  // Platform Detection — run once at boot
  // ============================================================================
  var platformInfo = (function() {
    var ua = navigator.userAgent || '';
    var browser = 'Unknown', browserVersion = '', os = 'Unknown', osVersion = '', device = 'desktop';
    var isMobile = false, touchEnabled = false;

    // Browser detection
    if (ua.indexOf('Edg/') !== -1) {
      browser = 'Edge';
      browserVersion = (ua.match(/Edg\\/(\\d[\\d.]*)/  ) || [])[1] || '';
    } else if (ua.indexOf('OPR/') !== -1 || ua.indexOf('Opera') !== -1) {
      browser = 'Opera';
      browserVersion = (ua.match(/OPR\\/(\\d[\\d.]*)/) || ua.match(/Opera\\/(\\d[\\d.]*)/) || [])[1] || '';
    } else if (ua.indexOf('Chrome/') !== -1 && ua.indexOf('Edg/') === -1) {
      browser = 'Chrome';
      browserVersion = (ua.match(/Chrome\\/(\\d[\\d.]*)/) || [])[1] || '';
    } else if (ua.indexOf('Safari/') !== -1 && ua.indexOf('Chrome') === -1) {
      browser = 'Safari';
      browserVersion = (ua.match(/Version\\/(\\d[\\d.]*)/) || [])[1] || '';
    } else if (ua.indexOf('Firefox/') !== -1) {
      browser = 'Firefox';
      browserVersion = (ua.match(/Firefox\\/(\\d[\\d.]*)/) || [])[1] || '';
    }

    // OS detection
    if (ua.indexOf('iPhone') !== -1 || ua.indexOf('iPad') !== -1 || ua.indexOf('iPod') !== -1) {
      os = 'iOS';
      osVersion = (ua.match(/OS (\\d[\\d_]*)/) || [])[1] || '';
      osVersion = osVersion.replace(/_/g, '.');
    } else if (ua.indexOf('Mac OS X') !== -1) {
      os = 'macOS';
      osVersion = (ua.match(/Mac OS X (\\d[\\d_.]*)/) || [])[1] || '';
      osVersion = osVersion.replace(/_/g, '.');
    } else if (ua.indexOf('Android') !== -1) {
      os = 'Android';
      osVersion = (ua.match(/Android (\\d[\\d.]*)/) || [])[1] || '';
    } else if (ua.indexOf('Windows') !== -1) {
      os = 'Windows';
      osVersion = (ua.match(/Windows NT (\\d[\\d.]*)/) || [])[1] || '';
    } else if (ua.indexOf('CrOS') !== -1) {
      os = 'ChromeOS';
    } else if (ua.indexOf('Linux') !== -1) {
      os = 'Linux';
    }

    // Device type
    if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
      device = 'mobile';
      isMobile = true;
    } else if (/iPad|Tablet/i.test(ua) || (ua.indexOf('Macintosh') !== -1 && 'ontouchend' in document)) {
      device = 'tablet';
      isMobile = true;
    }

    touchEnabled = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    return {
      browser: browser,
      browserVersion: browserVersion,
      os: os,
      osVersion: osVersion,
      device: device,
      isMobile: isMobile,
      touchEnabled: touchEnabled,
      devicePixelRatio: window.devicePixelRatio || 1
    };
  })();

  // ============================================================================
  // Viewport & Capabilities Helpers
  // ============================================================================

  function getViewportInfo() {
    var w = window.innerWidth || document.documentElement.clientWidth || 0;
    var h = window.innerHeight || document.documentElement.clientHeight || 0;
    return {
      width: w,
      height: h,
      orientation: w >= h ? 'landscape' : 'portrait',
      viewState: currentViewState
    };
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + 'MB';
    return (bytes / 1073741824).toFixed(1) + 'GB';
  }

  function handleProbe(probe, args) {
    switch (probe) {
      case 'webgl': {
        var canvas = document.createElement('canvas');
        var gl2 = canvas.getContext('webgl2');
        var gl1 = gl2 ? null : canvas.getContext('webgl');
        var gl = gl2 || gl1;
        if (!gl) return { supported: false };
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        return { supported: true, version: gl2 ? 'webgl2' : 'webgl', renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown' };
      }
      case 'webaudio':
        return { supported: typeof AudioContext !== 'undefined' || typeof webkitAudioContext !== 'undefined' };
      case 'webrtc':
        return { supported: typeof RTCPeerConnection !== 'undefined' };
      case 'webgpu':
        return { supported: typeof navigator.gpu !== 'undefined' };
      case 'wasm':
        return { supported: typeof WebAssembly !== 'undefined' };
      case 'offscreencanvas':
        return { supported: typeof OffscreenCanvas !== 'undefined' };
      case 'sharedarraybuffer': {
        var sabSupported = typeof SharedArrayBuffer !== 'undefined';
        return { supported: sabSupported, reason: sabSupported ? null : 'Requires cross-origin isolation headers' };
      }
      case 'storage':
        if (navigator.storage && navigator.storage.estimate) {
          return navigator.storage.estimate().then(function(est) {
            var remaining = (est.quota || 0) - (est.usage || 0);
            return { supported: true, usage: est.usage || 0, quota: est.quota || 0, remaining: formatBytes(remaining) };
          });
        }
        return { supported: false, reason: 'StorageManager API not available' };
      case 'network':
        return null;  // Handled by shell
      case 'tool':
        return null;  // Handled by shell
      default:
        return { supported: false, reason: 'Unknown probe: ' + probe };
    }
  }

  function handleCapabilitiesRequest(msg, workerId) {
    if (msg.action === 'probe') {
      var probe = msg.probe;

      // network and tool probes need shell data — forward to shell
      if (probe === 'network' || probe === 'tool') {
        trackAndRelay({ type: 'capabilities_request', id: msg.id, iframeData: { probe: probe, probeArgs: msg.probeArgs || {} } }, workerId);
        return;
      }

      var probeResult = handleProbe(probe, msg.probeArgs || {});

      // Handle async probes (e.g., storage which returns a Promise)
      if (probeResult && typeof probeResult.then === 'function') {
        probeResult.then(function(result) {
          relayToWorker(workerId, { type: 'capabilities_result', id: msg.id, result: result });
        }).catch(function(err) {
          relayToWorker(workerId, { type: 'capabilities_result', id: msg.id, error: err.message || String(err) });
        });
        return;
      }

      relayToWorker(workerId, { type: 'capabilities_result', id: msg.id, result: probeResult });
      return;
    }

    // Snapshot: collect iframe data, forward to shell for merging
    var iframeData = {
      platform: platformInfo,
      viewport: getViewportInfo()
    };
    trackAndRelay({ type: 'capabilities_request', id: msg.id, iframeData: iframeData }, workerId);
  }

  // ============================================================================
  // Viewport Resize Broadcasting
  // ============================================================================
  var resizeTimer = null;
  function broadcastViewportUpdate() {
    var vp = getViewportInfo();
    var wids = Object.keys(workers);
    for (var i = 0; i < wids.length; i++) {
      workers[wids[i]].postMessage({ type: 'viewport_update', viewport: vp });
    }
  }
  window.addEventListener('resize', function() {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(broadcastViewportUpdate, 250);
  });
  if (window.screen && window.screen.orientation) {
    window.screen.orientation.addEventListener('change', function() {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(broadcastViewportUpdate, 250);
    });
  }

  // ============================================================================
  // Offline Detection — helpers for graceful degradation when network is down
  // ============================================================================

  /** Check if currently offline (network-level or hub-unreachable) */
  function __isOffline() {
    return !navigator.onLine;
  }

  /** Show a brief offline toast inside the iframe */
  function __showOfflineToast(msg) {
    var existing = document.getElementById('__flo-offline-toast');
    if (existing) existing.remove();
    var toast = document.createElement('div');
    toast.id = '__flo-offline-toast';
    toast.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);' +
      'background:#BD0F40;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;' +
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif;z-index:99999;' +
      'opacity:1;transition:opacity 0.3s;pointer-events:none;';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = '0';
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  var __floOfflineEscalationsOccurred = false;

  window.addEventListener('online', function() {
    if (__floOfflineEscalationsOccurred) {
      __floOfflineEscalationsOccurred = false;
      broadcastToWorkers({
        type: 'offline_escalations_pending',
        state: JSON.parse(JSON.stringify(stateCache))
      });
    }
  });

  // ============================================================================
  // flo API — global object for agent-injected JS (srcdoc scripts)
  // ============================================================================
  window.flo = {
    // Internal flag to prevent re-initialization
    _initialized: true,

    // Fire-and-forget notification to agent
    notify: function(event, data, targetWorkerId) {
      if (__isOffline()) {
        __showOfflineToast('Offline \\u2014 agent unavailable');
        return;
      }
      var target = targetWorkerId || 'main';
      if (!workers[target]) {
        console.warn('flo.notify: unknown worker', target);
        return;
      }
      workers[target].postMessage({
        type: 'agent_notify',
        event: event,
        data: data,
        viewState: currentViewState
      });
    },

    // Request-response (returns Promise)
    ask: function(event, data, targetWorkerId) {
      if (__isOffline()) {
        __showOfflineToast('Offline \\u2014 agent unavailable');
        return Promise.reject(new Error('Offline \\u2014 agent unavailable'));
      }
      var target = targetWorkerId || 'main';
      if (!workers[target]) {
        return Promise.reject(new Error('Unknown worker: ' + target));
      }

      var id = generateId('ask');

      return new Promise(function(resolve, reject) {
        registerPendingRequest(pendingAsks, id, resolve, reject, 30000, 'Timeout waiting for agent response');

        workers[target].postMessage({
          type: 'agent_ask',
          id: id,
          event: event,
          data: data,
          viewState: currentViewState
        });
      });
    },

    // Send a notification to the user (shown in shell notification panel)
    notify_user: function(message) {
      relayToShell({ type: 'notify_user', message: String(message || '') });
    },

    // Convenience: emit a custom event that triggers listeners
    emit: function(eventType, detail) {
      document.dispatchEvent(new CustomEvent(eventType, { detail: detail, bubbles: true }));
    },

    // Request a view state change (min, max, ui-only, chat-only)
    // Shell may approve or reject the request
    requestViewState: function(state) {
      relayToShell({
        type: 'request_view_state',
        state: state
      });
    },

    // Request a browser permission (camera, microphone, geolocation)
    // Shell mediates the browser permission prompt since iframe is sandboxed
    requestPermission: function(permission) {
      var validPermissions = ['camera', 'microphone', 'geolocation'];
      if (validPermissions.indexOf(permission) === -1) {
        return Promise.reject(new Error('Invalid permission: ' + permission + '. Must be one of: ' + validPermissions.join(', ')));
      }

      var id = generateId('perm');

      return new Promise(function(resolve, reject) {
        registerPendingRequest(pendingPermissions, id, resolve, reject, 60000, 'Permission request timed out: ' + permission);

        relayToShell({
          type: 'permission_request',
          id: id,
          permission: permission
        });
      });
    },

    // Call a tool and get result (returns Promise)
    // Security tiers are enforced shell-side
    // options: { timeout: number } — default 30000ms, use 300000 for subagents
    callTool: function(name, input, options) {
      // Allow local tools when offline; block network-dependent tools
      var localTools = ['storage', 'dom', 'runjs', 'state'];
      if (__isOffline() && localTools.indexOf(name) === -1) {
        __showOfflineToast('Offline \\u2014 tool unavailable');
        return Promise.reject(new Error('Offline \\u2014 tool unavailable'));
      }
      var id = generateId('srcdoc-tool');
      var timeoutMs = (options && options.timeout) || 30000;

      return new Promise(function(resolve, reject) {
        registerPendingRequest(pendingSrcdocTools, id, resolve, reject, timeoutMs, 'Tool call timed out: ' + name);

        relayToShell({
          type: 'srcdoc_tool_call',
          id: id,
          name: name,
          input: input || {}
        });
      });
    },

    // Camera/microphone via WebRTC proxy — shell captures media and forwards via RTCPeerConnection
    getCamera: function() {
      return window.flo.getMediaStream({ video: true, audio: false });
    },

    getMicrophone: function() {
      return window.flo.getMediaStream({ video: false, audio: true });
    },

    getMediaStream: function(constraints) {
      var id = generateId('media');
      return new Promise(function(resolve, reject) {
        registerPendingRequest(pendingMediaRequests, id, resolve, reject, 60000, 'Media request timed out');
        relayToShell({
          type: 'media_request',
          id: id,
          constraints: constraints || { video: true, audio: false }
        });
      });
    },

    // Stop a media stream obtained via getCamera/getMicrophone/getMediaStream
    // This signals the shell to stop the source tracks and close the RTCPeerConnection
    stopMediaStream: function(stream) {
      // Stop all tracks locally
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(function(t) { t.stop(); });
      }
      // Find and close the associated peer connection
      var ids = Object.keys(mediaConnections);
      for (var i = 0; i < ids.length; i++) {
        var mc = mediaConnections[ids[i]];
        if (mc && mc.stream === stream) {
          mc.pc.close();
          delete mediaConnections[ids[i]];
          relayToShell({ type: 'media_stop', id: ids[i] });
          break;
        }
      }
    },

    // Reactive state API
    state: {
      get: function(key) {
        return stateCache[key];
      },
      set: function(key, value) {
        var oldVal = stateCache[key];
        stateCache[key] = value;
        fireOnChange(key, value, oldVal);
        checkEscalation(key, value);
        scheduleStatePersist();
      },
      getAll: function() {
        return shallowCopy(stateCache);
      },
      onChange: function(keyOrPattern, callback) {
        var hid = 'h' + (++nextHandlerId);
        stateChangeHandlers[hid] = { keyOrPattern: keyOrPattern, callback: callback };
        return function() { delete stateChangeHandlers[hid]; };
      },
      escalate: function(key, conditionOrTrue, message) {
        if (__isOffline()) {
          __floOfflineEscalationsOccurred = true;
          __showOfflineToast('Offline \\u2014 escalation dropped');
          return;
        }
        if (conditionOrTrue === true || conditionOrTrue === 'always') {
          stateEscalationRules[key] = { condition: true, message: message || null };
        } else if (typeof conditionOrTrue === 'function') {
          stateEscalationRules[key] = { condition: conditionOrTrue, message: message || null };
        } else if (typeof conditionOrTrue === 'string') {
          stateEscalationRules[key] = { condition: new Function('val', 'return ' + conditionOrTrue), message: message || null };
        }
        scheduleStatePersist();
      },
      clearEscalation: function(key) {
        delete stateEscalationRules[key];
        scheduleStatePersist();
      }
    },

    // Speech API — STT and TTS proxied through shell
    speech: {
      listen: function(opts) {
        var id = generateId('speech');
        var session = {
          _id: id,
          _finalText: '',
          _confidence: 0,
          _donePromise: null,
          _doneResolve: null,
          _doneReject: null,
          done: function() {
            if (!session._donePromise) {
              session._donePromise = new Promise(function(resolve, reject) {
                session._doneResolve = resolve;
                session._doneReject = reject;
              });
              relayToShell({ type: 'speech_listen_done', id: id });
            }
            return session._donePromise;
          },
          cancel: function() {
            relayToShell({ type: 'speech_listen_cancel', id: id });
          }
        };
        pendingSpeechSessions[id] = {
          session: session,
          oninterim: (opts && opts.oninterim) || null
        };
        relayToShell({ type: 'speech_listen_start', id: id, lang: (opts && opts.lang) || undefined });
        return session;
      },
      speak: function(text, opts) {
        var id = generateId('speech');
        return new Promise(function(resolve, reject) {
          registerPendingRequest(pendingSpeechRequests, id, resolve, reject, 60000, 'Speech synthesis timed out');
          relayToShell({
            type: 'speech_speak',
            id: id,
            text: text,
            voice: (opts && opts.voice) || undefined,
            lang: (opts && opts.lang) || undefined
          });
        });
      },
      voices: function() {
        var id = generateId('speech');
        return new Promise(function(resolve, reject) {
          registerPendingRequest(pendingSpeechRequests, id, resolve, reject, 10000, 'Voice list request timed out');
          relayToShell({ type: 'speech_voices', id: id });
        });
      }
    },

    // Geolocation API — proxied through shell (navigator.geolocation is blocked in sandboxed iframes)
    geolocation: {
      getCurrentPosition: function(options) {
        var id = generateId('geo');
        return new Promise(function(resolve, reject) {
          registerPendingRequest(pendingGeoRequests, id, resolve, reject, 30000, 'Geolocation request timed out');
          var msg = { type: 'geolocation_get', id: id };
          if (options) {
            if (options.enableHighAccuracy !== undefined) msg.enableHighAccuracy = options.enableHighAccuracy;
            if (options.timeout !== undefined) msg.timeout = options.timeout;
            if (options.maximumAge !== undefined) msg.maximumAge = options.maximumAge;
          }
          relayToShell(msg);
        });
      },
      watchPosition: function(onposition, onerror, options) {
        var id = generateId('geo');
        activeGeoWatches[id] = { onposition: onposition, onerror: onerror || null };
        var msg = { type: 'geolocation_watch_start', id: id };
        if (options) {
          if (options.enableHighAccuracy !== undefined) msg.enableHighAccuracy = options.enableHighAccuracy;
          if (options.timeout !== undefined) msg.timeout = options.timeout;
          if (options.maximumAge !== undefined) msg.maximumAge = options.maximumAge;
        }
        relayToShell(msg);
        return {
          _id: id,
          stop: function() {
            delete activeGeoWatches[id];
            relayToShell({ type: 'geolocation_watch_stop', id: id });
          }
        };
      }
    }
  };

  // ============================================================================
  // Global Error Handler — batch errors and report to agent
  // ============================================================================
  var errorBatch = [];
  var errorBatchTimer = null;
  var ERROR_BATCH_WINDOW = 1500;   // 1.5s after first error in batch
  var ERROR_BATCH_MAX = 10;        // Max unique errors per batch

  function reportError(errorInfo) {
    // Deduplicate by message
    for (var i = 0; i < errorBatch.length; i++) {
      if (errorBatch[i].message === errorInfo.message) {
        errorBatch[i].count = (errorBatch[i].count || 1) + 1;
        return;
      }
    }
    if (errorBatch.length >= ERROR_BATCH_MAX) return;  // Cap unique errors
    errorInfo.count = 1;
    errorBatch.push(errorInfo);

    // Start timer on first error
    if (!errorBatchTimer) {
      errorBatchTimer = setTimeout(flushErrorBatch, ERROR_BATCH_WINDOW);
    }
  }

  function flushErrorBatch() {
    errorBatchTimer = null;
    if (errorBatch.length === 0) return;
    var batch = errorBatch;
    errorBatch = [];
    relayToShell({ type: 'runtime_error', errors: batch });
  }

  // Intercept console.error
  var _origConsoleError = console.error;
  var _inErrorHandler = false;
  console.error = function() {
    _origConsoleError.apply(console, arguments);
    if (_inErrorHandler) return;
    _inErrorHandler = true;
    try {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        try {
          parts.push(arguments[i] instanceof Error ? arguments[i].message : typeof arguments[i] === 'string' ? arguments[i] : JSON.stringify(arguments[i]));
        } catch (e) {
          parts.push(String(arguments[i]));
        }
      }
      reportError({ message: parts.join(' '), category: 'console' });
    } finally {
      _inErrorHandler = false;
    }
  };

  // Capture resource load failures (img, script, link, video, audio, source)
  window.addEventListener('error', function(e) {
    if (e.target && e.target !== window) {
      var tag = e.target.tagName;
      if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'LINK' || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'SOURCE') {
        reportError({
          message: 'Failed to load ' + tag.toLowerCase() + ': ' + (e.target.src || e.target.href || 'unknown'),
          category: 'resource',
          source: e.target.src || e.target.href || 'unknown'
        });
      }
    }
  }, true);

  window.onerror = function(message, source, lineno, colno, error) {
    reportError({
      message: String(message),
      source: source || 'unknown',
      line: lineno,
      column: colno,
      stack: error && error.stack ? error.stack : null,
      category: 'error'
    });
    // Don't suppress the error from console
    return false;
  };

  window.onunhandledrejection = function(event) {
    var reason = event.reason;
    reportError({
      message: reason instanceof Error ? reason.message : String(reason),
      source: 'unhandled promise rejection',
      stack: reason instanceof Error ? reason.stack : null,
      category: 'promise'
    });
  };

  // Flush error batch on visibilitychange (catch errors before page teardown)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden' && errorBatch.length > 0) {
      if (errorBatchTimer) {
        clearTimeout(errorBatchTimer);
      }
      flushErrorBatch();
    }
  });

  // ============================================================================
  // Worker Management — creation, teardown, inter-worker messaging
  // ============================================================================
  function handleWorkerMessage(workerId, msg) {
    if (msg.target === 'broadcast') {
      var wids = Object.keys(workers);
      for (var i = 0; i < wids.length; i++) {
        if (wids[i] !== workerId) {  // Don't send to self
          workers[wids[i]].postMessage({
            type: 'worker_event',
            from: workerId,
            event: msg.event,
            data: msg.data
          });
        }
      }
    } else if (workers[msg.target]) {
      workers[msg.target].postMessage({
        type: 'worker_event',
        from: workerId,
        event: msg.event,
        data: msg.data
      });
    }
  }

  function createWorkerFromCode(workerId, workerCode, config) {
    var blob = new Blob([workerCode], { type: 'application/javascript' });
    var url = URL.createObjectURL(blob);
    workers[workerId] = new Worker(url);
    URL.revokeObjectURL(url);
    setupWorkerHandler(workerId, workers[workerId]);
    workers[workerId].postMessage({ type: 'start', config: config, userMessage: '' });
  }

  // ============================================================================
  // Notify shell we're ready
  // ============================================================================
  relayToShell({ type: 'ready' });

  // ============================================================================
  // Worker-to-Shell Message Handler
  // ============================================================================
  function setupWorkerHandler(workerId, worker) {
    worker.addEventListener('message', function(we) {
      var msg = we.data;
      if (!msg) return;

      if (msg.type === 'event') {
        // Include workerId so shell can route events
        relayToShell({ type: 'event', workerId: workerId, event: msg.event });
      } else if (msg.type === 'api_request') {
        trackAndRelay({ type: 'api_request', id: msg.id, payload: msg.payload, endpoint: msg.endpoint }, workerId);
      } else if (msg.type === 'storage_request') {
        trackAndRelay({ type: 'storage_request', id: msg.id, action: msg.action, key: msg.key, value: msg.value }, workerId);
      } else if (msg.type === 'file_request') {
        trackAndRelay({ type: 'file_request', id: msg.id, action: msg.action, path: msg.path, content: msg.content }, workerId);
      } else if (msg.type === 'fetch_request') {
        trackAndRelay({ type: 'fetch_request', id: msg.id, url: msg.url, options: msg.options }, workerId);
      } else if (msg.type === 'dom_command') {
        // Handle DOM locally - affects shared DOM!
        handleDomCommand(msg.id, msg.command, workerId);
      } else if (msg.type === 'dom_listen') {
        handleListenCommand(msg.id, msg.selector, msg.events, workerId, msg.options);
      } else if (msg.type === 'dom_unlisten') {
        handleUnlistenCommand(msg.id, msg.selector, workerId);
      } else if (msg.type === 'dom_wait') {
        handleWaitForCommand(msg.id, msg.selector, msg.event, msg.timeout, workerId);
      } else if (msg.type === 'dom_get_listeners') {
        handleGetListenersCommand(msg.id, workerId);
      } else if (msg.type === 'runjs_iframe') {
        // Handle JS locally
        handleRunJsIframe(msg.id, msg.code, workerId);
      } else if (msg.type === 'tool_execute') {
        trackAndRelay({ type: 'tool_execute', id: msg.id, name: msg.name, input: msg.input }, workerId);
      } else if (msg.type === 'pre_tool_use' || msg.type === 'post_tool_use' || msg.type === 'stop' || msg.type === 'user_prompt_submit' || msg.type === 'agent_start' || msg.type === 'agent_end') {
        requestSources[msg.id] = workerId;
        var hookMsg = {};
        var hookKeys = Object.keys(msg);
        for (var hi = 0; hi < hookKeys.length; hi++) {
          hookMsg[hookKeys[hi]] = msg[hookKeys[hi]];
        }
        if (msg.type === 'stop') {
          hookMsg.type = 'agent_stop';
        }
        hookMsg.agentId = agentId;
        hookMsg.workerId = workerId;
        parent.postMessage(hookMsg, '*');
      } else if (msg.type === 'agent_ask_response') {
        // Response from agent for flo.ask()
        resolvePendingRequest(pendingAsks, msg.id, msg.result, msg.error);
      } else if (msg.type === 'worker_message') {
        // Inter-worker messaging
        handleWorkerMessage(workerId, msg);
      } else if (msg.type === 'capabilities_request') {
        handleCapabilitiesRequest(msg, workerId);
      } else if (msg.type === 'state_request') {
        // Check if state is loaded; if not, queue the request
        if (!stateLoaded) {
          stateLoadQueue.push({ data: msg, workerId: workerId });
        } else {
          handleStateRequest(msg, workerId);
        }
      } else if (msg.type === 'shell_tool_response') {
        // Forward response from worker back to shell
        relayToShell({
          type: 'shell_tool_response',
          id: msg.id,
          result: msg.result,
          error: msg.error
        });
      } else if (msg.type === 'shell_script_response') {
        // Forward response from worker back to shell
        relayToShell({
          type: 'shell_script_response',
          id: msg.id,
          result: msg.result,
          error: msg.error
        });
      } else if (msg.type === 'hub_page_event') {
        // Forward hub page event from worker to shell (for hub routing)
        relayToShell({ type: 'hub_page_event', content: msg.content });
      } else if (msg.type === 'view_state_request') {
        // Forward view state request to shell
        trackAndRelay({ type: 'view_state_request', id: msg.id, state: msg.state }, workerId);
      }
    });
  }

  // ============================================================================
  // Shell-to-Iframe Message Handler (window.onmessage)
  // ============================================================================
  window.addEventListener('message', function(e) {
    var data = e.data;
    if (!data) return;

    switch (data.type) {
      case 'init':
        if (workers['main']) return;
        // Load persisted state before creating worker
        stateLoadPendingId = generateId('state-load');
        relayToShell({ type: 'storage_request', id: stateLoadPendingId, action: 'get', key: '__flo_state' });
        createWorkerFromCode('main', data.workerCode, data.config);
        break;

      case 'spawn_subworker':
        // data: { subworkerId, workerCode, config }
        if (workers[data.subworkerId]) return;  // already exists
        createWorkerFromCode(data.subworkerId, data.workerCode, data.config);
        break;

      case 'kill_subworker':
        // data: { subworkerId }
        var sw = workers[data.subworkerId];
        if (sw) {
          sw.terminate();
          delete workers[data.subworkerId];
        }
        break;

      case 'subworker_message':
        // data: { subworkerId, message }
        relayToWorker(data.subworkerId, data.message);
        break;

      case 'user_message':
        // Route to specific worker if workerId provided, else main
        relayToWorker(data.workerId || 'main', { type: 'user_message', content: data.content });
        break;

      case 'pause':
      case 'resume':
      case 'stop_agent':
      case 'config_update':
        var ctrlWorker = workers[data.workerId || 'main'];
        if (ctrlWorker) ctrlWorker.postMessage(data);
        break;

      // Intercept storage_result for state loading before relaying
      case 'storage_result':
        if (data.id === stateLoadPendingId) {
          stateLoadPendingId = null;
          stateLoaded = true;
          if (data.result) {
            try {
              var parsed = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
              if (parsed && parsed.state) {
                stateCache = parsed.state;
              }
              if (parsed && parsed.escalationRules) {
                var rkeys = Object.keys(parsed.escalationRules);
                for (var ri = 0; ri < rkeys.length; ri++) {
                  var rr = parsed.escalationRules[rkeys[ri]];
                  stateEscalationRules[rkeys[ri]] = {
                    condition: rr.condition === 'always' ? true : new Function('val', 'return ' + rr.condition),
                    message: rr.message || null
                  };
                }
              }
            } catch (e) {
              console.warn('[flo.state] Failed to parse persisted state:', e);
            }
          }
          for (var qi = 0; qi < stateLoadQueue.length; qi++) {
            handleStateRequest(stateLoadQueue[qi].data, stateLoadQueue[qi].workerId);
          }
          stateLoadQueue = [];
          break;
        }
        // Fall through for normal storage results

      // Relay shell responses to correct worker using requestSources
      case 'api_response_chunk':
      case 'api_response_end':
      case 'api_response_error':
      case 'file_result':
      case 'fetch_response':
      case 'fetch_error':
      case 'tool_execute_result':
      case 'pre_tool_use_result':
      case 'post_tool_use_result':
      case 'agent_stop_result':
      case 'user_prompt_submit_result':
      case 'agent_start_result':
      case 'agent_end_result':
      case 'capabilities_result':
      case 'view_state_response':
        var targetWorkerId = requestSources[data.id] || 'main';
        var respWorker = workers[targetWorkerId];
        if (respWorker) respWorker.postMessage(data);
        // Clean up requestSources on terminal responses
        if (data.type === 'api_response_end' || data.type === 'api_response_error' ||
            data.type.endsWith('_result') || data.type === 'fetch_response' || data.type === 'fetch_error' ||
            data.type === 'view_state_response') {
          delete requestSources[data.id];
        }
        break;

      case 'hooks_config':
      case 'visibility_change':
      case 'set_mobile':
      case 'set_hub_mode':
        broadcastToWorkers(data);
        break;

      case 'set_view_state':
        currentViewState = data.state;
        broadcastToWorkers(data);
        break;

      case 'shell_tool_request':
        // Shell is requesting a tool execution via hook script
        // Forward to main worker and return result
        var mainWorker = workers['main'];
        if (mainWorker) {
          mainWorker.postMessage({
            type: 'shell_tool_request',
            id: data.id,
            name: data.name,
            input: data.input
          });
        } else {
          // No worker available, send error back
          relayToShell({
            type: 'shell_tool_response',
            id: data.id,
            error: 'No worker available'
          });
        }
        break;

      case 'shell_script_request':
        // Shell is requesting script execution in the sandboxed agent context
        var scriptWorker = workers['main'];
        if (scriptWorker) {
          scriptWorker.postMessage({
            type: 'shell_script_request',
            id: data.id,
            code: data.code,
            context: data.context
          });
        } else {
          relayToShell({
            type: 'shell_script_response',
            id: data.id,
            error: 'No worker available'
          });
        }
        break;

      case 'capture_dom_state':
        handleCaptureDomState(data.id);
        break;

      case 'restore_dom_state':
        handleRestoreDomState(data);
        break;

      case 'restoration_context':
        // Forward restoration context to all workers so agent knows if DOM was restored
        broadcastToWorkers({
          type: 'restoration_context',
          domRestored: data.domRestored
        });
        break;

      case 'runtime_error':
        // Forward runtime errors to main worker (batch format)
        relayToWorker('main', {
          type: 'runtime_error',
          errors: data.errors || (data.error ? [data.error] : [])
        });
        break;

      case 'srcdoc_tool_call_result':
        if (pendingSrcdocTools[data.id]) {
          // Parse JSON results so callers get native objects/arrays
          var parsed = data.result;
          if (!data.error && typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (e) { /* keep as string */ }
          }
          resolvePendingRequest(pendingSrcdocTools, data.id, parsed, data.error);
        }
        break;

      case 'permission_result':
        resolvePendingRequest(pendingPermissions, data.id, data.granted, data.error);
        break;

      case 'media_offer':
        handleMediaOffer(data);
        break;

      case 'media_ice':
        // ICE candidate from shell for an active media connection
        if (data.id) {
          var mc = mediaConnections[data.id];
          if (mc && mc.pc && data.candidate) {
            mc.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate))).catch(function() {});
          }
        }
        break;

      case 'speech_interim': {
        var si = pendingSpeechSessions[data.id];
        if (si && si.oninterim) {
          try { si.oninterim(data.text); } catch (e) { console.warn('[flo.speech] oninterim error:', e); }
        }
        break;
      }

      case 'speech_result': {
        var sr = pendingSpeechSessions[data.id];
        if (sr) {
          delete pendingSpeechSessions[data.id];
          if (sr.session._doneResolve) {
            sr.session._doneResolve({ text: data.text, confidence: data.confidence });
          }
        }
        break;
      }

      case 'speech_cancelled': {
        var sc = pendingSpeechSessions[data.id];
        if (sc) {
          delete pendingSpeechSessions[data.id];
          if (sc.session._doneResolve) {
            sc.session._doneResolve(null);
          }
        }
        break;
      }

      case 'speech_error': {
        var se = pendingSpeechSessions[data.id];
        if (se) {
          delete pendingSpeechSessions[data.id];
          if (se.session._doneReject) {
            se.session._doneReject(new Error(data.error));
          }
        }
        // Also check pending speak/voices requests
        resolvePendingRequest(pendingSpeechRequests, data.id, null, data.error);
        break;
      }

      case 'speech_speak_done':
        resolvePendingRequest(pendingSpeechRequests, data.id, undefined, null);
        break;

      case 'speech_voices_result':
        resolvePendingRequest(pendingSpeechRequests, data.id, data.voices, null);
        break;

      case 'geolocation_position': {
        // Could be a one-shot get response OR a watch update
        if (pendingGeoRequests[data.id]) {
          var geoCoords = data.coords || {};
          geoCoords.timestamp = data.timestamp;
          resolvePendingRequest(pendingGeoRequests, data.id, geoCoords, null);
        } else if (activeGeoWatches[data.id]) {
          var watchCoords = data.coords || {};
          watchCoords.timestamp = data.timestamp;
          try { activeGeoWatches[data.id].onposition(watchCoords); } catch (e) { console.warn('[flo.geolocation] onposition error:', e); }
        }
        break;
      }

      case 'geolocation_error': {
        if (pendingGeoRequests[data.id]) {
          resolvePendingRequest(pendingGeoRequests, data.id, null, data.error || 'Geolocation error');
        } else if (activeGeoWatches[data.id]) {
          var watchEntry = activeGeoWatches[data.id];
          if (watchEntry.onerror) {
            try { watchEntry.onerror({ message: data.error || 'Geolocation error', code: data.code }); } catch (e) { console.warn('[flo.geolocation] onerror error:', e); }
          }
        }
        break;
      }

      case 'geolocation_watch_stopped':
        delete activeGeoWatches[data.id];
        break;

      case 'media_error':
        resolvePendingRequest(pendingMediaRequests, data.id, null, data.error);
        break;
    }
  });

  // Flush state on visibility change (mobile Safari may not complete IDB writes)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden' && statePersistTimer) {
      clearTimeout(statePersistTimer);
      flushState();
    }
  });

  // ============================================================================
  // WebRTC Media Proxy — handle offers/ICE from shell
  // ============================================================================

  function handleMediaOffer(data) {
    var id = data.id;
    var pending = pendingMediaRequests[id];
    if (!pending) return;

    try {
      var pc = new RTCPeerConnection();
      var expectedTracks = data.expectedTracks || 1;
      var receivedTracks = 0;
      var resolvedStream = null;

      // Store PC immediately so ICE candidates can be added before ontrack fires
      mediaConnections[id] = { pc: pc, stream: null };

      pc.ontrack = function(ev) {
        receivedTracks++;
        if (!resolvedStream && ev.streams && ev.streams[0]) {
          resolvedStream = ev.streams[0];
        }
        if (receivedTracks >= expectedTracks && resolvedStream) {
          mediaConnections[id].stream = resolvedStream;
          resolvePendingRequest(pendingMediaRequests, id, resolvedStream, null);
        }
      };

      pc.onicecandidate = function(ev) {
        if (ev.candidate) {
          relayToShell({
            type: 'media_ice',
            id: id,
            candidate: JSON.stringify(ev.candidate)
          });
        }
      };

      pc.setRemoteDescription(new RTCSessionDescription(data.offer))
        .then(function() { return pc.createAnswer(); })
        .then(function(answer) {
          return pc.setLocalDescription(answer).then(function() { return answer; });
        })
        .then(function(answer) {
          relayToShell({
            type: 'media_answer',
            id: id,
            answer: { type: answer.type, sdp: answer.sdp }
          });
        })
        .catch(function(err) {
          resolvePendingRequest(pendingMediaRequests, id, null, 'WebRTC handshake failed: ' + err.message);
        });
    } catch (err) {
      resolvePendingRequest(pendingMediaRequests, id, null, 'RTCPeerConnection failed: ' + err.message);
    }
  }

  // ============================================================================
  // DOM Operations — script activation, placeholder, DOM commands, runjs, state
  // ============================================================================

  // Activate script tags after innerHTML/insertAdjacentHTML (they don't execute by default)
  // Returns array of error messages (empty if all scripts executed successfully)
  // Skips the bootstrap script (data-flo-bootstrap) to prevent re-initializing state
  function activateScripts(container) {
    var errors = [];
    // Handle the case where the container itself is a script element
    if (container.tagName === 'SCRIPT') {
      // Never re-activate the bootstrap script
      if (container.hasAttribute('data-flo-bootstrap')) return errors;
      var newScript = document.createElement('script');
      Array.from(container.attributes).forEach(function(attr) {
        newScript.setAttribute(attr.name, attr.value);
      });
      newScript.textContent = container.textContent;
      try {
        container.parentNode.replaceChild(newScript, container);
      } catch (e) {
        console.warn('[flo] Script activation error:', e.message);
        errors.push(e.message);
        container.remove();
      }
      return errors;
    }
    var scripts = container.querySelectorAll('script');
    scripts.forEach(function(oldScript) {
      // Skip the bootstrap script - re-running it would overwrite window.flo
      // with a new object that has an empty workers map
      if (oldScript.hasAttribute('data-flo-bootstrap')) return;
      var newScript = document.createElement('script');
      // Copy attributes
      Array.from(oldScript.attributes).forEach(function(attr) {
        newScript.setAttribute(attr.name, attr.value);
      });
      // Copy content
      newScript.textContent = oldScript.textContent;
      try {
        oldScript.parentNode.replaceChild(newScript, oldScript);
      } catch (e) {
        // Script execution errors (e.g., const redeclaration) are caught here
        console.warn('[flo] Script activation error:', e.message);
        errors.push(e.message);
        oldScript.remove();
      }
    });
    return errors;
  }

  var placeholderRemoved = false;
  function removePlaceholder() {
    if (placeholderRemoved) return;
    placeholderRemoved = true;
    var ph = document.querySelector('.agent-placeholder');
    if (ph) ph.remove();
  }

  function getRenderedInfo(el) {
    if (!el || !el.getBoundingClientRect) return null;
    var rect = el.getBoundingClientRect();
    var cs = window.getComputedStyle(el);
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0',
      display: cs.display,
      childCount: el.children ? el.children.length : 0
    };
  }

  function handleDomCommand(id, command, workerId) {
    try {
      console.log('[flo:dom] handleDomCommand:', command.action, 'id:', id, 'html length:', command.html ? command.html.length : 0);
      // Remove placeholder on first mutating DOM command
      var mutating = command.action !== 'query' && command.action !== 'query_all';
      if (mutating) removePlaceholder();

      // Fall back to document.body if no viewport exists (agents have full DOM control)
      var viewport = document.getElementById('agent-viewport') || document.body;
      var result = { description: '', elementCount: 0 };

      switch (command.action) {
        case 'create':
          if (command.html) {
            var container = command.parentSelector ? document.querySelector(command.parentSelector) : viewport;
            if (!container) container = document.body;
            console.log('[flo:dom] insertAdjacentHTML start');
            container.insertAdjacentHTML('beforeend', command.html);
            console.log('[flo:dom] insertAdjacentHTML done, activating scripts...');
            var scriptErrors = activateScripts(container);
            console.log('[flo:dom] activateScripts done, errors:', scriptErrors.length);
            result.description = 'Element created';
            if (scriptErrors.length > 0) {
              result.description += '. Script errors: ' + scriptErrors.join('; ');
            }
            result.elementCount = container.children.length;
            result.rendered = getRenderedInfo(container.lastElementChild);
          }
          break;
        case 'query':
          if (command.selector) {
            var el = document.querySelector(command.selector);
            result.description = el ? el.outerHTML.substring(0, 500) : 'Not found';
            result.elementCount = document.querySelectorAll(command.selector).length;
            if (el) result.rendered = getRenderedInfo(el);
          }
          break;
        case 'modify':
          if (command.selector) {
            var el = document.querySelector(command.selector);
            if (el) {
              var changes = [];
              if (command.attributes) {
                Object.keys(command.attributes).forEach(function(k) {
                  el.setAttribute(k, command.attributes[k]);
                });
                changes.push('attributes');
              }
              if (command.textContent !== undefined) {
                el.textContent = command.textContent;
                changes.push('textContent');
              }
              var scriptErrors = [];
              if (command.innerHTML !== undefined) {
                el.innerHTML = command.innerHTML;
                scriptErrors = activateScripts(el);
                changes.push('innerHTML');
              }
              result.description = changes.length > 0
                ? 'Modified ' + changes.join(', ')
                : 'Element found but no changes specified';
              if (scriptErrors.length > 0) {
                result.description += '. Script errors: ' + scriptErrors.join('; ');
              }
              result.elementCount = 1;
              result.rendered = getRenderedInfo(el);
            } else {
              result.description = 'Element not found';
            }
          }
          break;
        case 'remove':
          if (command.selector) {
            var els = document.querySelectorAll(command.selector);
            els.forEach(function(el) { el.remove(); });
            result.description = 'Removed ' + els.length + ' element(s)';
            result.elementCount = els.length;
          }
          break;
        case 'listen':
          handleListenCommand(id, command.selector, command.events || [], workerId, command.options);
          return;  // Handler sends result
        case 'unlisten':
          handleUnlistenCommand(id, command.selector, workerId);
          return;  // Handler sends result
        case 'wait_for':
          handleWaitForCommand(id, command.selector, command.event, command.timeout, workerId);
          return;  // Handler sends result
        case 'get_listeners':
          handleGetListenersCommand(id, workerId);
          return;  // Handler sends result
      }

      console.log('[flo:dom] relaying result back to worker:', workerId);
      relayToWorker(workerId, { type: 'dom_result', id: id, result: result });

      // Notify shell of DOM mutations for auto-save (not for query-only actions)
      var mutatingActions = ['create', 'modify', 'remove'];
      if (mutatingActions.indexOf(command.action) !== -1) {
        relayToShell({ type: 'dom_mutated' });
      }
    } catch (err) {
      console.error('[flo:dom] handleDomCommand error:', err.message);
      relayToWorker(workerId, { type: 'dom_result', id: id, result: { description: 'Error: ' + err.message, elementCount: 0 }, error: err.message });
    }
  }

  function handleRunJsIframe(id, code, workerId) {
    try {
      var fn = new Function(code);
      var result = fn();
      relayToWorker(workerId, { type: 'runjs_result', id: id, result: result !== undefined ? String(result) : 'undefined' });
    } catch (err) {
      relayToWorker(workerId, { type: 'runjs_result', id: id, result: null, error: err.message });
    }
  }

  // ============================================================================
  // State Capture & Restore
  // ============================================================================

  function handleCaptureDomState(id) {
    try {
      // Capture viewport if exists, otherwise capture body (agents have full DOM control)
      var viewport = document.getElementById('agent-viewport');
      var viewportHtml;
      if (viewport) {
        viewportHtml = viewport.innerHTML;
      } else {
        // Clone body to filter out bootstrap script before capturing
        var bodyClone = document.body.cloneNode(true);
        var bootstrapScripts = bodyClone.querySelectorAll('script[data-flo-bootstrap]');
        bootstrapScripts.forEach(function(s) { s.remove(); });
        viewportHtml = bodyClone.innerHTML;
      }

      // Also capture body attributes (e.g., style, class) since innerHTML doesn't include them
      var bodyAttrs = {};
      var headHtml = '';
      var htmlAttrs = {};
      if (!viewport) {
        Array.from(document.body.attributes).forEach(function(attr) {
          bodyAttrs[attr.name] = attr.value;
        });
        // Capture head content (styles, meta, title) excluding any injected scripts
        headHtml = document.head.innerHTML;
        // Capture html element attributes (lang, dir, etc.)
        Array.from(document.documentElement.attributes).forEach(function(attr) {
          htmlAttrs[attr.name] = attr.value;
        });
      }

      relayToShell({
        type: 'dom_state_captured',
        id: id,
        state: {
          viewportHtml: viewportHtml,
          bodyAttrs: bodyAttrs,
          headHtml: headHtml,
          htmlAttrs: htmlAttrs,
          listeners: collectListeners(),
          capturedAt: Date.now()
        }
      });
    } catch (err) {
      relayToShell({
        type: 'dom_state_captured',
        id: id,
        state: {
          viewportHtml: '',
          bodyAttrs: {},
          headHtml: '',
          htmlAttrs: {},
          listeners: [],
          capturedAt: Date.now()
        }
      });
    }
  }

  function handleRestoreDomState(data) {
    if (!data.state) return;
    // Allow restore even if viewportHtml is empty but other state exists
    if (!data.state.viewportHtml && !data.state.bodyAttrs && !data.state.headHtml && !data.state.htmlAttrs) return;

    var viewport = document.getElementById('agent-viewport');
    if (viewport) {
      if (data.state.viewportHtml) {
        viewport.innerHTML = data.state.viewportHtml;
        // Re-execute script tags (innerHTML doesn't execute them)
        activateScripts(viewport);
      }
    } else {
      // Restore html element attributes (lang, dir, etc.)
      if (data.state.htmlAttrs) {
        Object.keys(data.state.htmlAttrs).forEach(function(name) {
          document.documentElement.setAttribute(name, data.state.htmlAttrs[name]);
        });
      }

      // Restore head content (styles, meta, title)
      if (data.state.headHtml) {
        document.head.innerHTML = data.state.headHtml;
        // Re-execute script tags in head
        activateScripts(document.head);
      }

      // Restore body attributes first (style, class, etc.)
      if (data.state.bodyAttrs) {
        Object.keys(data.state.bodyAttrs).forEach(function(name) {
          document.body.setAttribute(name, data.state.bodyAttrs[name]);
        });
      }

      if (data.state.viewportHtml) {
        // Agents have full DOM control - restore to body (excluding bootstrap script)
        // Create a temporary container to parse and restore safely
        var temp = document.createElement('div');
        temp.innerHTML = data.state.viewportHtml;

        // Remove any bootstrap scripts from saved state (old scripts without data-flo-bootstrap)
        // These would overwrite window.flo with an empty workers map
        var savedScripts = temp.querySelectorAll('script');
        savedScripts.forEach(function(s) {
          // Identify bootstrap by attribute OR by content markers
          if (s.hasAttribute('data-flo-bootstrap') ||
              (s.textContent && s.textContent.indexOf('var workers = {}') !== -1 &&
               s.textContent.indexOf('window.flo') !== -1)) {
            s.remove();
          }
        });

        // Clear body content (keeping the bootstrap script intact)
        var scripts = document.querySelectorAll('body > script');
        document.body.innerHTML = '';
        // Restore content
        while (temp.firstChild) {
          document.body.appendChild(temp.firstChild);
        }
        // Re-append bootstrap scripts
        scripts.forEach(function(s) { document.body.appendChild(s); });
        // Re-execute script tags (innerHTML doesn't execute them)
        activateScripts(document.body);

        // Re-apply body attributes after innerHTML cleared them
        if (data.state.bodyAttrs) {
          Object.keys(data.state.bodyAttrs).forEach(function(name) {
            document.body.setAttribute(name, data.state.bodyAttrs[name]);
          });
        }
      }
    }

    // Re-register event listeners if they were saved
    if (data.state.listeners && Array.isArray(data.state.listeners)) {
      data.state.listeners.forEach(function(listener) {
        handleListenCommand(
          generateId('restore'),
          listener.selector,
          listener.events,
          listener.workerId || 'main',
          listener.options
        );
      });
    }
  }
})();
</script>`;
}

/**
 * Inject the bootstrap script into custom template HTML.
 * If template contains <!-- FLO_BOOTSTRAP --> placeholder, replaces it.
 * Otherwise, injects before the first <script> tag so that `flo` is defined
 * before any template scripts execute. Falls back to before </body> or end.
 */
export function injectBootstrap(html: string, agentId: string): string {
  const bootstrap = generateBootstrapScript(agentId);

  const placeholderIndex = html.indexOf('<!-- FLO_BOOTSTRAP -->');
  const firstScriptIndex = html.search(/<script[\s>]/i);

  if (placeholderIndex !== -1) {
    // If there's a <script> before the placeholder, inject before the script
    // so flo is defined before any template scripts execute
    if (firstScriptIndex !== -1 && firstScriptIndex < placeholderIndex) {
      const cleaned = html.replace('<!-- FLO_BOOTSTRAP -->', '');
      return cleaned.slice(0, firstScriptIndex) + bootstrap + '\n' + cleaned.slice(firstScriptIndex);
    }
    return html.replace('<!-- FLO_BOOTSTRAP -->', bootstrap);
  }

  // No placeholder — inject before the first <script> tag
  if (firstScriptIndex !== -1) {
    return html.slice(0, firstScriptIndex) + bootstrap + '\n' + html.slice(firstScriptIndex);
  }

  // No scripts — inject before </body>
  const bodyCloseIndex = html.lastIndexOf('</body>');
  if (bodyCloseIndex !== -1) {
    return html.slice(0, bodyCloseIndex) + bootstrap + html.slice(bodyCloseIndex);
  }

  // Fallback: append to end
  return html + bootstrap;
}

/**
 * Generates the srcdoc HTML for agent sandboxed iframes.
 *
 * DOM Structure:
 * - Agents have full control over document.body
 * - The bootstrap script handles worker communication and must not be removed
 * - Default content goes directly in body (no required container structure)
 * - Use dom tool or runjs for any DOM manipulation
 */
export function generateIframeSrcdoc(agentId: string, agentName: string): string {
  // Escape agent name for safe HTML insertion
  const safeName = agentName.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; min-height: 100vh; }
  /* Default placeholder - agents can remove/replace this */
  .agent-placeholder {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #888;
    text-align: center;
    padding: 2rem;
    pointer-events: none;
  }
  .agent-placeholder__name {
    font-size: 1.1rem;
    font-weight: 500;
    color: #666;
    margin-bottom: 0.25rem;
  }
  .agent-placeholder__status {
    font-size: 0.8rem;
    color: #999;
  }
</style>
</head>
<body>
<div class="agent-placeholder">
  <div class="agent-placeholder__name">${safeName}</div>
  <div class="agent-placeholder__status">Awaiting instructions...</div>
</div>
${generateBootstrapScript(agentId)}
</body>
</html>`;
}
