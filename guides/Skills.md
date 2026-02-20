# Skills

Skills are on-demand reference documents that agents can load when they need specialised knowledge. Instead of stuffing everything into the system prompt (which is expensive and slow), agents load skills as needed -- keeping the base context small and focused.

Of course, your agents can just create this for you if you ask them.

## How Agents Use Skills

Agents discover and load skills with two tools:

1. **`capabilities`** -- Tells the agent which skills are available in its current execution context
2. **`get_skill({ name: 'flo-media' })`** -- Loads the skill content into the conversation

Once loaded, the agent reads the content, learns the patterns and APIs described, and applies them. Skills are loaded once per conversation -- the agent remembers the content for the remainder of the session.

```
Agent: "I need to build a camera feature. Let me check what's available."
       → calls capabilities → sees 'flo-media' skill listed
       → calls get_skill({ name: 'flo-media' })
       → reads the media API reference
       → builds the camera UI using flo.getCamera()
```

## System Skills

[flo.monster](https://flo.monster) ships with six built-in system skills. These are always available and cover the core platform capabilities. The system prompt provides comprehensive guidance on page architecture, the flo API, event handling, and the architect pattern — skills provide deeper guidance for specific capabilities.

### 1. flo-srcdoc

UI snapshot management -- saving and loading page states.

- Save your page as a `.srcdoc` file with a `.srcdoc.md` metadata companion
- YAML frontmatter for title, description, and notes
- List available skins with `files({ action: 'frontmatter', pattern: '*.srcdoc.md' })`
- Multi-skin management -- maintain different UIs (dashboard, settings, game) and switch between them

### 2. flo-subagent

Subagent patterns for cost-efficient delegation.

- **`subagent({ task: '...', systemPrompt: '...' })`** -- Spawn a lightweight worker agent with minimal context (~200 tokens vs 2,000+ for the main agent)
- **`flo.callTool('subagent', { task: '...' })`** -- Spawn subagents directly from page JavaScript
- **Architect-Subagents pattern** -- Main agent builds the page and goes idle; page JS spawns subagents for routine AI tasks; main agent wakes only on escalation
- **Depth limits** -- Subagents can nest up to 3 levels deep
- **Cost optimisation** -- Each subagent call costs roughly 10-20x less than waking the main agent

### 3. flo-speech

Voice input and output APIs.

- **`flo.speech.listen()`** -- Speech-to-text. Returns a session object (not a Promise) with `done()` and `cancel()` methods
- **`flo.speech.speak()`** -- Text-to-speech. Returns a Promise that resolves when the utterance finishes
- **`flo.speech.voices()`** -- Lists available voices with name, language, and local/cloud indicator
- **iOS Safari quirks** -- Auto-stop after ~60s silence (auto-restarted), TTS `cancel()` before `speak()` (handled automatically)

See [Voice](Voice.md) for the full guide.

### 4. flo-media

Camera and microphone access via WebRTC proxy.

- **`flo.getCamera()`** -- Returns a video MediaStream
- **`flo.getMicrophone()`** -- Returns an audio MediaStream
- **`flo.getMediaStream({ video: true, audio: true })`** -- Combined or custom constraints
- **`flo.stopMediaStream(stream)`** -- Proper cleanup (never call `track.stop()` directly)
- **WebRTC proxy** -- Since `getUserMedia()` is blocked in sandboxed iframes, media is captured by the shell and delivered to the agent via a WebRTC loopback connection

See [Media](Media.md) for the full guide.

### 5. flo-geolocation

Location services via shell proxy.

- **`flo.geolocation.getCurrentPosition(options?)`** -- One-shot position with optional high accuracy, timeout, and maximum age
- **`flo.geolocation.watchPosition(callback, errorCallback?, options?)`** -- Continuous tracking. Returns a session with `.stop()`
- **Error codes** -- Permission denied, position unavailable, timeout
- **Permission flow** -- Agent-level approval dialog, then browser-native prompt

### 6. flo-hub

Hub features for persistent, autonomous agents.

- **Two execution modes** -- `hub-with-browser` (fully interactive) and `hub-only` (autonomous, structural DOM only)
- **Schedule tool** -- Cron jobs (`*/5 * * * *`) and event triggers (`state:score`, `browser:connected`)
- **Hub-native tools** -- `bash`, `filesystem`, `state`, `files`, `schedule`
- **Hub-side storage** -- State and files persist on disk across restarts
- **Browser connect/disconnect events** -- React when users arrive or leave

## Capability-Gated Skills

Some skills are only available when the agent has specific capabilities:

| Skill | Required Capability | When Available |
|-------|-------------------|----------------|
| `flo-hub` | `hub` | Only when connected to a hub |
| All others | None | Always available |

Agents cannot see or load skills that require capabilities they do not have. A browser-only agent will not see `flo-hub` in its skill list.

## Custom Skills

Agents running on a hub can create custom skills using the `create_skill` tool:

```
create_skill({
  name: 'my-project-patterns',
  description: 'Coding patterns specific to this project',
  content: '# Project Patterns\n\n## API conventions\n...'
})
```

Custom skill creation requires user approval:

1. The hub sends an approval request to the connected browser
2. You see the skill name, description, and full content
3. You approve or reject
4. If no browser is connected, creation fails

This prevents agents from installing arbitrary skills without your consent.

## Skill Format

Skills are markdown files with optional YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews code for quality and security
allowedTools:
  - runjs
  - fetch
hooks:
  PreToolUse:
    - matcher: "^bash$"
      hooks:
        - type: action
          action: deny
          reason: No bash access for this skill
---

You are a thorough code reviewer. When given code:

1. Check for security vulnerabilities
2. Evaluate error handling
3. Assess readability and structure
4. Suggest specific improvements
```

### Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Lowercase with hyphens (e.g., `code-reviewer`) |
| `description` | Yes | Helps the agent decide when to load this skill |
| `allowedTools` | No | Tools auto-approved when this skill is active |
| `hooks` | No | Skill-scoped hooks (active only while the skill is in use) |
| `integrity` | No | SHA-256 hash for tamper protection on URL-installed skills |
| `userInvocable` | No | If `false`, cannot be invoked via `/command` (default `true`) |
| `disableModelInvocation` | No | If `true`, only the user can invoke this skill |

### allowedTools Auto-Approval

When a skill with `allowedTools` is invoked, a high-priority hook is automatically registered that allows those specific tools without prompting. The auto-approval hook is cleaned up when the agent session ends.

### Skill-Scoped Hooks

Skills can define hooks that are active only while the skill is in use. These hooks are registered when the skill is invoked and automatically cleaned up when the agent session ends. See [Hooks](Hooks.md) for details on hook configuration.

### Integrity Verification

URL-installed skills can include an integrity hash for tamper protection:

```yaml
integrity: sha256-abc123def456...
```

When present, the skill content is hashed and compared before installation. If the hash does not match, installation fails. This prevents man-in-the-middle attacks on skill URLs.

## Skills vs System Prompt

| | System Prompt | Skills |
|---|---|---|
| **Loaded** | Always, every message | On demand, once per conversation |
| **Cost** | Paid for every API call | Paid once when loaded |
| **Use for** | Personality, core behaviour, always-on instructions | Reference material, API docs, patterns |
| **Size** | Keep small | Can be detailed |

Skills keep the base context small, which means cheaper and faster responses for routine interactions. The agent loads specialised knowledge only when it needs it.

## See Also

- [Getting Started](Getting-Started.md) -- First steps with [flo.monster](https://flo.monster) 
- [Hooks](Hooks.md) -- Intercepting and modifying agent behaviour
- [Storage and State](Storage-And-State.md) -- Reactive state and the architect pattern
- [Voice](Voice.md) -- Speech input and output
- [Media](Media.md) -- Camera and microphone access
