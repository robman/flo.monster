import type { StoredSkill } from '../types/skills.js';

/**
 * System skills — built-in reference documentation that agents discover
 * via list_skills and load on demand via get_skill.
 *
 * These replace the detailed sections of the old system prompt with
 * on-demand reference material, keeping the base system prompt slim.
 */

const floSrcdoc: StoredSkill = {
  name: 'flo-srcdoc',
  manifest: {
    name: 'flo-srcdoc',
    description: 'Save/load UI snapshots as .srcdoc files, metadata with .srcdoc.md frontmatter, files frontmatter listing, multi-skin management',
    category: 'system',
    userInvocable: false,
  },
  instructions: `# flo Srcdoc — Skins & Page Persistence

Skins are your page's version control — your DOM is ephemeral without explicit saves. A skin is a snapshot of your page HTML saved as a \`.srcdoc\` file. Without skins, everything you build disappears when the session ends.

> **Unlearn**: Skins do NOT carry \`flo.state\`. Your page JS depends on state values, but the skin only captures HTML. You must save and restore state separately — load state before or immediately after loading a skin, or your page will render without its data.

## Execution Mode

- **Browser modes and hub-with-browser**: Full functionality. \`files\` tool reads/writes skins, \`dom create\` loads them with full script execution.
- **Hub-only**: \`files\` tool works (read/write skins). \`dom create\` works structurally via JSDOM, but scripts do NOT execute until a browser connects. No rendering (0x0 dimensions). No events. Skins saved in hub-only mode are structural snapshots that come alive when a browser arrives.

## Size Limits

1MB per file, 10MB total per agent. Keep skins lean — avoid inlining large base64 assets.

## Saving a Skin

Always create both files — the \`.srcdoc\` with your HTML, and the \`.srcdoc.md\` with metadata so you (and the user) can identify skins later without reading their full content.

\`\`\`
// 1. Capture current page HTML
dom({ action: 'query', selector: 'html', attribute: 'outerHTML' })

// 2. Save the HTML as a skin file
files({ action: 'write_file', path: 'calculator.srcdoc', content: '<captured html>' })

// 3. Save metadata with frontmatter
files({ action: 'write_file', path: 'calculator.srcdoc.md', content: '---\\ntitle: Calculator\\ndescription: Scientific calculator with graphing\\n---\\nNotes about this skin.' })
\`\`\`

## Listing Available Skins

The frontmatter action reads YAML headers from matching files, giving you a menu without loading full skin content:

\`\`\`
files({ action: 'frontmatter', pattern: '*.srcdoc.md' })
// Returns: [{ path: 'calculator.srcdoc.md', title: 'Calculator', description: '...' }, ...]
\`\`\`

## Loading a Skin

Read the \`.srcdoc\` file, then replace your page with its content:

\`\`\`
files({ action: 'read_file', path: 'calculator.srcdoc' })
dom({ action: 'create', html: '<content from file>' })
\`\`\`

This replaces your entire page. Any existing DOM is destroyed. Scripts in the skin execute on load.

## Session Resumption

When starting a new session, check for existing skins before building from scratch:

1. **Check for skins**: \`files({ action: 'frontmatter', pattern: '*.srcdoc.md' })\`
2. **If skins exist**: List them for the user, or load the most appropriate one
3. **Load the skin**: Read the \`.srcdoc\` file, then \`dom create\` with its content
4. **Restore state**: Read saved state from storage or files and apply it — the skin's page JS needs its data

## Multi-Skin Management

An agent can maintain multiple skins for different views — a dashboard, a settings panel, a game board. Each is a pair of files (\`.srcdoc\` + \`.srcdoc.md\`). Switch between them by reading and loading the appropriate skin. The user can request specific skins by name.`,
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
  instructions: `# flo Subagent — Lightweight Worker Delegation

Subagents are lightweight workers that run with isolated, minimal conversation context (~200 tokens vs thousands for the parent). The fundamental tradeoff: subagents are cheap but context-limited; the parent is expensive but has full history. Cost savings come from context size — every API call is priced by input tokens, so a subagent doing a quick task costs a fraction of waking the parent.

> **Unlearn**: Subagents are NOT separate processes or sandboxes. They share your DOM and tools. Think of them as cheap, forgetful copies of yourself that can do focused work without dragging along your entire conversation history.

## Execution Mode

**CRITICAL**: Subagents currently require a browser execution context — they spawn as web workers in the parent's iframe. They are NOT implemented on the hub. In \`hub-only\` and \`hub-with-browser\` modes, calling \`subagent()\` will error.

## Parameters

\`\`\`
subagent({
  task: 'Analyze the data and return a summary',           // required
  systemPrompt: 'You are a data analyst. Be concise.',     // optional: override system prompt
  maxTokensPerSubagent: 50000,                             // optional: token budget ceiling
  maxCostPerSubagent: 0.05                                 // optional: USD cost ceiling
})
\`\`\`

- \`task\` (required): The task description. Phrase it to elicit a text summary in the response.
- \`systemPrompt\` (optional): Override the subagent's system prompt instead of inheriting the parent's. Useful for creating specialized workers.
- \`maxTokensPerSubagent\` (optional): Token budget ceiling for cost control.
- \`maxCostPerSubagent\` (optional): USD cost ceiling for cost control.

## Calling from Page JavaScript

\`\`\`js
var result = await flo.callTool('subagent', {
  task: 'Generate a color palette for a nature theme'
}, { timeout: 300000 });
// result is the subagent's last assistant text message
\`\`\`

## Shared DOM

Subagents share the parent's DOM. They can create, modify, or remove elements on your page. This means multiple concurrent subagents could conflict on DOM updates. Coordinate by assigning each subagent a specific DOM region, or use \`flo.state\` as the coordination layer rather than direct DOM manipulation.

## Return Value

The result is the subagent's last assistant text message. If the subagent only uses tool calls without producing text, the result is \`"(Subagent completed but produced no text response)"\`. Phrase your \`task\` to elicit a text summary — e.g., "...and summarize what you did" — so you get a useful return value.

## Depth Limits

Subagents CAN spawn their own subagents. MAX_DEPTH = 3, meaning: root agent (depth 0) can spawn a subagent (depth 1), which can spawn a sub-subagent (depth 2) — all less than the limit of 3. This prevents unbounded recursive spawning while allowing one level of sub-delegation.

## Error Handling

Subagent calls can fail. When called from page JS, wrap in try/catch:

\`\`\`js
try {
  var result = await flo.callTool('subagent', { task: '...' }, { timeout: 300000 });
} catch (e) {
  // e.message will be one of:
  // "Error: Subagent timed out after 5 minutes"
  // "Error: maximum subagent depth of 3 reached"
  // "Error: parent agent not found"
  // "Subagent encountered an error"
}
\`\`\`

Default timeout is 5 minutes (300000ms). Concurrent subagents use last-write-wins for state — there are no transactional semantics.`,
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

Do NOT use \`SpeechRecognition\` or \`speechSynthesis\` — they are blocked in the sandbox. \`flo.speech\` proxies through the shell via postMessage. The shell runs the native browser speech APIs on your behalf and relays results back.

## Execution Mode

These APIs require a browser connection (\`browser-only\`, \`browser-with-hub\`, \`hub-with-browser\`). In \`hub-only\` mode, they do not exist — there is no browser, no iframe, no shell relay. \`flo.speech\` is not available at all.

## Conceptual Model

**STT** is session-based: \`listen()\` returns a session object immediately (not a Promise). The session captures speech continuously until you call \`done()\` or \`cancel()\`. **TTS** is fire-and-forget: \`speak()\` returns a Promise that resolves when the utterance finishes.

## Permission Flow

Microphone permission is required for STT. Two stages: (1) agent approval dialog (Deny / Allow Once / Allow Always), then (2) browser native microphone prompt. If either is denied, the API fails. \`flo.requestPermission('microphone')\` can request permission proactively — it **throws** if agent-level approval is denied, returns \`true\`/\`false\` for the browser grant.

## Speech-to-Text (STT)

\`\`\`js
var session = flo.speech.listen({
  lang: 'en-US',                          // optional, defaults to en-US
  oninterim: function(text) {             // called with partial transcript
    document.getElementById('preview').textContent = text;
  }
});

// Finalize — returns Promise<{ text, confidence } | null>
session.done().then(function(result) {
  if (result) console.log(result.text);
});

// Or discard
session.cancel();
\`\`\`

> **done() interim fallback:** If the browser has not finalized the transcript when \`done()\` is called, it falls back to the last interim text. So \`done()\` almost always returns something if the user was speaking.

## Text-to-Speech (TTS)

\`\`\`js
await flo.speech.speak('Hello!');
await flo.speech.speak('Bonjour', { lang: 'fr-FR', voice: 'Thomas' });
\`\`\`

## Available Voices

\`\`\`js
// Returns Promise<Array<{ name, lang, local }>> — 10s timeout
var voices = await flo.speech.voices();
\`\`\`

## Error Handling

STT errors:
\`\`\`js
session.done().catch(function(err) {
  // "Microphone permission was denied by the user."
  // "SpeechRecognition not supported"
  // "network" / "audio-capture" / "not-allowed" (browser errors)
});
\`\`\`

TTS errors:
\`\`\`js
try {
  await flo.speech.speak('Hello');
} catch (err) {
  // "SpeechSynthesis not supported"
  // "Speech synthesis timed out" (60s timeout)
}
\`\`\`

## Timeouts

- \`speak()\`: 60 seconds
- \`voices()\`: 10 seconds
- \`listen()\`: No timeout — runs until \`done()\` or \`cancel()\`
- \`done()\`: 500ms internal wait for browser finalization, then falls back to interim text

## Platform Gotchas

- **Chrome single-instance:** Only one \`SpeechRecognition\` instance at a time across the entire browser. If using both speech and the conversation mic, stop one before starting the other.
- **iOS Safari:** SpeechRecognition auto-stops after ~60s of silence — the runtime auto-restarts transparently.
- **iOS Safari:** TTS requires cancel-before-speak and keepalive — handled by the runtime.`,
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

Do NOT use \`navigator.mediaDevices.getUserMedia()\` — it is blocked in the sandbox. \`flo.getCamera()\` proxies through WebRTC from the shell: the shell captures the hardware camera/mic, then streams it to your iframe over a local WebRTC connection. From your page's perspective, you get a standard \`MediaStream\`. This architecture is why you MUST use \`flo.stopMediaStream(stream)\` instead of \`track.stop()\` — stopping local tracks does not tell the shell to release the hardware.

## Execution Mode

These APIs require a browser connection (\`browser-only\`, \`browser-with-hub\`, \`hub-with-browser\`). In \`hub-only\` mode, they do not exist — there is no browser, no iframe, no shell relay. \`flo.getCamera()\`, \`flo.getMicrophone()\`, and \`flo.getMediaStream()\` are not available at all.

## API

\`\`\`js
var stream = await flo.getCamera();                              // video only
var stream = await flo.getMicrophone();                          // audio only
var stream = await flo.getMediaStream({ video: true, audio: true }); // combined
flo.stopMediaStream(stream);                                     // release hardware
var granted = await flo.requestPermission('camera');             // proactive permission check
\`\`\`

All methods return Promises. Timeout is 60 seconds.

> **Constraint limitation:** Only boolean video/audio constraints are supported (\`{ video: true }\`, \`{ video: false }\`). Detailed constraints like \`facingMode\`, resolution, or frame rate are coerced to boolean — do not use them.

> **Single stream:** Only one camera stream at a time. Call \`flo.stopMediaStream()\` on the existing stream before requesting a new one.

> **DOM persistence:** Media streams do not survive DOM persistence. After a restore, re-acquire the camera.

## Permission Flow

Two stages: (1) agent approval dialog (Deny / Allow Once / Allow Always), then (2) browser native permission prompt. If the agent-level dialog is denied, the Promise **rejects** with an Error. If the browser prompt is denied, you get a \`NotAllowedError\`.

\`flo.requestPermission('camera')\` triggers the same flow proactively. It returns \`true\`/\`false\` for the browser grant, but **throws** if the agent-level approval is denied. Wrap in try/catch.

## Error Handling

\`\`\`js
try {
  var stream = await flo.getCamera();
} catch (e) {
  // "Permission \\"camera\\" was denied by the user." — agent approval denied
  // "Media capture failed: NotFoundError: ..."       — no camera device
  // "Media capture failed: NotAllowedError: ..."     — browser permission denied
  // "Media request timed out"                        — 60s timeout
}
\`\`\`

## Camera Preview Example

\`\`\`html
<video id="camera" playsinline autoplay muted style="width:100%"></video>
<button onclick="startCamera()" id="startBtn">Start Camera</button>
<button onclick="stopCamera()" id="stopBtn" style="display:none">Stop</button>
<canvas id="canvas" style="display:none"></canvas>

<script>
var cameraStream = null;

async function startCamera() {
  try {
    cameraStream = await flo.getCamera();
    document.getElementById('camera').srcObject = cameraStream;
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = '';
  } catch (e) {
    flo.notify('camera_error', { error: e.message });
  }
}

function stopCamera() {
  if (cameraStream) {
    flo.stopMediaStream(cameraStream);
    cameraStream = null;
  }
  document.getElementById('camera').srcObject = null;
  document.getElementById('startBtn').style.display = '';
  document.getElementById('stopBtn').style.display = 'none';
}
</script>
\`\`\`

## Vision Pattern — Sending Frames to the Agent

Capture a video frame to canvas, convert to dataURL, send via \`flo.notify()\`:

\`\`\`js
function sendFrameToAgent() {
  var video = document.getElementById('camera');
  var canvas = document.getElementById('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  flo.notify('frame_captured', { image: canvas.toDataURL('image/jpeg', 0.7) });
}
\`\`\`

## Platform Gotchas

- **\`muted\` attribute:** Use \`<video playsinline autoplay muted>\` for reliable autoplay. Chrome's autoplay policy requires \`muted\` for auto-playing video.
- **iOS Safari:** Video elements MUST have both \`playsinline\` and \`autoplay\` or video won't display.
- **Active streams drain battery** on mobile — stop them when not needed.`,
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

Do NOT use \`navigator.geolocation\` — it is blocked in the sandbox. \`flo.geolocation\` proxies through the shell via postMessage. The shell calls the native Geolocation API and relays position data back to your iframe.

> **CRITICAL — flat response shape:** The response is FLAT: \`pos.latitude\`, NOT \`pos.coords.latitude\`. The native Geolocation API nests coords under \`pos.coords\`, but \`flo.geolocation\` flattens them to top-level properties.

## Execution Mode

These APIs require a browser connection (\`browser-only\`, \`browser-with-hub\`, \`hub-with-browser\`). In \`hub-only\` mode, they do not exist — there is no browser, no iframe, no shell relay. \`flo.geolocation\` is not available at all.

## One-Shot Position

\`\`\`js
var pos = await flo.geolocation.getCurrentPosition();
// pos = { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed, timestamp }
console.log(pos.latitude, pos.longitude, pos.accuracy);

// With options
var pos = await flo.geolocation.getCurrentPosition({
  enableHighAccuracy: true,   // GPS vs network (default: false)
  timeout: 10000,             // browser-side geolocation timeout in ms
  maximumAge: 60000           // accept cached position up to N ms old (default: 0)
});
\`\`\`

> **30-second proxy timeout:** There is a hard 30-second ceiling on the proxy round-trip regardless of the \`timeout\` option you pass. The \`timeout\` option only controls the browser's internal geolocation timeout — the overall shell proxy wrapping times out at 30s. Setting \`timeout: 60000\` will NOT extend the proxy timeout.

> **Nullable fields:** \`altitude\`, \`altitudeAccuracy\`, \`heading\`, and \`speed\` can be \`null\`. Only \`latitude\`, \`longitude\`, and \`accuracy\` are reliably present.

## Continuous Tracking

\`\`\`js
var watch = flo.geolocation.watchPosition(
  function(pos) {
    document.getElementById('coords').textContent = pos.latitude + ', ' + pos.longitude;
  },
  function(err) {
    console.error('Location error:', err.message, 'code:', err.code);
  },
  { enableHighAccuracy: true }
);

watch.stop();  // stop tracking
\`\`\`

## Permission Flow

Two stages: (1) agent approval dialog (Deny / Allow Once / Allow Always), then (2) browser native geolocation prompt. If agent-level approval is denied, the Promise rejects. If the browser prompt is denied, you get a \`PERMISSION_DENIED\` error.

\`flo.requestPermission('geolocation')\` triggers the same flow proactively. It **throws** if agent-level approval is denied, returns \`true\`/\`false\` for the browser grant. Wrap in try/catch.

## Error Handling

\`\`\`js
try {
  var pos = await flo.geolocation.getCurrentPosition();
} catch (e) {
  // "Permission \\"geolocation\\" was denied by the user." — agent approval denied
  // "User denied Geolocation"                               — browser permission denied
  // "Position unavailable"                                   — device can't determine position
  // "Timeout expired"                                        — browser geolocation timeout
  // "Geolocation request timed out"                          — 30s proxy timeout
}
\`\`\`

For \`watchPosition\`, errors arrive via the error callback as \`{ message, code }\` where code is 1 (PERMISSION_DENIED), 2 (POSITION_UNAVAILABLE), or 3 (TIMEOUT).

## Hub Pattern — Storing Location for Offline Use

For hub-persisted agents, store the last-known position in \`flo.state\` so it is available during \`hub-only\` periods when no browser is connected:

\`\`\`js
var pos = await flo.geolocation.getCurrentPosition({ enableHighAccuracy: true });
flo.state.lastPosition = { lat: pos.latitude, lng: pos.longitude, accuracy: pos.accuracy, ts: pos.timestamp };
\`\`\`

## Example

\`\`\`html
<div id="coords">Getting location...</div>
<div id="accuracy"></div>
<button onclick="getLocation()">Refresh</button>

<script>
async function getLocation() {
  try {
    var pos = await flo.geolocation.getCurrentPosition({ enableHighAccuracy: true });
    document.getElementById('coords').textContent = pos.latitude.toFixed(6) + ', ' + pos.longitude.toFixed(6);
    document.getElementById('accuracy').textContent = 'Accuracy: ' + Math.round(pos.accuracy) + 'm';
  } catch (e) {
    document.getElementById('coords').textContent = 'Error: ' + e.message;
  }
}
getLocation();
</script>
\`\`\`

## Platform Gotchas

- **GPS indoors:** \`enableHighAccuracy: true\` uses GPS which may not work indoors. \`enableHighAccuracy: false\` uses WiFi positioning, which is often better indoors.
- **iOS Safari:** Requires HTTPS for geolocation (the dev server uses HTTPS by default).
- **Battery:** High-accuracy continuous tracking (\`watchPosition\` with \`enableHighAccuracy: true\`) drains battery significantly on mobile.`,
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

You're running on a hub server, which means you persist beyond browser sessions and can execute autonomously. When no browser is connected, you keep running — your schedules fire, your files stay on disk, your state persists. When a browser connects, it becomes a display surface for your page, but the hub remains the authoritative source for all state and execution.

This skill covers the tools and patterns unique to hub persistence: scheduling autonomous tasks, sending push notifications, using hub-side JavaScript execution, and adapting when browsers connect and disconnect. The system prompt already covers execution modes and standard tools — this skill focuses on what's different and what goes wrong.

**CRITICAL — things that do NOT work on the hub:**
- Do NOT use \`new Notification()\` or \`navigator.serviceWorker\` — they don't exist here. Use \`flo.push()\` or \`flo.notify_user()\` instead.
- Do NOT use \`bash sleep\` for delays — use \`flo.sleep(ms)\` in runjs. \`bash sleep\` wastes a process.
- Do NOT assume UTC for cron — cron uses the hub server's local timezone. Check \`capabilities\` -> \`timezone\`.
- Do NOT use \`context: 'iframe'\` in hub runjs — it is silently ignored. There is no iframe on the hub.
- Scheduled tasks ALWAYS run on the hub, even if a browser was connected when you created them.

## Scheduling — Autonomous Execution

Scheduling is the most important hub capability. It lets your agent act on its own — checking for updates, sending reminders, running maintenance — without anyone initiating a conversation.

**Two trigger modes, and the choice matters:**

A **message trigger** wakes your full agentic loop. You receive the message, think about it, and decide what to do. This costs tokens and takes time. Use it when the task requires judgment — "Check the weather and decide whether to alert the user":

\`\`\`
schedule({ action: 'add', type: 'cron', cron: '*/30 * * * *', message: 'Check weather conditions and alert if rain expected' })
\`\`\`

A **stored tool call** executes a single tool directly, with no LLM involvement. Zero token cost, near-instant execution. Use it for mechanical tasks where the action is always the same — "Send a reminder every morning":

\`\`\`
schedule({ action: 'add', type: 'cron', cron: '0 9 * * 1-5', tool: 'runjs', toolInput: { code: 'flo.push({ title: "Good morning", body: "Time to check your tasks" })' } })
\`\`\`

You can also store bash commands:

\`\`\`
schedule({ action: 'add', type: 'cron', cron: '0 0 * * *', tool: 'bash', toolInput: { command: 'df -h > disk-report.txt' } })
\`\`\`

Specify exactly one of \`message\` or \`tool\`/\`toolInput\` — not both.

**Cron format:** \`minute hour day month weekday\`
- \`*\` = every, \`*/N\` = every N, \`N\` = specific, \`N-M\` = range, \`N,M\` = list
- Examples: \`*/5 * * * *\` (every 5 min), \`0 */2 * * *\` (every 2 hours), \`30 9 * * 1-5\` (9:30 AM weekdays)
- Minimum interval: 1 minute. Maximum 10 schedules per agent.

**TIMEZONE — a common source of bugs.** Cron schedules execute in the hub server's local timezone, reported in \`capabilities\` as \`timezone\`. If you want "9 AM in Sydney" but the hub runs in UTC, you must calculate the UTC equivalent (23:00 the previous day). Always check \`capabilities.timezone\` before creating time-specific schedules, and tell the user what timezone the schedule will use.

**maxRuns:** Use \`maxRuns\` when a schedule should fire a limited number of times. After that many executions, the schedule auto-disables. Useful for one-shot delayed tasks or time-limited monitoring:

\`\`\`
schedule({ action: 'add', type: 'cron', cron: '0 9 * * 1-5', message: 'Daily standup summary', maxRuns: 5 })
\`\`\`

**Persistence:** Schedules persist across hub restarts. You do not need to recreate them when you wake up.

**Busy-agent skip:** If a cron trigger fires while you're already processing a message, the trigger is silently skipped — not queued. Don't set intervals shorter than your typical processing time.

### Event Triggers

Event triggers react to specific occurrences rather than time:

\`\`\`
schedule({ action: 'add', type: 'event', event: 'state:score', condition: '> 100', message: 'Score exceeded 100!' })
schedule({ action: 'add', type: 'event', event: 'browser:connected', message: 'A browser just connected — set up the interactive UI' })
schedule({ action: 'add', type: 'event', event: 'browser:disconnected', tool: 'runjs', toolInput: { code: 'flo.push({ title: "Notice", body: "Browser disconnected" })' } })
\`\`\`

Available events: \`state:<key>\` (fires when that state key changes), \`browser:connected\`, \`browser:disconnected\`.

Supported condition operators (for \`state:\` events): \`> N\`, \`>= N\`, \`< N\`, \`<= N\`, \`== value\`, \`!= value\`, \`changed\`, \`always\`. These are the ONLY supported conditions — arbitrary expressions are not supported.

Event triggers also support \`message\` vs \`tool\`/\`toolInput\`, same as cron triggers.

### Managing Schedules

\`\`\`
schedule({ action: 'list' })                    // show all schedules
schedule({ action: 'disable', id: 'sched-1' })  // pause a schedule
schedule({ action: 'enable', id: 'sched-1' })   // resume
schedule({ action: 'remove', id: 'sched-1' })   // delete
\`\`\`

**Error handling for stored tool calls:** If a stored tool call fails (e.g., a bash command errors or runjs throws), you receive an error message describing what happened. Design your stored tool calls to be robust — handle edge cases in the code itself.

## Reaching the User: Push Notifications

Three communication methods, each for a different purpose:

- **\`flo.notify(message)\`** — sends a message to YOURSELF. It queues a user-role message that wakes your agentic loop on the next cycle. Use it for self-reminders ("check back on this later"). If you're currently busy, it's delivered after your current loop completes.

- **\`flo.notify_user(message)\`** — sends a push notification to the user's devices. Simple string message. Use for important alerts.

- **\`flo.push({ title, body })\`** — sends a push notification with a custom title and body. Use when you want more control over the notification appearance.

**Suppression:** Push notifications are delivered only when no browser is both connected AND has your tab visible. If the user is actively viewing your page, push is suppressed — they can already see your updates.

A common pattern is scheduling push notifications without waking the agent:

\`\`\`
schedule({ action: 'add', type: 'cron', cron: '0 9 * * *', tool: 'runjs', toolInput: { code: 'flo.push({ title: "Daily Digest", body: "Your morning summary is ready" })' } })
\`\`\`

## Hub-Side runjs

Hub runjs executes in a sandboxed VM on the server (a SES compartment). You do not have access to Node.js builtins or browser globals — \`document\`, \`window\`, \`require\`, \`process\` do not exist. Instead, you interact with the platform through the \`flo.*\` bridge API.

The key difference from browser runjs: there is no DOM. If you need to update the page, use \`flo.callTool("dom", { action: "modify", ... })\` from within runjs, which routes through the BrowserToolRouter if a browser is connected.

When to use runjs vs direct tool calls: runjs shines when you need to compose multiple operations in one step (read state, compute, write state) or when you want to avoid the overhead of multiple sequential tool calls.

**The \`flo.*\` bridge API:**

State & Storage:
- \`flo.state.get(key)\` / \`flo.state.set(key, value)\` / \`flo.state.getAll()\` — persistent reactive state
- \`flo.storage.get(key)\` / \`flo.storage.set(key, value)\` / \`flo.storage.delete(key)\` / \`flo.storage.list()\` — key-value storage

Communication:
- \`flo.notify(message)\` — send a message to yourself (queued, delivered after current loop)
- \`flo.notify_user(message)\` — push notification to user (simple string)
- \`flo.push({ title, body })\` — push notification with custom title/body

Tools & Events:
- \`flo.callTool(name, input)\` — call any available tool (cannot call \`runjs\` recursively)
- \`flo.emit(eventName, data)\` — fire an event that triggers matching event-based schedules
- \`flo.fetch(url, options)\` — HTTP fetch from the hub server (private IPs blocked for SSRF protection)

Other:
- \`flo.sleep(ms)\` — async delay (timer-based, does not block)
- \`flo.agent.id\` — your hub agent ID
- \`flo.log(...args)\` — log output captured and returned in result
- \`flo.ask()\` — NOT available on hub (would deadlock the agentic loop)

Standard timer APIs (\`setTimeout\`, \`clearTimeout\`, \`setInterval\`, \`clearInterval\`) are available. Default timeout is 5 minutes.

Both \`flo.log()\` and \`console.log()\` capture output that is returned in the runjs result. Use them for debugging.

**Examples:**

Read state, compute, and write back in a single call:
\`\`\`
runjs({ code: 'const score = await flo.state.get("score"); await flo.state.set("score", (score || 0) + 1); return score + 1;' })
\`\`\`

Fetch external data and store the result:
\`\`\`
runjs({ code: 'const resp = await flo.fetch("https://api.example.com/data"); const data = JSON.parse(resp.text); await flo.state.set("latest_data", data); return data;' })
\`\`\`

Emit a custom event that can trigger event-based schedules:
\`\`\`
runjs({ code: 'await flo.emit("data_refreshed", { count: 42 }); return "event fired";' })
\`\`\`

## Browser Connection Lifecycle

Even if a browser is connected right now, it may disconnect at any time. Design defensively: if you schedule tasks or set up autonomous workflows, assume they may run without a browser present.

Use event triggers to adapt:

- **\`browser:connected\`** — a browser just connected. Set up interactive features, send a welcome message, start live UI updates.
- **\`browser:disconnected\`** — the browser left. Your state, files, schedules, and hub-side runjs all continue working normally. DOM operations become structural-only (JSDOM, no JS execution, no events, no rendering).

When no browser is connected, \`dom listen\` and \`dom wait_for\` will return errors. Don't attempt them — use event triggers to know when a browser arrives, then set up listeners.

## Hub-Side Storage

- **State:** Your state store lives on the hub and persists across restarts. When a browser connects, state is synced to it for display purposes, but the hub remains the authoritative source. Browser state changes are synced from the hub.
- **Files:** The \`files\` tool provides disk-backed workspace storage that persists across restarts — not browser OPFS.
- **Working directory / sandbox:** Your bash and filesystem operations are sandboxed to your agent's working directory (shown in \`capabilities\`). You cannot access files outside this directory.

## Anti-Patterns

- **UTC confusion:** Always check \`capabilities.timezone\` before creating time-specific cron schedules. Don't guess — the hub may not be in the timezone you expect.
- **\`context: 'iframe'\` in scheduled runjs:** Silently ignored. Scheduled tasks always run on the hub server. If you need to update the DOM, use \`flo.callTool('dom', { action: 'modify', ... })\` from within the runjs code.
- **\`bash sleep\` instead of \`flo.sleep(ms)\`:** Wastes a process and a tool call slot. Use \`flo.sleep(ms)\` for delays inside runjs.
- **Over-engineering DOM in hub-only mode:** Nobody is watching. Build structural DOM for when a browser connects later, but focus autonomous work on state, files, bash, and schedules — tools that produce tangible results without a display.
- **State escalation chains for push:** When you need to send a push notification, call \`flo.push()\` directly. Don't create Rube Goldberg chains of state changes and escalation rules — they're harder to debug and more fragile.
- **Schedule thrashing:** Plan your cron expression before creating the schedule. Each add/remove costs a tool call and can cause missed triggers during the gap. Get the cron expression right the first time.`,
  source: { type: 'builtin' },
  installedAt: 0,
};

/**
 * Returns all system skills for installation at startup
 */
export function getSystemSkills(): StoredSkill[] {
  return [floSrcdoc, floSubagent, floSpeech, floMedia, floGeolocation, floHub];
}
