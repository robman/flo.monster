# Architecture

An overview of how [flo.monster](https://flo.monster)'s components fit together — from browser shell to agent sandbox to optional hub.

## Overview

[flo.monster](https://flo.monster) has three layers:

1. **Browser Shell** — The orchestrator. Manages agent lifecycles, enforces security, hosts the Service Worker, and provides the UI.
2. **Agent Sandbox** — One or more sandboxed iframes, each containing a living skin (DOM surface) and a Web Worker running the agentic loop.
3. **Hub** (optional) — A WebSocket server providing persistence, system tools (bash, filesystem), and multi-browser coordination.

Each layer has a clear responsibility boundary. The shell never executes agent code. Agents never access shell resources directly. The hub never trusts the browser's state for persisted agents.

```
┌─────────────────────────────────────────────────────────┐
│                      Browser Tab                         │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │                 Shell (orchestrator)                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │  │
│  │  │ Service  │  │Dashboard │  │  Message Relay   │  │  │
│  │  │ Worker   │  │   UI     │  │  (fetch, speech, │  │  │
│  │  │          │  │          │  │   media, tools)  │  │  │
│  │  └──────────┘  └──────────┘  └─────────────────┘  │  │
│  └────────────────────────────────────────────────────┘  │
│         ▲ postMessage  │  postMessage ▼                  │
│  ┌──────┴──────┐  ┌────┴───────┐  ┌──────────────────┐  │
│  │  Agent 1    │  │  Agent 2   │  │  Agent N ...     │  │
│  │  (iframe)   │  │  (iframe)  │  │  (iframe)        │  │
│  │ ┌────────┐  │  │ ┌────────┐ │  │ ┌────────┐      │  │
│  │ │ Worker │  │  │ │ Worker │ │  │ │ Worker │      │  │
│  │ └────────┘  │  │ └────────┘ │  │ └────────┘      │  │
│  └─────────────┘  └────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
           │ WebSocket (optional)
           ▼
┌─────────────────────┐
│        Hub           │
│  ┌───────────────┐  │
│  │ Agent Runner   │  │
│  │ (persistence,  │  │
│  │  system tools, │  │
│  │  scheduling)   │  │
│  └───────────────┘  │
└─────────────────────┘
```

## Browser Architecture

### Shell

The shell is the main page that orchestrates everything. It never executes agent code directly — all agent logic runs inside sandboxed iframes and their workers.

Key components:

| Component | Responsibility |
|-----------|---------------|
| **UIManager** | Agent cards, settings panel, notification centre, view state management |
| **LifecycleManager** | Create, start, stop, pause, resume, destroy agents. Manages iframe and worker setup. |
| **CredentialsManager** | API key encryption (AES-GCM + PBKDF2 via Web Crypto), storage in IndexedDB, per-provider key management |
| **Message Relay** | Routes postMessage traffic between shell and agents. Handles fetch proxying, speech/media relay, tool call routing, network policy enforcement. |
| **ToolPluginRegistry** | Manages shell-side tool plugins (subagent, web_fetch, web_search, context_search, skills) |
| **HubClient** | WebSocket connection to hub, message serialisation, reconnection with exponential backoff |

### Service Worker

The Service Worker sits between agents and the network. It has two primary jobs:

**API key injection:** When an agent's Web Worker calls `fetch('/api/v1/messages')`, the Service Worker intercepts the request (URL-level interception works regardless of the iframe's opaque origin), looks up the agent's provider configuration, and injects the appropriate authentication header (`x-api-key` for Anthropic, `Authorization: Bearer` for OpenAI/Gemini). The agent never sees the key.

**Caching and offline support:** The Service Worker maintains a precache manifest for shell assets and handles cache-first strategies for static resources. It also handles push notification events for hub-persisted agents.

```
Agent Worker
└── fetch('/api/v1/messages')
          │
          ▼  (URL-level interception)
    Service Worker (shell origin, scope: /)
          │
          ├── Look up agent's provider config
          ├── Translate request via provider adapter
          ├── Inject per-provider auth header
          └── Make real fetch to provider API
          │
          ▼
    Streaming response back to Worker
```

**Two fetch paths exist:**

| Path | Handler | Purpose |
|------|---------|---------|
| `/api/*` | Service Worker | API key injection, streams response directly |
| Everything else | Message Relay | Network policy enforcement, header sanitisation, hub proxy routing |

Non-API fetches go through the message relay (`fetch_request` postMessage). The relay validates against the agent's network policy (allowlist/blocklist), strips sensitive headers (`x-api-key`, `authorization`, `cookie`), and optionally routes through the hub to bypass CORS.

### Agent Container

Each agent lives in a sandboxed iframe:

```html
<iframe sandbox="allow-scripts allow-forms" srcdoc="..."></iframe>
```

The `sandbox` attribute without `allow-same-origin` creates an **opaque origin** — the strongest isolation available in the browser without additional infrastructure. The agent's iframe cannot access the shell's DOM, cookies, localStorage, IndexedDB, or Service Worker registrations.

Inside the iframe:

```
Agent iframe (opaque origin)
│
├── Bootstrap IIFE
│   ├── flo API (flo.state, flo.notify, flo.ask, flo.speech)
│   ├── postMessage relay (iframe ↔ shell)
│   └── DOM command handler (executes dom tool operations)
│
├── Living Skin (agent-controlled DOM)
│   └── Whatever the agent creates: forms, games, dashboards, visualisations
│
└── Web Worker (agentic loop)
    ├── Agentic loop (API call → parse → tool → loop)
    ├── Tool handlers (dom, fetch, storage, files, runjs, state, capabilities)
    └── Subagent workers (child agents, inherit permissions)
```

The **bootstrap IIFE** is automatically injected into every agent iframe. It provides the `flo` API for page-level JavaScript, sets up the postMessage relay between the iframe and shell, and handles DOM commands from the worker. Templates cannot disable or bypass the bootstrap.

### Dashboard

The dashboard provides the user interface for managing agents:

- **Agent cards** — Each agent appears as a card showing its name, status, and cost. Cards support four view states: minimised (`min`), full view (`max`), UI-only (`ui-only`), and chat-only (`chat-only`).
- **Settings panel** — API key management, hub connection, global preferences, notification configuration.
- **Notification panel** — Push notification history and management.

## Agent Sandbox

### How Iframes Work

Each agent iframe has an **opaque origin** — a unique, unguessable origin that shares nothing with the shell or other agents. This means:

- No access to `document.cookie`, `localStorage`, or `indexedDB` of the shell
- No access to the shell's DOM or any other iframe's DOM
- No ability to register Service Workers
- No ability to read or write the shell's clipboard
- `postMessage` is the only communication channel

The agent has full power within this sandbox: arbitrary JavaScript execution, DOM manipulation, CSS styling, canvas drawing, WebGL, Web Audio, and more. Security comes from containment, not restriction.

### Worker Lifecycle

Each agent's Web Worker follows this lifecycle:

```
         create
           │
           ▼
    ┌─────────────┐
    │   PENDING    │  (iframe + worker being initialised)
    └──────┬──────┘
           │
           ▼
    ┌─────────────┐
    │   RUNNING    │  (agentic loop active)
    └──────┬──────┘
           │
    ┌──────┼──────┐
    ▼      ▼      ▼
 PAUSED   IDLE   ERROR
    │      │      │
    └──────┴──────┘
           │
           ▼
    RUNNING (resume)
           │
           ▼
      DESTROYED
```

The worker runs the **agentic loop**: call the LLM API, parse the response, execute any tool calls, and loop until the model returns an `end_turn` stop reason. Between turns, the worker is idle — it consumes no resources until the next user message or event triggers a new loop iteration.

### The Agentic Loop

The agentic loop is shared code from `@flo-monster/core`, running identically in browser workers and on the hub:

```
User message
     │
     ▼
┌─────────────┐
│  Assemble   │  ← Context assembly: overview + terse log
│  Context    │    (not full conversation — optimised for token usage)
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Call LLM   │  ← Provider adapter translates to wire format
│  API        │    (Anthropic, OpenAI, Gemini, Ollama)
└──────┬──────┘
       │
       ▼
┌─────────────┐     ┌──────────────┐
│  Parse      │────▶│  Text block  │──▶ Render to conversation view
│  Response   │     └──────────────┘
│  (stream)   │     ┌──────────────┐
│             │────▶│  Tool use    │──▶ Execute tool, get result, LOOP
└─────────────┘     └──────────────┘
       │
       ▼ (end_turn)
┌─────────────┐
│  Post-turn  │  ← Generate terse summary, update state
│  Cleanup    │
└─────────────┘
```

### Message Format

Messages use Anthropic's format internally, with provider adapters handling translation:

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
```

## Message Flow

Here is the complete path of a user message through the system, from keystroke to DOM update.

### Browser-Only Agent

```
1. User types message in chat input
2. Shell creates user Message and passes to agent iframe via postMessage
3. Iframe relays to Web Worker
4. Worker assembles context (overview + terse log + new message)
5. Worker calls fetch('/api/v1/messages') with assembled context
6. Service Worker intercepts:
   a. Looks up provider config for this agent
   b. Provider adapter translates request format
   c. Injects API key header
   d. Makes real fetch to provider API
7. Streaming response flows back: SW → Worker
8. Worker parses SSE stream into content blocks:
   - Text blocks → posted to iframe for rendering
   - Tool use blocks → execute tool:

     Tool execution (e.g., dom tool):
     a. Worker sends dom_command via postMessage to iframe
     b. Iframe bootstrap executes DOM operation
     c. Result posted back as dom_result
     d. Worker packages result as tool_result

   - Loop: go to step 4 with tool results appended
   - end_turn: post final state to iframe + shell

9. Shell updates agent card status, cost display
10. Worker generates terse summary, persists context
```

### Hub-Persisted Agent

```
1. User types message in browser
2. Browser sends 'send_message' via WebSocket to hub
3. Hub's HeadlessAgentRunner receives the message
4. Hub assembles context and calls LLM API (using hub's API keys)
5. Hub executes tools:
   - Hub-direct tools: bash, filesystem, state, storage, schedule
     → Execute immediately on hub
   - Browser-routed tools: dom, runjs, view_state
     → Hub sends tool request to connected browser via WebSocket
     → Browser's passive worker executes in iframe
     → Result sent back to hub via WebSocket
6. Hub streams 'agent_loop_event' to all subscribed browsers
7. ConversationView in each browser renders events (same code as local agents)
8. Hub persists updated conversation and state to disk
```

### Tool Routing

Tools execute in different contexts depending on their type:

```
API Response: tool_use { name: 'dom', input: {...} }
                    │
                    ▼
    Agentic Loop: deps.executeToolCall('dom', input)
                    │
                    ▼
    Worker sends postMessage to iframe
    { type: 'tool_execute', name: 'dom', ... }
                    │
                    ▼
    Iframe relays to Shell (message-relay.ts)
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  Builtin Tool            Plugin Tool
  (dom, fetch,            (subagent, web_fetch,
   storage, files)         web_search, skills)
        │                       │
        ▼                       ▼
  Routes to iframe        Shell executes via
  for DOM ops             ToolPluginRegistry
        │                       │
        └───────────┬───────────┘
                    ▼
              ToolResult → Loop continues
```

| Tool Type | Registry | Execution Context | Examples |
|-----------|----------|-------------------|----------|
| **Builtin** | Worker's tool map | Worker ↔ iframe via postMessage | dom, fetch, storage, files, runjs, state, capabilities |
| **Plugin** | Shell's ToolPluginRegistry | Shell context | subagent, web_fetch, web_search, context_search, list_skills, get_skill |
| **Hub** | Hub server | Node.js process | bash, filesystem, schedule |

## Hub Architecture

The hub is an optional Node.js server that extends agents with persistence, system tools, and multi-browser coordination.

```
┌──────────────────────────────────────────────────┐
│                    Hub Server                      │
│                                                    │
│  ┌────────────────┐  ┌─────────────────────────┐  │
│  │ WebSocket       │  │ HTTP API                │  │
│  │ Server          │  │ POST /api/v1/messages   │  │
│  │ (real-time)     │  │ (LLM proxy)             │  │
│  └───────┬────────┘  └─────────────────────────┘  │
│          │                                         │
│  ┌───────┴────────────────────────────────────┐   │
│  │           Agent Management                  │   │
│  │                                             │   │
│  │  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │HeadlessAgentRunner│  │ AgentStore     │  │   │
│  │  │(agentic loop for  │  │(disk persist:  │  │   │
│  │  │ persisted agents) │  │ session.json,  │  │   │
│  │  └──────────────────┘  │ state.json)    │  │   │
│  │                         └────────────────┘  │   │
│  │  ┌──────────────────┐  ┌────────────────┐  │   │
│  │  │BrowserToolRouter │  │ Scheduler      │  │   │
│  │  │(routes dom/runjs  │  │(cron triggers, │  │   │
│  │  │ to browsers)      │  │ event rules)   │  │   │
│  │  └──────────────────┘  └────────────────┘  │   │
│  └─────────────────────────────────────────────┘  │
│                                                    │
│  ┌─────────────────────────────────────────────┐  │
│  │           System Tools                       │  │
│  │  bash, filesystem, fetch proxy, state,       │  │
│  │  storage, schedule, skills                   │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### WebSocket Server

The hub communicates with browsers over WebSocket. Each connection authenticates (via shared token or per-agent credentials) and then subscribes to specific agents. Messages flow bidirectionally:

- **Browser → Hub:** `send_message`, `browser_tool_result`, `skill_approval_response`, `state_write_through`, `dom_state_update`
- **Hub → Browser:** `agent_loop_event`, `browser_tool_request`, `skill_approval_request`, state/storage updates

Rate limiting (100 messages/second per client) and pre-authentication message gating prevent abuse.

### Agent Persistence

When an agent persists to the hub:

1. Browser serialises agent state (conversation, config, files, state)
2. Browser sends persist request via WebSocket, including the decrypted API key (TLS required)
3. Hub creates an `AgentStore` directory: `~/.flo-monster/agents/{id}/`
4. Hub stores `session.json` (conversation, config) and `state.json` (reactive state) with `0o600` permissions
5. Hub creates a `HeadlessAgentRunner` — the agentic loop now runs on the hub
6. Browser's worker enters **passive mode** (alive for tool execution, but no local agentic loop)

### Multi-Browser Coordination

A hub-persisted agent can have multiple browsers connected simultaneously. Each browser is an "arm" with its own display and sensors:

```
                    ┌─────────┐
        ┌──────────▶│Browser 1│ (laptop — full keyboard, large screen)
        │           └─────────┘
┌───────┤
│  Hub  │           ┌─────────┐
│ Agent ├──────────▶│Browser 2│ (phone — camera, GPS, touch)
│       │           └─────────┘
└───────┤
        │           ┌─────────┐
        └──────────▶│Browser 3│ (tablet — stylus, medium screen)
                    └─────────┘
```

The hub routes browser-requiring tools (dom, runjs) to connected browsers. When multiple browsers are connected, the hub selects the most appropriate one (or the first available). Agents are notified when browsers connect/disconnect so they can adapt their behaviour.

## Hub-as-Authority

When an agent is persisted to a hub, the hub becomes the **single source of truth**. This is a deliberate design choice to avoid split-brain state conflicts.

### The Model

| Aspect | Browser-Only Agent | Hub-Persisted Agent |
|--------|-------------------|---------------------|
| **Agentic loop** | Runs in browser worker | Runs on hub |
| **State authority** | Browser | Hub |
| **Conversation storage** | Browser (IndexedDB + OPFS) | Hub (disk) |
| **Tool execution** | Browser worker + shell | Hub + browser (for DOM tools) |
| **Offline behaviour** | Fully functional | Not usable — shows "Hub Offline", retries |
| **Browser role** | Full autonomy | Display surface + tool executor |

### Why No Local Fallback?

When a hub-persisted agent's hub is unreachable, the browser does **not** fall back to running the agent locally. This prevents:

- **Split-brain state** — Two copies of the agent running independently, diverging in conversation and state
- **Conflicting tool execution** — Browser and hub both executing tools, producing inconsistent results
- **State reconciliation nightmares** — Merging diverged conversation histories is unsolvable in the general case

Instead, the browser shows a "Hub Offline" indicator and retries with exponential backoff. When the hub comes back, everything resumes exactly where it left off.

### Worker Passive Mode

When an agent is hub-persisted, the browser's Web Worker stays alive but enters passive mode:

- The worker does **not** run an agentic loop
- Worker-emitted `state_change` events are filtered out — only hub state updates are authoritative
- The worker handles `browser_tool_request` messages from the hub (executing dom, runjs, etc. in the iframe)
- The iframe remains the rendering surface for the agent's living skin

This is controlled by a `hubMode` flag. When active, page events (`flo.notify`, `flo.ask`, `dom_event`) route to the hub via WebSocket instead of triggering a local agentic loop.

### Execution Modes

Agents can discover their security context via the `capabilities` tool, which returns an `executionMode` field:

| Mode | Description |
|------|-------------|
| `browser-only` | Browser agent, no hub connection. No hub tools available. |
| `browser-with-hub` | Browser agent with hub connected. Has hub tools. Browser is authority. |
| `hub-with-browser` | Hub-persisted agent with browser connected. Hub is authority. Browser provides DOM. |
| `hub-only` | Hub-persisted agent, no browser. Structural DOM only (JSDOM). No browser-routed tools. |

## Isomorphic Core

The browser and hub both run JavaScript, so significant code is shared in `@flo-monster/core`:

| Module | Purpose |
|--------|---------|
| **Agentic loop** | API call → parse response → dispatch tool → loop |
| **Provider adapters** | Translate internal format ↔ provider wire formats (Anthropic, OpenAI, Gemini, Ollama) |
| **SSE stream parser** | Parse `text/event-stream` into structured events |
| **Tool registry** | Register, validate, dispatch (implementations injected per environment) |
| **Session serialiser** | Serialise/deserialise full agent state for persistence and handoff |
| **Cost tracker** | Token usage and cost calculation per agent |

This matters because:

1. **Agent handoff works** — Browser serialises agent, hub deserialises with the same code. Guaranteed compatible.
2. **Single source of truth** — Agentic loop logic is not duplicated.
3. **Extensions can be portable** — Tools using only `context.fetch` and `context.storage` run identically on either side.

## Reactive State

`flo.state` provides a reactive state layer inside the agent sandbox. It bridges the gap between agent logic (in the worker) and page JavaScript (in the iframe).

### How It Works

Page JavaScript reads and writes state synchronously via `flo.state`:

```javascript
// Page JS (inside agent's iframe)
flo.state.set('score', 42);
flo.state.get('score'); // 42
flo.state.onChange('score', (value) => {
  document.getElementById('score').textContent = value;
});
```

The agent (via its worker) can also read/write state through the `state` tool. Changes from either side are synchronised — the page sees agent state updates, and the agent sees page state updates.

### Escalation Rules

Agents can set conditions that trigger notifications when state changes meet criteria:

```
Agent sets rule: notify when state.score > 100
Page JS updates: flo.state.set('score', 105)
→ state_escalation event fires → agent receives notification → new agentic loop turn
```

Escalation conditions use a safe declarative evaluator supporting only comparison operators (`>`, `>=`, `<`, `<=`, `==`, `!=`) and keywords (`always`, `changed`). No `eval()` or `new Function()` — ever.

### Persistence

State persists via the existing storage mechanism (debounced writes to IndexedDB in browser, disk on hub). State and escalation rules are restored on agent initialisation.

## Speech and Media Proxying

Sandboxed opaque-origin iframes cannot use the Web Speech API or `getUserMedia()` directly (especially on iOS Safari). The shell proxies these capabilities through postMessage relays.

### Speech (STT/TTS)

The `flo.speech` API in the iframe bootstrap relays recognition and synthesis requests through the shell:

```
Agent iframe                        Shell
    │                                  │
    ├── flo.speech.listen() ──────▶ │
    │                                  ├── SpeechRecognition (shell context)
    │   ◀── transcript result ─────── │
    │                                  │
    ├── flo.speech.speak("Hello") ───▶ │
    │                                  ├── speechSynthesis.speak() (shell context)
    │   ◀── completion event ──────── │
```

The shell runs `SpeechRecognition` and `speechSynthesis` in its own context (where these APIs are available), and relays results back to the iframe via postMessage.

### Media (Camera/Mic)

Direct `getUserMedia()` fails in sandboxed srcdoc iframes on iOS Safari. [flo.monster](https://flo.monster) uses a WebRTC loopback pattern:

```
Shell                                  Agent iframe
  │                                        │
  ├── getUserMedia() (shell context)       │
  ├── Create RTCPeerConnection             │
  ├── Add media tracks                     │
  ├── Send SDP offer via postMessage ────▶ │
  │                                        ├── Create RTCPeerConnection
  │   ◀── SDP answer ──────────────────── ├── Accept offer
  │                                        ├── ontrack → receive stream
  ├── ICE candidate exchange ◀───────────▶ ├── ICE candidate exchange
  │                                        │
  │                                        ├── <video srcObject={stream}>
```

The shell captures media via `getUserMedia()`, publishes it over an `RTCPeerConnection` loopback, and the iframe receives the remote stream via `ontrack`. This works even in sandboxed srcdoc iframes on iOS Safari where direct media access is impossible.

## System Skills

Agents discover detailed guidance through a skill system rather than receiving it all in the system prompt upfront.

### Design

The system prompt is kept slim (~20 lines of essentials). Detailed guidance is delegated to skills that agents load on demand:

```
Agent calls list_skills → sees available skills
Agent calls get_skill('flo-cookbook') → receives detailed patterns and recipes
```

### Built-In Skills

| Skill | Purpose |
|-------|---------|
| `flo-cookbook` | Common patterns: state management, forms, responsive layouts |
| `flo-srcdoc` | Save/load UI snapshots as .srcdoc files, multi-skin management |
| `flo-subagent` | Spawning subagents: configuration, communication, lifecycle |
| `flo-speech` | Speech recognition and synthesis: API usage, iOS Safari quirks |
| `flo-media` | Camera/microphone: WebRTC media proxy, video/audio capture |
| `flo-geolocation` | Location services: getCurrentPosition, watchPosition |
| `flo-hub` | Hub persistence, scheduling, autonomous execution |

Certain capabilities require the agent to load the corresponding skill first. The system prompt instructs agents to load `flo-media` before using camera/microphone, `flo-speech` before using speech, and `flo-subagent` before spawning subagents.

### Capability-Gated Skills

Skills can declare `requiredCapabilities` in their manifest (e.g., `['hub']`). Both browser and hub validate these requirements before returning skill content. A browser-only agent cannot load a skill that requires hub persistence.

## Cost Tracking

[flo.monster](https://flo.monster) tracks token usage and cost per agent in real time:

- **Per-agent budgets** — Cap spend automatically. When the budget is exhausted, the agent pauses.
- **Confirmation thresholds** — Warn before expensive operations.
- **Global spend cap** — Hard limit across all agents.
- **Status bar display** — Real-time token usage and cost visible in the agent card.

Cost tracking uses the shared `@flo-monster/core` cost module, which calculates costs based on provider-specific pricing and actual token counts from API responses.

## Context Management

[flo.monster](https://flo.monster) optimises API context to minimise token usage:

- **Slim context assembly** — The API receives an overview document plus a terse turn-by-turn log, not the full conversation history
- **Full history preserved** — Complete conversation saved to `context.json` in agent OPFS (browser) or disk (hub)
- **`context_search` tool** — Agents can search their full history on demand (keyword, turn range, head mode) when they need older context
- **Terse summaries** — After each turn, a one-line summary is appended to the terse log. Keeps the context window manageable even for long-running agents.
- **System skills** — Detailed guidance loaded on demand via `list_skills` / `get_skill` rather than consuming context upfront. Seven built-in skills cover common patterns, UI snapshots, subagents, speech, media, geolocation, and hub features.

## Multi-Provider Support

[flo.monster](https://flo.monster) supports multiple LLM providers through isomorphic adapters in `@flo-monster/core`:

| Provider | Auth Method | Configuration |
|----------|-------------|---------------|
| **Anthropic** (Claude) | API key (`x-api-key` header) | Browser UI or hub config |
| **OpenAI** | API key (`Authorization: Bearer` header) | Browser UI or hub config |
| **Google Gemini** | API key (`Authorization: Bearer` header) | Browser UI or hub config |
| **Ollama** (local) | None (endpoint-based) | Hub config (`hub.json`) or CORS proxy |

Provider adapters handle the translation between [flo.monster](https://flo.monster)'s internal Anthropic-style message format and each provider's wire format. Agents are unaware of which provider they're using — the adapter layer is transparent.

## Key Design Decisions

### Why Opaque-Origin Iframes?

The `sandbox` attribute without `allow-same-origin` is the strongest isolation boundary available in the browser. It prevents agents from accessing the shell's storage, cookies, DOM, or Service Worker registrations — without requiring a separate domain, server infrastructure, or browser extension. The tradeoff is that agents cannot use some browser APIs (like `localStorage` directly), but [flo.monster](https://flo.monster) provides equivalent capabilities through its tool layer.

### Why Web Workers?

The agentic loop involves waiting for streaming API responses and executing tools — potentially long-running operations that would block the main thread. Web Workers keep the iframe's UI responsive while the loop runs. They also provide a clean separation: the worker handles logic, the iframe handles rendering.

### Why postMessage Chains?

In a sandboxed opaque-origin iframe, `postMessage` is the only communication channel available. [flo.monster](https://flo.monster) embraces this constraint: all shell-agent communication flows through structured postMessage exchanges with source verification. This creates a natural audit point — every message crossing the boundary is typed, validated, and routable.

### Why Not WebAssembly?

WebAssembly would provide faster execution for compute-heavy tasks, but [flo.monster](https://flo.monster) agents are I/O-bound (waiting for API responses, DOM updates, network requests). The overhead of JavaScript execution is negligible compared to API latency. Web Workers already provide non-blocking execution. WASM could be useful for specific agent workloads (e.g., on-device ML inference) but isn't needed for the core architecture.

### Why Hub-as-Authority?

Distributed state is hard. When a hub-persisted agent could run independently in both browser and hub, state reconciliation becomes unsolvable in the general case (conversation histories can diverge, tool side effects can conflict). By making the hub the single authority, we trade offline availability for correctness. This is the right tradeoff for agents that manage real state and execute real tools.

## Package Structure

```
packages/
├── core/           @flo-monster/core (isomorphic)
│   └── src/
│       ├── types/          Message types, shared interfaces
│       ├── adapters/       Provider adapters (Anthropic, OpenAI, Gemini, Ollama)
│       ├── loop/           Agentic loop
│       ├── tools/          Tool registry
│       ├── stream/         SSE parser
│       └── cost/           Token/cost tracking
│
├── browser/        @flo-monster/browser
│   └── src/
│       ├── shell/          UI, Service Worker, OAuth
│       ├── agent/          Iframe manager, Worker bootstrap
│       ├── tools/          Browser API tools (DOM, Fetch, Storage, Files)
│       └── storage/        IndexedDB adapter
│
├── hub/            @flo-monster/hub
│   └── src/
│       ├── server/         WebSocket server, HTTP API
│       ├── tools/          Bash, filesystem, scheduling
│       └── persistence/    Disk storage, agent store
│
└── proxy/          @flo-monster/proxy
    └── src/                Dev CORS proxy
```

## Further Reading

- [Security.md](Security.md) — Security model, sandbox invariants, threat mitigations
- [README.md](README.md) — Project overview and quick start
