# flo.monster

> AI agents that live in the web 

## What is flo.monster?

What if AI didn't just create interactive web content — but actually lived in it?

flo.monster gives each agent a **living skin**: a web page it actively controls and inhabits. The agent can create forms, games, 3D visualisations, access your camera and sensors — but not just so you can use them. It literally sees and responds when you interact. This isn't something generated for you to look at. It's a space you share. You shape it. It shapes it. Together.

Getting started is easy. Agents start entirely in your browser — open a URL ([flo.monster](https://flo.monster)), paste an API key, and you're running. No server, no install, no waiting. But then they can grow. Persist an agent to a **hub** (an open-source server you can run anywhere), and it gains persistence, system access, and the ability to reach across **multiple browsers simultaneously** — each one a different arm with its own display, sensors, and context. One agent, many points of presence, distributed intelligence coordinated from the hub.

This is the new architecture of the Agentic Web: browser-native agents with living interfaces, optional hub persistence for autonomy, and multi-browser reach for distributed intelligence. Every interaction happens inside a sandboxed environment where agents have full creative freedom but cannot escape their container.

## Quick Start

**1. Open [flo.monster](https://flo.monster)** — Navigate to the URL in any modern browser. Nothing to install.

**2. Paste your API key** — Enter your [Anthropic](https://console.anthropic.com/), [OpenAI](https://platform.openai.com/), or [Google Gemini](https://aistudio.google.com/) API key. It's encrypted locally using Web Crypto and never leaves your browser (see [Security.md](Security.md)).

**3. Start talking** — Create an agent and tell it what to do or build.


See the [Living Lists](guides/Living-Lists.md) example.

The agent builds a set of Living Lists. Then you can just tap a button and speak naturally to add items:

- *"buy eggs"* — appears in your Shopping list
- *"dentist at 3pm Thursday"* — appears in your Schedule
- *"remember that call Sarah"* — appears in your Todo list 

The agent classifies each input automatically. No menus, no categories to pick, no forms to fill. Just say it and see it.

This is just one very simple example to get you started. And of course you can ask your agent to change the design and functionality of this to customise to meet your needs.

## Capability Tiers

[flo.monster](https://flo.monster) scales from zero-install browser use to distributed multi-browser presence:

| Tier | What You Get | Requirements |
|------|--------------|--------------|
| **Browser** | Browser-only agents with full web platform access | Just a browser + API key |
| **Hub** | + Persistence, Push notifications, multi-browser reach, CORS bypass, optional shared API key | See [Installing-A-Hub.md](guides/Installing-A-Hub.md) |
| **Dev** | + Bash commands, filesystem read/write, git | Hub with dev tools enabled |
| **Advanced** | + Custom tools, integrations, anything you can build | Extend hub with your own handlers |

The Browser tier is more powerful than it sounds. The web platform provides DOM manipulation, HTTP requests, storage, a full filesystem (OPFS), JavaScript execution, subagents, reactive state, and runtime capability introspection — all with zero infrastructure.

## What Can Agents Do?

Agents have access to a rich set of capabilities, depending on their tier:

- **DOM manipulation** — Full control of their living skin: create, modify, and animate any HTML/CSS/JS
- **Voice I/O** — Speech recognition (input) and speech synthesis (output), proxied through the shell for sandbox compatibility
- **Camera and microphone** — WebRTC loopback grants media access even inside sandboxed iframes
- **Reactive state** (`flo.state`) — Synchronous read/write state with escalation rules that fire notifications to the agent when conditions are met
- **File storage** — Per-agent Origin Private File System (OPFS) in browser, disk storage on hub
- **Network requests** — Fetch with per-agent network policy (allowlist/blocklist), hub proxy for CORS bypass
- **JavaScript execution** — `runjs` sandbox for dynamic code evaluation in the browser
- **Subagents** — Spawn child agents for parallel workloads, each with its own worker
- **System tools** (hub) — Bash, filesystem read/write, git
- **Scheduling** (hub) — Cron-like triggers and event-driven automation
- **Push notifications** (hub) — Agents can reach out to you even when the browser tab is closed
- **Multi-browser coordination** (hub) — One agent, many browser arms, each with its own display and sensors
- **Multi-provider LLM support** — Anthropic Claude, OpenAI, Google Gemini and Ollama for local models

## Architecture at a Glance

Built from the ground up with [security](Security.md) in mind.

```
Browser Tab
├── Shell (orchestrator)
│   ├── Service Worker ─── API key injection, caching, push
│   ├── Dashboard UI ───── agent cards, settings, notifications
│   └── Message Relay ──── fetch proxy, speech/media, tool routing
│
├── Agent 1 (sandboxed iframe, opaque origin)
│   ├── Living Skin ────── agent-controlled DOM surface
│   ├── Web Worker ─────── agentic loop, tool execution
│   └── Subagent Workers ─ child agents (inherit sandbox)
│
├── Agent 2 (same structure)
│
└── [Optional] Hub Connection (WebSocket)
    ├── Persistence ────── agent state survives browser close
    ├── System Tools ───── bash, filesystem, scheduling
    └── Multi-Browser ──── coordinate across connected browsers
```

**Shell** is the orchestrator. It manages agent lifecycles, mediates all communication, enforces security policy, and hosts the Service Worker that injects API keys into requests so no agents (or any other code) can ever see or access them.

**Agent iframes** use `sandbox="allow-scripts allow-forms"` without `allow-same-origin`, creating an opaque-origin boundary. Agents have full creative freedom within their sandbox but cannot access the shell's DOM, storage, or credentials.

**Web Workers** run the agentic loop (API call, parse response, execute tool, loop) off the main thread. All shell communication flows through postMessage chains.

**The hub** is optional. When connected, agents can persist (surviving browser close), gain system tools (bash, filesystem), and coordinate across multiple browsers. Hub-persisted agents run their agentic loop on the hub — browsers become display surfaces.

See [Architecture.md](Architecture.md) for the full architecture overview.

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture.md](Architecture.md) | Component structure, message flows, hub-as-authority model |
| [Security.md](Security.md) | Security model, sandbox design, threat mitigations |

## Monorepo Packages

| Package | Name | Purpose |
|---------|------|---------|
| `packages/core` | `@flo-monster/core` | Isomorphic: types, SSE parser, provider adapters, agentic loop, tool registry, cost tracking |
| `packages/browser` | `@flo-monster/browser` | Shell UI, agent container, iframe bootstrap, browser tools, relay handlers |
| `packages/hub` | `@flo-monster/hub` | Hub server: persistence, system tools, fetch proxy, multi-browser coordination |
| `packages/proxy` | `@flo-monster/proxy` | Dev CORS proxy for local development |

## Development

```bash
# Install node (e.g. 22+ - we recommend nvm)

# Install pnpm
npm install -g pnpm

# Install dependencies
pnpm install

# Run dev server (CORS proxy on 3001, Vite HTTPS on 5173)
pnpm dev

# Run tests
./scripts/test.sh

# Type check
./scripts/typecheck.sh
```

## Licence

- **`packages/browser`** — BSL 1.1 (converts to AGPL-3.0 after 4 years)
- **`packages/hub`**, **`packages/core`**, **`packages/proxy`** — AGPL-3.0
