# Security Model

[flo.monster](https://flo.monster) was designed from the ground up with security in mind. Here's how it thinks about security — and the specific mechanisms that enforce it.

## Philosophy: Containment, Not Restriction

Agents have **full capabilities within their sandbox** — arbitrary JavaScript execution, DOM manipulation, network requests (within policy), file storage, and more. Security comes from **what agents cannot reach**, not from restricting what they can do within their space.

This is a deliberate design choice. Restricting agent capabilities (blocklisting APIs, sanitising output, limiting JavaScript) creates a cat-and-mouse game that degrades the product. Instead, [flo.monster](https://flo.monster) gives agents a powerful but contained environment. The sandbox boundary is the security boundary. Everything inside is permitted. Nothing outside is reachable. The web platform has refined this model through over 30 years of hardened engineering in the world's most adversarial environment - the internet.

## Security Layers

Four layers of defence work together:

| Layer | What It Prevents | Mechanism |
|-------|------------------|-----------|
| **Opaque-origin iframe** | Agent accessing shell DOM, storage, cookies, API keys | `sandbox="allow-scripts allow-forms"` without `allow-same-origin` |
| **Worker context** | Agent code blocking UI or accessing DOM directly | Web Worker isolation; DOM ops via postMessage only |
| **Message validation** | Agents spoofing messages to shell or other agents | `e.source` verification against expected `contentWindow` |
| **Network policy** | Agents accessing unauthorised domains | Per-agent allowlist/blocklist enforced before every fetch |

Each layer is independent. A failure in one does not compromise the others.

## API Key Isolation

API keys are the most sensitive asset in [flo.monster](https://flo.monster). The design ensures agents and any other loaded code **never see them**.

### How It Works

1. **Storage:** Keys are encrypted in the shell's IndexedDB using Web Crypto (AES-GCM with PBKDF2 key derivation). No plaintext fallbacks.
2. **Injection:** The Service Worker intercepts agent API requests and injects the appropriate per-provider authentication header:
   - Anthropic: `x-api-key` header
   - OpenAI / Gemini: `Authorization: Bearer` header
   - Ollama: No auth required (endpoint-based)
3. **Isolation:** The key exists only in the Service Worker's global scope. Agent iframes and workers never receive it, cannot request it, and cannot intercept it.

### Why This Works

Service Worker scope operates at the **URL level, not the origin level**. When an agent worker calls `fetch('/api/v1/messages')`, the Service Worker intercepts it regardless of the iframe's opaque origin. The agent uses standard `fetch()` with no special protocol — it simply doesn't know the key exists.

```
Agent Worker
└── fetch('/api/v1/messages', { body: messages })
          │
          ▼  (URL-level interception)
    Service Worker
          │
          ├── Look up provider config
          ├── Inject auth header (agent never sees this)
          └── Forward to provider API
          │
          ▼
    Response streams back to Worker
```

### Transparency Note

Web Crypto encryption protects stored keys against casual inspection but not a determined attacker with DevTools access to the shell origin. This is an inherent limitation of client-side key storage. But for this to happen you have to give them physical access to your browser - so don't do that.

## Agent Sandbox

### Opaque Origin

Every agent iframe uses `sandbox="allow-scripts allow-forms"` **without** `allow-same-origin`. This creates an opaque origin — a unique, unguessable origin that shares nothing with the shell or other agents.

An agent in an opaque-origin iframe **cannot:**

- Access the shell's `document`, `localStorage`, `indexedDB`, or `cookies`
- Access any other agent's DOM or storage
- Register Service Workers
- Read or write the shell's clipboard
- Navigate the top-level page
- Open popups with shell origin

An agent **can:**

- Execute arbitrary JavaScript
- Manipulate its own DOM freely
- Use canvas, WebGL, Web Audio, and other rendering APIs
- Communicate with the shell via `postMessage` (the only channel)

The `allow-forms` permission is safe: form submission does not weaken origin isolation, and agents already have `fetch` for network access.

### Subagent Isolation

Subagent iframes spawned within an agent's iframe inherit the same sandbox restrictions. There is no privilege escalation path through subagent creation.

## Message Validation

All shell-agent communication flows through `postMessage`. The shell validates every incoming message:

### Source Verification

Shell-side `postMessage` handlers verify `e.source` against the expected iframe's `contentWindow` before processing any message. This prevents:

- **Cross-agent spoofing** — One agent pretending to be another
- **External injection** — Third-party scripts posting messages to the shell

```javascript
// Shell message handler (simplified)
window.addEventListener('message', (e) => {
  // Verify the message came from a known agent iframe
  const agent = agents.find(a => a.iframe.contentWindow === e.source);
  if (!agent) return; // Reject unknown sources

  // Now safe to process — we know which agent sent this
  handleAgentMessage(agent.id, e.data);
});
```

### Why Shell-Side Is the Boundary

Iframe containment (opaque origin) guarantees that only the shell can message an agent's iframe — no other party has a reference to `iframe.contentWindow`. The critical validation is the shell checking `e.source` on messages **from** iframes. Iframe-side source checks are defence-in-depth, not the security boundary.

### No Trusting Payload IDs

The shell never trusts an `agentId` field from the message payload. Agent identity is determined by `e.source` matching, not by what the message claims.

## Hub Security

The hub extends agents with system-level capabilities (bash, filesystem). These require robust security because they operate outside the browser sandbox.

### Three-Layer Bash Security

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **1. Command filtering** | Blocklist of 45+ patterns (scheduling, services, package managers, network listeners, destructive ops, kernel/firewall). Splits compound commands (`;`, `&&`, `\|\|`, `\|`) and recursively detects `bash -c`/`sh -c`/`env` wrappers. Detects shell metacharacters (`$()`, backticks, `<()`, `>()`, heredocs). | Defence-in-depth |
| **2. OS user isolation** | Optional `runAsUser` config runs agent bash commands as a dedicated low-privilege user via `sudo -n -u`. Automated setup via `flo-admin setup`. | **The real security boundary** |
| **3. Per-agent sandbox** | Each hub-persisted agent gets its own sandbox subdirectory. Agents cannot access other agents' sandboxes or escape to the parent. | Lateral movement prevention |

Command filtering is defence-in-depth. It catches common mistakes and obvious abuse, but a sufficiently creative attacker can bypass string-based filtering. OS user isolation is the real security boundary — even if an agent bypasses command filtering, it operates as a low-privilege user with no access to sensitive resources.

### Filesystem Security

- **Path validation:** All filesystem tool operations validate that paths stay within the agent's sandbox directory.
- **Symlink resolution:** `validateFilePath()` uses `realpath()` to resolve symlinks and re-validates the resolved path. This prevents symlink-based sandbox escapes (e.g., creating a symlink to `/etc/passwd` inside the sandbox).
- **File permissions:** Agent store files (`session.json`, `state.json`) are written with mode `0o600` (owner read/write only). Files containing API keys or session data are never world-readable.

### Hook Template Shell-Escaping

Hook commands support template interpolation (`{{sandbox}}`, `{{result}}`, field placeholders). All interpolated values are shell-escaped using POSIX single-quote wrapping to prevent injection. Unsanitised values are never interpolated into shell commands.

### Safe Expression Evaluation

Hub state escalation rules and scheduler conditions use `evaluateSafeCondition()` — a declarative expression evaluator supporting only comparison operators (`>`, `>=`, `<`, `<=`, `==`, `!=`) and keywords (`always`, `changed`). `new Function()` and `eval()` are never used for condition evaluation.

## Network Security

### TLS Enforcement

Hub connections require TLS for non-localhost addresses:

| Hub Address | Protocol Required |
|-------------|-------------------|
| `localhost`, `127.0.0.1`, `::1` | `ws://` allowed (but not recommended) |
| Any other address | `wss://` required |

This is enforced in `HubClient.connect()`. The requirement exists because API keys are transferred during agent persistence — sending keys over unencrypted WebSocket to a public address would expose them.

### SSRF Protection

The hub's fetch proxy validates redirect targets to prevent Server-Side Request Forgery (SSRF) via 302 redirects:

- **Private IP blocking:** Redirect targets are checked against private IP ranges at each hop
- **Manual redirect following:** The proxy follows redirects manually (not via the HTTP client's automatic redirect) so each hop can be validated
- **Header stripping:** Sensitive headers (`authorization`, `cookie`, `x-api-key`, `proxy-authorization`, `set-cookie`) are stripped from proxied requests

### Fetch Redirect Protection

Both browser and hub fetch validate redirect targets. A 302 redirect to an internal resource is blocked — this prevents attackers from using an agent's fetch capability to probe internal services.

### Network Policy

Per-agent network policy controls which domains an agent can access:

| Mode | Behaviour |
|------|-----------|
| `allow-all` | No restrictions (default) |
| `allowlist` | Only listed domains allowed |
| `blocklist` | All domains except listed ones |

Policy is enforced in the browser's message relay before any fetch is made. Domain matching supports exact and subdomain matching (`example.com` matches `api.example.com`). Sensitive headers are always stripped regardless of policy mode.

When a hub is connected, agent fetch requests route through the hub server-side (avoiding CORS restrictions), but network policy is still enforced before routing.

## Hub-as-Authority

When an agent persists to a hub, the hub becomes the **single source of truth** for all state.

### State Authority Model

- **Hub owns everything** — conversation, agent state, storage, files, DOM. All writes go to hub, all reads from hub.
- **Browser is a display surface** — renders events from hub, executes browser-routed tools (dom, runjs). No independent state.
- **No local fallback** — when the hub is unreachable, a hub-persisted agent is **not usable**. The browser shows "Hub Offline" and retries with exponential backoff. This avoids split-brain state conflicts.

### Worker Passive Mode

The browser's Web Worker stays alive for tool execution but does **not** run an agentic loop. Worker-emitted `state_change` events are filtered out — only hub state updates are authoritative. Page events (`flo.notify`, `flo.ask`, `dom_event`) route to the hub via WebSocket instead of triggering a local loop.

### Subscription Authorisation

Hub handlers for state writes, DOM updates, and agent restore verify that the requesting client is subscribed to the target agent. Schedule operations verify ownership. This prevents one browser from manipulating another browser's agents.

## API Key Transfer

When persisting an agent to the hub, the browser transfers the agent's API key:

1. **Browser decrypts** the API key from CredentialsManager
2. **Transfer over TLS** — the WebSocket connection must be `wss://` for non-localhost hubs
3. **Hub stores per-agent** — key saved on disk alongside agent config
4. **One-way transfer** — keys are sent browser-to-hub only, never returned
5. **Priority resolution** on hub: per-agent key > provider default > shared API keys > CLI proxy

## Rate Limiting

Multiple rate limiting layers prevent abuse:

| Layer | Limit | Purpose |
|-------|-------|---------|
| **WebSocket message rate** | 100 messages/second per client | Prevents message flooding |
| **HTTP request rate** | Configurable per-IP (`maxRequestsPerMinute`, default 60) | Prevents API abuse |
| **Admin auth lockout** | 5 failed attempts, 15-minute lockout | Prevents brute-force attacks |
| **Timing-safe token comparison** | Constant-time algorithm | Prevents timing attacks on authentication |

### Pre-Authentication Message Gating

WebSocket message handlers check `client.authenticated` before processing any state-changing message (`browser_tool_result`, `skill_approval_response`, tool requests, etc.). Only `auth` messages are processed before authentication completes.

## Content Security

### No innerHTML with Untrusted Data

Agent output, extension content, and user input are all treated as untrusted. The shell uses `textContent` or `createElement` for dynamic content — never `innerHTML`. This prevents XSS from agent-generated content reaching the shell context.

### Template Security

Agent templates (custom srcdoc HTML, initial files) run in the same opaque-origin sandbox as default agents. Templates cannot disable the bootstrap, escalate privileges, or access shell resources. Zip-based template imports validate paths to prevent directory traversal attacks.

### Skill Integrity

URL-installed skills can specify an integrity hash (e.g., `integrity: sha256-abc123...`). The hash is verified against skill content before installation, preventing tampering with externally hosted skills.

### Hub Skill Approval

Skills created via hub require explicit user approval from a connected browser. The user sees the skill name, description, and content before approving. If no browser is connected or approval times out, skill creation fails. This prevents agents from installing arbitrary skills without user consent.

## Permission Tiers

| Tier | What It Covers | How Granted |
|------|---------------|-------------|
| **Always on** | RunJS (sandbox), DOM (own iframe), Storage (own namespace), Crypto | Automatic |
| **Agent-level** | Fetch (declared domains), extension tools | Set at agent creation |
| **Browser-prompted** | Camera, mic, geolocation, filesystem, clipboard | Browser permission dialogue |
| **User-confirmed** | Hub tools, spending beyond threshold, agent persistence | Shell UI confirmation |
| **Admin** | Spawning agents, installing extensions, global settings | Direct user action |

## Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| API key exposure | Shell-only storage, SW injection, encrypted IndexedDB |
| Agent sandbox escape | Opaque-origin iframes, no `allow-same-origin` |
| Malicious extension | Permission declaration, network policy, no key access |
| Runaway API spend | Per-agent budgets, global spend cap, confirmation thresholds |
| Hub privilege escalation | Config-based permissions, per-invocation approval, default read-only, bash blocklist |
| Agent bash abuse | 3-layer defence: command filtering + OS user isolation + per-agent sandbox |
| State split-brain | No local fallback for hub agents — hub is sole authority |
| API key exposure during persist | TLS-only WebSocket transfer, per-agent storage, keys never returned |
| Cross-agent data leak | Opaque origins, shell-mediated storage, explicit messaging channels |
| Unauthorised skill install | Hub skill approval requires connected browser user consent |
| Skill tampering (URL) | Optional integrity hash verification |
| Hook script shell access | Scripts execute in agent sandbox, not shell context |
| Hub API key abuse | Timing-safe tokens, rate limiting, connection-scoped auth |
| SSRF via redirect | Private IP blocking at each redirect hop, manual redirect following |

## Further Reading

- [Architecture.md](Architecture.md) — Component structure, message flows, hub-as-authority model
- [README.md](README.md) — Project overview and quick start
