# Bidirectional Interactions

How agents and users interact in real-time through the UI in [flo.monster](https://flo.monster).

Of course, your agents can just create this for you if you ask them.

## Beyond Chat

[flo.monster](https://flo.monster) agents do not just respond to chat messages. They build interactive web UIs and respond to user actions within them. A user might click a button, submit a form, drag an element, or trigger a custom event — and the agent sees it and reacts. This creates a bidirectional loop: the agent builds the interface, the user interacts with it, and the agent responds.

## The flo API

Every agent page has access to the `flo` API — a JavaScript API available globally in `<script>` tags within the agent's iframe. It bridges the page and the agent runtime.

### Communication

| Method | Description |
|--------|-------------|
| `flo.notify(event, data)` | Fire-and-forget message to the agent. Does not wait for a response. |
| `flo.ask(event, data)` | Request-response from the agent. Returns a Promise that resolves when the agent responds (30-second timeout). |

### Tool Access from Page JavaScript

| Method | Description |
|--------|-------------|
| `flo.callTool(name, input, options?)` | Call any agent tool from page JS. Returns a Promise. Options: `{ timeout: ms }` (default 30s). |

### Reactive State

| Method | Description |
|--------|-------------|
| `flo.state.get(key)` | Read a state value (synchronous, from cache) |
| `flo.state.set(key, value)` | Write a state value (visible to both agent and page JS) |
| `flo.state.getAll()` | Read all state as a key-value object |
| `flo.state.onChange(keyOrPattern, callback)` | Subscribe to state changes; supports wildcards like `'player.*'` |

See [Storage and State](Storage-And-State.md) for the full `flo.state` reference.

### Media and Sensors

| Method | Description |
|--------|-------------|
| `flo.speech.listen(options?)` | Voice input — returns a session object for speech-to-text |
| `flo.speech.speak(text, options?)` | Voice output — text-to-speech, returns a Promise |
| `flo.getCamera()` | Camera video stream (proxied from the shell via WebRTC) |
| `flo.getMicrophone()` | Microphone audio stream |
| `flo.getMediaStream(constraints)` | Combined or custom media stream |
| `flo.geolocation.getCurrentPosition(options?)` | One-shot location |
| `flo.geolocation.watchPosition(callback, error?, options?)` | Continuous location tracking |

## DOM Events — Agent Responds to User Actions

The most common interaction pattern: the agent registers event listeners on page elements, and when users interact, the agent receives the event and responds.

### How It Works

1. Agent registers an event listener via the `dom` tool:

```javascript
dom({ action: 'listen', selector: '#add-btn', events: ['click'] })
```

2. User clicks the button.

3. The event wakes the agent — a new turn begins. The agent sees what happened:

```
Event: click on #add-btn
```

4. Agent processes the action and updates the UI:

```javascript
dom({ action: 'modify', selector: '#items', innerHTML: '<li>New item</li>' })
```

### Blocking Wait

The agent can also block until a specific event fires:

```javascript
dom({ action: 'wait_for', selector: '#submit', event: 'click', timeout: 30000 })
// Returns event data when the user clicks, including form data for submit events
```

## Page Events — JavaScript Talks to the Agent

Page JavaScript can communicate with the agent directly using the flo API. This enables richer interaction patterns where the page handles routine logic and only involves the agent when needed.

### flo.notify — Fire and Forget

```javascript
// In a <script> tag on the page
document.getElementById('colour-picker').addEventListener('change', function(e) {
  flo.notify('colour-changed', { colour: e.target.value });
});
```

The agent receives a notification and can act on it.

### flo.ask — Request a Response

```javascript
// Page JS asks the agent a question and waits for the answer
var suggestion = await flo.ask('suggest-colour', {
  currentPalette: ['#ff0000', '#00ff00'],
  mood: 'calm'
});
// suggestion contains the agent's response
document.getElementById('result').textContent = suggestion;
```

The agent receives the request, processes it, and sends a response back via the `agent_respond` tool.

### flo.callTool — Trigger Tool Use

Page JavaScript can call any agent tool directly:

```javascript
// Spawn a subagent from page JS
var result = await flo.callTool('subagent', {
  task: 'Generate a colour palette for a nature theme'
}, { timeout: 300000 });
```

This creates a new subagent and passes them a turn for processing. The tool executes and returns the result to the page JavaScript.

## The Architect-Subagents Pattern

For efficient event handling, the recommended pattern separates the main agent (the architect) from lightweight subagents:

1. **Main agent builds the UI**, sets up `flo.state`, and finishes processing. Once idle, it costs zero tokens.

2. **Page JavaScript handles user input** directly using `flo.state.onChange` and DOM event handlers.

3. **For decisions that need AI**, page JS spawns a subagent:

```javascript
var result = await flo.callTool('subagent', {
  task: 'Categorise this expense: "Coffee at Blue Bottle, $4.50"'
}, { timeout: 300000 });
```

4. **Subagents handle routine tasks** at roughly 200 tokens each (versus 2000+ for waking the main agent).

5. **Main agent only wakes for escalations** — significant state changes that need complex decision-making.

This pattern dramatically reduces token cost and latency. See [Storage and State](Storage-And-State.md) for escalation rules.

## flo.ask() Deep Dive

`flo.ask()` is the primary way page JavaScript requests input from the agent. It returns a Promise that resolves when the agent responds.

### Simple Question

```javascript
var answer = await flo.ask('preference', {
  question: 'What colour scheme do you prefer for this dashboard?'
});
// answer contains the agent's response
```

### With Structured Data

```javascript
var analysis = await flo.ask('analyse-data', {
  dataset: chartData,
  question: 'What trends do you see?'
});
document.getElementById('analysis').textContent = analysis;
```

### How It Works Under the Hood

1. Page JS calls `flo.ask(event, data)`.
2. The agent receives the request as a new turn.
3. The agent processes the request (may use tools, call the LLM, etc.).
4. The agent responds using the `agent_respond` tool.
5. The Promise in page JS resolves with the response.
6. 30-second timeout — if the agent does not respond in time, the Promise rejects.

## Escalation Rules

`flo.state` supports escalation rules — conditions that automatically wake the agent when met. This eliminates the need for polling.

```javascript
// Page JS sets up an escalation rule
flo.state.escalate('todos', 'val > 10', 'Todo list is getting long — time to prioritise');
```

When the condition is met, the agent receives a `state_escalation` notification with the key, current value, message, and a full state snapshot. The agent can then take action.

See [Storage and State](Storage-And-State.md) for the full escalation API.

## Putting It Together

A typical interactive agent follows this flow:

1. **Agent creates the page** with `dom create`, including `<script>` tags for interactivity.
2. **Agent sets up `flo.state`** with initial values and escalation rules.
3. **Agent finishes processing** — now idle, zero token cost.
4. **User interacts** with the page. Page JS handles routine events.
5. **Page JS spawns subagents** for AI-powered tasks (categorisation, generation, analysis).
6. **Subagents update `flo.state`** — page JS reacts via `onChange` callbacks, updating the UI.
7. **Escalation fires** when a significant threshold is reached — main agent wakes to handle it.
8. **Cycle repeats.**

## Related Guides

- [Web UI](Web-UI.md) — How agents create and control their page
- [Storage and State](Storage-And-State.md) — Persistence, reactive state, and escalation rules
- [Getting Started](Getting-Started.md) — First steps with [flo.monster](https://flo.monster) 
