import type { StoredSkill } from '../types/skills.js';

/**
 * System skills — built-in reference documentation that agents discover
 * via list_skills and load on demand via get_skill.
 *
 * These replace the detailed sections of the old system prompt with
 * on-demand reference material, keeping the base system prompt slim.
 */

const floCookbook: StoredSkill = {
  name: 'flo-cookbook',
  manifest: {
    name: 'flo-cookbook',
    description: 'Core patterns and API reference: DOM best practices, flo API (callTool, state, notify/ask, media), architect pattern, event handling, persistent memory, error handling, performance tips, anti-patterns',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Cookbook — Core Patterns & API Reference

## DOM Best Practices

- Design your page to fit the viewport — use flexbox/grid, vh/vw units, avoid fixed pixel heights that cause overflow. Only use scrolling layouts when content genuinely requires it. Hub agents may be viewed from multiple browsers with different screen sizes simultaneously — always use responsive CSS rather than hard-coding dimensions from a single capabilities snapshot.
- On mobile, only \`ui-only\` and \`chat-only\` view states are available (\`max\` is desktop only). Default is \`chat-only\` — user sees only chat, your DOM is hidden. Switch to \`ui-only\` when your page is the primary experience. In \`ui-only\` the user CANNOT see the chat panel — communicate through your page, not text responses.
- Prefer inline handlers: \`<button onclick="handleClick()">Click</button>\`
- Include \`<script>\` tags with your HTML to define functions and setup listeners — avoids separate runjs calls and makes your page interactive immediately. Scripts in \`dom create\` auto-execute; do NOT use \`runjs\` to verify or re-inject them.
- Do NOT use \`dom modify\` to update a \`<script>\` tag's innerHTML — browsers don't re-execute modified scripts. Rebuild the containing element or use runjs.
- Use \`var\` (not const/let) for top-level variables, or assign to \`window\` (e.g., \`window.state = {}\`). This allows scripts to re-run without "already declared" errors.
- \`alert()\`, \`confirm()\`, \`prompt()\` are NOT available (sandboxed). Use \`flo.notify()\`/\`flo.ask()\` or build DOM UI instead.
- DOM responses include rendered dimensions and visibility info. Check for 0x0 or NOT VISIBLE to verify layouts. Note: \`dom create\` reports rendered info for the created wrapper, not the full page — a 0x0 result is normal for style elements.
- Runtime errors, console.error() calls, and resource load failures are automatically batched and reported. To be notified of caught errors, re-throw: \`catch (e) { /* cleanup */ throw e; }\`

## runjs Tips

- \`runjs\` wraps your code in a function body — use \`return\` to get values back (e.g., \`return document.title\`). Bare expressions return \`undefined\`.
- Default execution context is the Web Worker. To run code in the page iframe, pass \`context: 'iframe'\`.
- Prefer inline \`<script>\` tags in \`dom create\` over separate \`runjs\` calls — it's simpler and avoids wasted tool calls. Reserve \`runjs\` for one-off debugging or late-binding logic.

## flo API Reference

Available globally in page JavaScript (\`<script>\` tags):

### Communication
- \`flo.notify(event, data)\` — Fire-and-forget event to the agent
- \`flo.ask(event, data)\` — Request-response from the agent (returns Promise)

### Tool Access
- \`flo.callTool(name, input, options)\` — Call tools from page JS. Returns a Promise. Returns native JS values (objects, arrays, strings), not raw JSON. Options: \`{ timeout: ms }\` (default 30s).

Security tiers:
- Immediate: storage, files, view_state, subagent, capabilities, agent_respond, worker_message
- Approval required: fetch, web_fetch, web_search
- Blocked: Hub tools (bash, etc.)

Storage examples:
\`\`\`js
await flo.callTool('storage', { action: 'set', key: 'items', value: [1, 2, 3] })  // { ok: true }
var items = await flo.callTool('storage', { action: 'get', key: 'items' })         // [1, 2, 3]
var keys = await flo.callTool('storage', { action: 'list' })                       // ['items', ...]
await flo.callTool('storage', { action: 'delete', key: 'items' })                  // { ok: true }
\`\`\`

Files examples:
\`\`\`js
await flo.callTool('files', { action: 'write_file', path: 'out.txt', content: text })
var content = await flo.callTool('files', { action: 'read_file', path: 'out.txt' })
\`\`\`

IMPORTANT: flo.callTool() is async — always use it in async functions with await.

### Reactive State
- \`flo.state.get(key)\` — Synchronous read from cache (undefined if not set)
- \`flo.state.set(key, value)\` — Update state, fire onChange, check escalation, persist
- \`flo.state.getAll()\` — Shallow copy of all state
- \`flo.state.onChange(keyOrPattern, callback)\` — Register handler. Pattern \`'player.*'\` matches keys starting with \`'player.'\`. Callback: \`(newValue, oldValue, key)\`. Returns unsubscribe fn.
- \`flo.state.escalate(key, condition, message)\` — Register escalation rule. Condition: \`true\`/\`'always'\`/function/JS-expression-string. Triggers state_escalation event.
- \`flo.state.clearEscalation(key)\` — Remove escalation rule.

### Permissions & Media
- \`flo.requestPermission(type)\` — Request browser permissions (must be enabled in agent settings first)
- \`flo.getCamera()\` — Camera MediaStream (video only). Shell captures, proxies via WebRTC.
- \`flo.getMicrophone()\` — Microphone MediaStream (audio only).
- \`flo.getMediaStream({ video: true, audio: true })\` — Combined MediaStream.
- \`flo.stopMediaStream(stream)\` — Stop stream and release devices.
- \`flo.geolocation.getCurrentPosition(options?)\` — One-shot position. Shell proxies via postMessage. Returns Promise.
- \`flo.geolocation.watchPosition(onposition, onerror?, options?)\` — Continuous tracking. Returns session with \`.stop()\`.

Video elements MUST have both \`playsinline\` and \`autoplay\` attributes for iOS compatibility.

## Architect Pattern

For interactive apps (games, dashboards, forms), prefer being an architect over a micromanager:

1. Use the state tool to set initial state and escalation rules. IMPORTANT: state values are native JSON — use \`value: []\` for empty array, not \`value: "[]"\`.
2. Build your page with \`<script>\` tags that use \`flo.state.get/set/onChange\` for all interactions.
3. Finish processing — page JS handles user interactions autonomously without API calls.
4. Wake only when escalation conditions fire (e.g., game over, score threshold, error state).

This dramatically reduces token cost and latency. State escalations arrive as "Event: state_escalation" notifications with \`{key, value, message, snapshot}\`.

## Event Handling

You are NOT automatically notified of viewport changes, resize events, or other browser events. This is by design — waking you for every resize wastes tokens.

- Use \`dom listen\` to subscribe to DOM events on specific elements (clicks, input changes, etc.)
- For viewport/resize: add a resize handler in page JS that updates flo.state, then use \`flo.state.escalate()\` to wake you only when meaningful thresholds are crossed.
- You always get viewport info in \`capabilities\` responses and DOM tool responses (rendered info).

In general, prefer the escalation pattern: page JS monitors events and writes to flo.state; escalation rules wake you only when action is needed.

## Persistent Memory

Your files persist across sessions — use them as memory. At the start of each session, check for existing files to resume context. Maintain files like:
- \`memory.md\` — User preferences, project state, decisions, what worked/failed
- \`plan.md\` — Current goals, progress, next steps
- \`notes.md\` — Working notes, research, ideas

Use context_search to look up past conversation details:
- \`context_search({ mode: 'search', query: '...', before: 3, after: 3 })\` — find past discussions
- \`context_search({ mode: 'tail', last: 20 })\` — recent conversation history
- \`context_search({ mode: 'head', first: 10 })\` — beginning of conversation
- \`context_search({ mode: 'turn', turnId: 't5' })\` — retrieve full messages for a specific turn (turn IDs shown in activity log)
- \`context_search({ mode: 'turn', turnId: 't5', before: 1, after: 1 })\` — include surrounding turns

## Anti-Patterns

- Don't create large monolithic HTML — break into components updated via dom modify
- Don't use runjs for every interaction — embed logic in \`<script>\` tags
- Don't use runjs to verify \`dom create\` scripts ran — they always auto-execute. Build the complete page in one \`dom create\`, then finish processing.
- Don't poll for user input — use event listeners and flo.state.onChange
- Don't wake the agent for trivial events — use escalation for meaningful state changes only
- Don't store state in JS variables alone — use flo.state for persistence across sessions`,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floSrcdoc: StoredSkill = {
  name: 'flo-srcdoc',
  manifest: {
    name: 'flo-srcdoc',
    description: 'Save/load UI snapshots as .srcdoc files, metadata with .srcdoc.md frontmatter, files frontmatter listing, multi-skin management',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Srcdoc — UI Snapshots & Multi-Skin Management

## Saving UI Snapshots

Save your page as a reusable skin (UI snapshot):

1. **HTML file**: Save as \`$name.srcdoc\` — the full HTML of your page
2. **Metadata file**: Save as \`$name.srcdoc.md\` with YAML frontmatter:
\`\`\`markdown
---
title: Calculator
description: Scientific calculator with graphing
---
Optional notes about this skin.
\`\`\`

## Listing Available Skins

Use the files tool with frontmatter action to discover saved UIs:
\`\`\`
files({ action: 'frontmatter', pattern: '*.srcdoc.md' })
\`\`\`

This returns the YAML frontmatter from all matching files, letting you present a menu of available skins.

## Loading a Skin

Read the \`.srcdoc\` file and set it as your page content:
\`\`\`
files({ action: 'read_file', path: 'calculator.srcdoc' })
dom({ action: 'create', html: '<content from file>' })
\`\`\`

## Multi-Skin Management

Agents can maintain multiple skins for different purposes:
- \`dashboard.srcdoc\` / \`dashboard.srcdoc.md\` — main dashboard view
- \`settings.srcdoc\` / \`settings.srcdoc.md\` — settings panel
- \`game.srcdoc\` / \`game.srcdoc.md\` — game interface

Switch between skins by reading and loading the appropriate \`.srcdoc\` file. The user can request specific skins by name.

## Best Practices

- Always create both \`.srcdoc\` and \`.srcdoc.md\` files
- Include meaningful title and description in frontmatter
- Save skins after significant UI milestones
- Check for existing skins at session start to offer resumption`,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floSubagent: StoredSkill = {
  name: 'flo-subagent',
  manifest: {
    name: 'flo-subagent',
    description: 'Subagent tool usage, flo.callTool("subagent"), architect-workers pattern, depth limits, cost optimization',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Subagent — Worker Agents & Delegation

## Subagent Tool

Spawn lightweight worker agents for delegated tasks:
\`\`\`
subagent({ task: 'Analyze this data and return a summary', context: 'optional additional context' })
\`\`\`

Subagents:
- Have minimal context (~200 tokens vs 2000+ for full conversation)
- Can use all the same tools (dom, storage, files, state, etc.)
- Return a text result when complete
- Have a default 5-minute timeout

## Calling from Page JavaScript

Use flo.callTool to spawn subagents directly from your page scripts:
\`\`\`js
var result = await flo.callTool('subagent', {
  task: 'Generate a color palette for a nature theme',
}, { timeout: 300000 });
// result is the subagent's text response
\`\`\`

## Architect-Workers Pattern

Extend the architect pattern with lightweight subagents:

1. Build your page with \`<script>\` tags, set up flo.state, finish processing
2. Page JS calls \`flo.callTool('subagent', { task: '...' }, { timeout: 300000 })\` for routine work
3. Subagents read/write flo.state via the state tool, return text results
4. Main agent wakes only on escalation — subagents handle routine work

Benefits:
- Each subagent has minimal context → much cheaper per call
- Main agent stays inactive → no token cost for routine operations
- Subagents can run concurrently from different page interactions
- State changes from subagents trigger the same escalation rules

## Depth Limits

- Subagents cannot spawn their own subagents (depth limit = 1)
- This prevents runaway recursive spawning
- If a subagent needs complex multi-step work, it should return instructions for the parent

## Cost Optimization

- Subagent calls cost ~10-20x less than waking the main agent
- Use subagents for: data processing, content generation, calculations, API calls
- Keep the main agent for: page architecture, complex state management, user-facing decisions`,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floSpeech: StoredSkill = {
  name: 'flo-speech',
  manifest: {
    name: 'flo-speech',
    description: 'Speech capabilities: flo.speech.listen() for STT, flo.speech.speak() for TTS, voice selection, platform notes, iOS quirks',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Speech — Voice Input & Output

## Speech-to-Text (STT)

\`flo.speech.listen()\` returns a **session object** (not a Promise). The session captures speech continuously until you call \`done()\` or \`cancel()\`.

\`\`\`js
// Start listening — returns session object immediately
var session = flo.speech.listen({
  lang: 'en-US',                          // optional, defaults to en-US
  oninterim: function(text) {             // optional, called with partial transcript
    document.getElementById('preview').textContent = text;
  }
});

// User clicks "Done" — finalize and get result
session.done().then(function(result) {
  // result = { text: 'final transcript', confidence: 0.95 }
  // result is null if cancelled
  console.log(result.text);
});

// User clicks "Cancel" — discard
session.cancel();
\`\`\`

### Complete voice note example:
\`\`\`html
<button id="recordBtn" onclick="toggleRecording()">Press to Talk</button>
<div id="transcript"></div>
<button id="doneBtn" onclick="finishRecording()" style="display:none">Done</button>
<button id="cancelBtn" onclick="cancelRecording()" style="display:none">Cancel</button>

<script>
var currentSession = null;

function toggleRecording() {
  if (currentSession) return;
  document.getElementById('recordBtn').textContent = 'Listening...';
  document.getElementById('doneBtn').style.display = '';
  document.getElementById('cancelBtn').style.display = '';

  currentSession = flo.speech.listen({
    oninterim: function(text) {
      document.getElementById('transcript').textContent = text;
    }
  });
}

function finishRecording() {
  if (!currentSession) return;
  currentSession.done().then(function(result) {
    if (result) {
      document.getElementById('transcript').textContent = result.text;
      // Save the note...
    }
    resetUI();
  });
}

function cancelRecording() {
  if (!currentSession) return;
  currentSession.cancel();
  resetUI();
}

function resetUI() {
  currentSession = null;
  document.getElementById('recordBtn').textContent = 'Press to Talk';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'none';
}
</script>
\`\`\`

## Text-to-Speech (TTS)

\`\`\`js
// Speak text (returns Promise, resolves when done)
await flo.speech.speak('Hello!');

// With options
await flo.speech.speak('Bonjour', {
  lang: 'fr-FR',
  voice: 'Thomas'   // specific voice name from voices()
});
\`\`\`

## Available Voices

\`\`\`js
// Returns Promise<Array<{ name, lang, local }>>
var voices = await flo.speech.voices();
\`\`\`

## Platform Notes

- **iOS Safari**: SpeechRecognition auto-stops after ~60s of silence — the runtime auto-restarts
- **iOS Safari**: TTS requires cancel() before speak() and keepalive — handled by the runtime
- **Sandboxed iframes**: Speech APIs are proxied through the shell via postMessage — works transparently
- **Microphone permission**: Requires user gesture and permission grant (agent settings must enable microphone)

## Best Practices

- Use \`oninterim\` callback for real-time visual feedback while recording
- Let the user control when to finalize (\`done()\`) vs discard (\`cancel()\`)
- Build the complete UI with \`<script>\` tags in a single \`dom create\` — don't use separate runjs calls
- Always handle the case where \`done()\` returns null (cancelled) or empty text`,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floMedia: StoredSkill = {
  name: 'flo-media',
  manifest: {
    name: 'flo-media',
    description: 'Camera & microphone access: flo.getCamera(), flo.getMicrophone(), flo.getMediaStream(), WebRTC proxy, permissions, iOS quirks, photo capture pattern',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Media — Camera & Microphone Access

## Why You Need This

Your page runs in an opaque-origin sandboxed iframe. \`navigator.mediaDevices.getUserMedia()\` is **BLOCKED** and will always fail. Use the flo media API instead — it transparently proxies media from the shell via WebRTC.

## API Reference

All methods are available globally in page JavaScript (\`<script>\` tags):

\`\`\`js
// Camera only (video MediaStream)
var stream = await flo.getCamera();

// Microphone only (audio MediaStream)
var stream = await flo.getMicrophone();

// Combined or custom
var stream = await flo.getMediaStream({ video: true, audio: true });

// Stop stream and release hardware
flo.stopMediaStream(stream);

// Request permission before media access (optional — auto-prompted on first use)
// Returns true/false for browser permission, throws if agent-level approval denied
var granted = await flo.requestPermission('camera');
var granted = await flo.requestPermission('microphone');
\`\`\`

All media methods return Promises. Timeout is 60 seconds.

IMPORTANT: Do NOT call \`stream.getTracks().forEach(t => t.stop())\` directly — that only stops the local receiving end. The shell keeps capturing from the camera/mic hardware. You MUST use \`flo.stopMediaStream(stream)\` to properly release the device.

## Permission Flow

1. Agent calls \`flo.getCamera()\` (or \`getMediaStream\`/\`getMicrophone\`)
2. If camera isn't pre-enabled in agent settings, user sees an approval dialog: Deny / Allow Once / Allow Always
3. If denied at the approval dialog, the Promise **rejects** with an Error
4. If approved, browser's native permission prompt appears (if not already granted)
5. MediaStream is delivered via WebRTC loopback

\`flo.requestPermission(type)\` lets you request permission proactively. Same flow: approval dialog → browser prompt. Resolves \`true\`/\`false\` for browser grant, but **throws** if the agent-level approval dialog is denied. Wrap in try/catch.

## Complete Camera Preview Example

\`\`\`html
<div id="preview-container">
  <video id="camera" playsinline autoplay style="width:100%;border-radius:12px"></video>
</div>
<div style="display:flex;gap:12px;margin-top:12px">
  <button onclick="startCamera()" id="startBtn">Start Camera</button>
  <button onclick="takePhoto()" id="photoBtn" style="display:none">Take Photo</button>
  <button onclick="stopCamera()" id="stopBtn" style="display:none">Stop</button>
</div>
<canvas id="canvas" style="display:none"></canvas>
<div id="photos"></div>

<script>
var cameraStream = null;

async function startCamera() {
  try {
    cameraStream = await flo.getCamera();
    document.getElementById('camera').srcObject = cameraStream;
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('photoBtn').style.display = '';
    document.getElementById('stopBtn').style.display = '';
  } catch (e) {
    flo.notify('camera_error', { error: e.message });
  }
}

function takePhoto() {
  var video = document.getElementById('camera');
  var canvas = document.getElementById('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  var img = document.createElement('img');
  img.src = canvas.toDataURL('image/jpeg', 0.8);
  img.style.cssText = 'width:100%;border-radius:8px;margin-top:8px';
  document.getElementById('photos').prepend(img);
}

function stopCamera() {
  if (cameraStream) {
    flo.stopMediaStream(cameraStream);
    cameraStream = null;
  }
  document.getElementById('camera').srcObject = null;
  document.getElementById('startBtn').style.display = '';
  document.getElementById('photoBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'none';
}
</script>
\`\`\`

## Error Handling

Media requests reject on failure — always wrap in try/catch:

\`\`\`js
try {
  var stream = await flo.getCamera();
} catch (e) {
  // e.message will be one of:
  // "Permission \\"camera\\" was denied by the user." — agent-level approval denied
  // "Media capture failed: NotFoundError: ..."       — no camera device
  // "Media capture failed: NotAllowedError: ..."     — browser permission denied
  // "Media request timed out"                        — 60s timeout
}
\`\`\`

## Platform Notes

- **iOS Safari**: \`getUserMedia()\` always fails in sandboxed srcdoc iframes — the WebRTC proxy handles this transparently
- **iOS Safari**: Video elements MUST have both \`playsinline\` and \`autoplay\` attributes or video won't display
- **Chrome**: Only one \`SpeechRecognition\` instance at a time — if using both speech and media, stop speech first
- **All browsers**: Always call \`flo.stopMediaStream(stream)\` when done to release camera/mic hardware

## Best Practices

- Always use \`playsinline autoplay\` on video elements: \`<video playsinline autoplay>\`
- ALWAYS use \`flo.stopMediaStream(stream)\` to stop — never \`track.stop()\` directly (WebRTC proxy requires shell-side cleanup)
- Use \`flo.requestPermission()\` proactively if you want to handle denial before showing camera UI
- Build the complete UI with \`<script>\` tags in a single \`dom create\` — don't use separate runjs calls
- For photo capture: draw video frame to a hidden \`<canvas>\`, then use \`canvas.toDataURL()\``,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floGeolocation: StoredSkill = {
  name: 'flo-geolocation',
  manifest: {
    name: 'flo-geolocation',
    description: 'Geolocation access: flo.geolocation.getCurrentPosition(), flo.geolocation.watchPosition(), permission flow, coordinate data',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Geolocation — Location Access

## Why You Need This

Your page runs in an opaque-origin sandboxed iframe. \`navigator.geolocation\` is **BLOCKED** and will always fail. Use \`flo.geolocation\` instead — it proxies through the shell.

## API Reference

All methods are available globally in page JavaScript (\`<script>\` tags):

### One-Shot Position

\`\`\`js
// Returns Promise<{ latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed, timestamp }>
var pos = await flo.geolocation.getCurrentPosition();

// With options
var pos = await flo.geolocation.getCurrentPosition({
  enableHighAccuracy: true,   // GPS vs network (default: false)
  timeout: 10000,             // max wait in ms (default: 30000)
  maximumAge: 60000           // accept cached position up to N ms old (default: 0)
});

console.log(pos.latitude, pos.longitude, pos.accuracy);
\`\`\`

### Continuous Tracking

\`\`\`js
// Returns a watch session with .stop() method
var watch = flo.geolocation.watchPosition(
  function(pos) {
    // Called on each position update
    console.log(pos.latitude, pos.longitude);
    document.getElementById('coords').textContent = pos.latitude + ', ' + pos.longitude;
  },
  function(err) {
    // Optional error callback
    console.error('Location error:', err.message, 'code:', err.code);
  },
  { enableHighAccuracy: true }  // Optional options
);

// Stop tracking
watch.stop();
\`\`\`

## Permission Flow

1. Agent calls \`flo.geolocation.getCurrentPosition()\` or \`watchPosition()\`
2. If geolocation isn't pre-enabled in agent settings, user sees approval dialog: Deny / Allow Once / Allow Always
3. If denied, the Promise rejects (getCurrentPosition) or error callback fires (watchPosition)
4. If approved, browser's native geolocation prompt appears (if not already granted)
5. Position data is proxied from shell to iframe via postMessage

You can also request permission proactively:
\`\`\`js
var granted = await flo.requestPermission('geolocation');
\`\`\`

## Error Handling

\`\`\`js
try {
  var pos = await flo.geolocation.getCurrentPosition();
} catch (e) {
  // e.message contains the error description
  // Common errors:
  // "Permission \\"geolocation\\" was denied by the user."  — agent-level approval denied
  // "User denied Geolocation"                               — browser permission denied
  // "Position unavailable"                                   — device can't determine position
  // "Timeout expired"                                        — took too long
  // "Geolocation request timed out"                          — 30s proxy timeout
}
\`\`\`

Error codes (from GeolocationPositionError):
- 1 = PERMISSION_DENIED
- 2 = POSITION_UNAVAILABLE
- 3 = TIMEOUT

## Complete Example — Location Display

\`\`\`html
<div id="location" style="padding:20px;font-family:system-ui">
  <h2>My Location</h2>
  <div id="coords">Getting location...</div>
  <div id="accuracy" style="color:#666;margin-top:4px"></div>
  <button onclick="getLocation()" style="margin-top:12px;padding:8px 16px">Refresh</button>
  <button onclick="toggleWatch()" id="watchBtn" style="margin-top:12px;padding:8px 16px">Start Tracking</button>
</div>

<script>
var currentWatch = null;

async function getLocation() {
  try {
    var pos = await flo.geolocation.getCurrentPosition({ enableHighAccuracy: true });
    document.getElementById('coords').textContent = pos.latitude.toFixed(6) + ', ' + pos.longitude.toFixed(6);
    document.getElementById('accuracy').textContent = 'Accuracy: ' + Math.round(pos.accuracy) + 'm';
  } catch (e) {
    document.getElementById('coords').textContent = 'Error: ' + e.message;
  }
}

function toggleWatch() {
  if (currentWatch) {
    currentWatch.stop();
    currentWatch = null;
    document.getElementById('watchBtn').textContent = 'Start Tracking';
  } else {
    currentWatch = flo.geolocation.watchPosition(
      function(pos) {
        document.getElementById('coords').textContent = pos.latitude.toFixed(6) + ', ' + pos.longitude.toFixed(6);
        document.getElementById('accuracy').textContent = 'Accuracy: ' + Math.round(pos.accuracy) + 'm';
      },
      function(err) {
        document.getElementById('coords').textContent = 'Error: ' + err.message;
      },
      { enableHighAccuracy: true }
    );
    document.getElementById('watchBtn').textContent = 'Stop Tracking';
  }
}

getLocation();
</script>
\`\`\`

## Platform Notes

- **All browsers**: \`navigator.geolocation\` always fails in sandboxed srcdoc iframes — the shell proxy handles this transparently
- **iOS Safari**: May require HTTPS for geolocation access (the dev server uses HTTPS by default)
- **Accuracy**: \`enableHighAccuracy: true\` uses GPS (slower, more battery) vs network location (faster, less accurate)
- **Indoor**: GPS may not work indoors — \`enableHighAccuracy: false\` often gives better results indoors via WiFi positioning`,
  source: { type: 'builtin' },
  installedAt: 0,
};

const floHub: StoredSkill = {
  name: 'flo-hub',
  manifest: {
    name: 'flo-hub',
    description: 'Hub persistence: autonomous execution, schedule tool (cron/event triggers), hub-side state/files/DOM, browser connected vs hub-only modes, working directory',
    category: 'system',
    userInvocable: false,
    requiredCapabilities: ['hub'],
  },
  instructions: `# flo Hub — Persistent Agent Runtime

## Two Modes

Hub persistence gives you two modes. Check \`capabilities\` → \`executionMode\`:

### hub-with-browser — A browser is connected
**Your page is a fully interactive living page.** Use the architect pattern exactly as in browser mode: page JS handles UI updates in event handlers, \`flo.notify()\` sends events to you, inline \`<script>\` tags execute, \`runjs\`, \`dom listen\`, \`view_state\` all work. Build interactive pages with JS — don't hold back because you're on a hub.

Additionally, you have hub-native tools: \`bash\`, \`filesystem\`, \`schedule\`.

### hub-only — No browser connected
You are running autonomously. Structural DOM only — \`dom create/modify/query/remove\` work via JSDOM but with limitations:
- No JS execution — \`<script>\` tags are stored but don't run until a browser connects
- No rendering — dimensions report as 0x0
- No events — \`dom listen/wait_for\` unavailable

Use \`state\`, \`files\`, \`bash\`, \`filesystem\`, and \`schedule\` for autonomous work.

## Hub-Native Tools (always available)
- \`bash\` — shell commands in your working directory
- \`filesystem\` — read/write server files
- \`state\` — reactive state store (persists across restarts)
- \`files\` — agent workspace files (disk-backed, not browser OPFS)
- \`schedule\` — cron jobs and event triggers
- \`capabilities\`, \`context_search\`, \`list_skills\`, \`get_skill\`

## Schedule Tool — Autonomous Execution

The \`schedule\` tool lets you set up triggers that wake you when no one is around:

### Cron Jobs (periodic)
\`\`\`
schedule({ action: 'add', type: 'cron', cron: '*/5 * * * *', message: 'Check for updates' })
schedule({ action: 'add', type: 'cron', cron: '0 9 * * 1-5', message: 'Daily standup summary', maxRuns: 5 })
\`\`\`

Cron format: \`minute hour day month weekday\`
- \`*\` = every, \`*/N\` = every N, \`N\` = specific, \`N-M\` = range, \`N,M\` = list
- Examples: \`*/5 * * * *\` (every 5 min), \`0 */2 * * *\` (every 2 hours), \`30 9 * * 1-5\` (9:30 AM weekdays)
- Minimum interval: 1 minute. Maximum 10 schedules per agent.

### Event Triggers (reactive)
\`\`\`
schedule({ action: 'add', type: 'event', event: 'state:score', condition: '> 100', message: 'Score exceeded 100!' })
schedule({ action: 'add', type: 'event', event: 'browser:connected', message: 'A browser just connected' })
schedule({ action: 'add', type: 'event', event: 'browser:disconnected', message: 'Browser disconnected' })
\`\`\`

Events: \`state:<key>\` (state changes), \`browser:connected\`, \`browser:disconnected\`
Conditions: \`> N\`, \`< N\`, \`== value\`, \`changed\`, \`always\`, or JS expression

### Managing Schedules
\`\`\`
schedule({ action: 'list' })                    // show all schedules
schedule({ action: 'disable', id: 'sched-1' })  // pause a schedule
schedule({ action: 'enable', id: 'sched-1' })   // resume
schedule({ action: 'remove', id: 'sched-1' })   // delete
\`\`\`

When triggered, you receive the \`message\` as if a user sent it. You can then update your DOM, files, state, or take any action.

## Hub-Side Storage

- **files tool**: workspace files at \`~/.flo-monster/agents/{hubAgentId}/files/\`, disk-backed, persists across restarts
- **filesystem tool**: general file ops in your sandbox working directory (shown in capabilities)
- **state tool**: same API as browser mode, hub-stored, persists across restarts, escalation rules preserved

## Best Practices

- When a browser is connected, build fully interactive pages with JS — same as browser mode
- When no browser, use structural DOM + state + schedule for autonomous work
- Use \`browser:connected\` event trigger to set up interactive features when a user arrives
- Use \`browser:disconnected\` to save state and prepare for autonomous mode
- Schedule maintenance tasks (file cleanup, status updates) via cron
- Files persist on disk — use them for durable memory (\`memory.md\`, \`plan.md\`, etc.)`,
  source: { type: 'builtin' },
  installedAt: 0,
};

/**
 * Returns all system skills for installation at startup
 */
export function getSystemSkills(): StoredSkill[] {
  return [floCookbook, floSrcdoc, floSubagent, floSpeech, floMedia, floGeolocation, floHub];
}
