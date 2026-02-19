# Using Your Claude Code Plan

How to run [flo.monster](https://flo.monster) agents using your Claude Code subscription instead of paying per-token API costs.

## Why?

Anthropic offers two ways to use Claude:

- **API access** -- pay per token (input and output), billed to your API account
- **Claude Code** -- a flat-rate subscription plan that includes unlimited (fair-use) access to Claude models via the `claude` CLI

If you already have a Claude Code subscription, you can route your [flo.monster](https://flo.monster) agents through it. Your agents use the same models, the same tools, the same living skins -- but the API calls go through your Claude Code CLI instead of directly to the Anthropic API. No per-token charges.

## What You Need

- A [flo.monster hub](Installing-A-Hub.md) installed and running
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed on the same machine as your hub
- An active Claude Code subscription (Pro, Team, or Enterprise)
- Claude Code authenticated (`claude login` or equivalent)

The hub machine needs `claude` available in its PATH. The browser does not need anything special -- once the hub is configured, it just works.

## Configuring the Hub

Add a `cliProviders` section to your hub configuration file (`~/.flo-monster/hub.json`):

```json
{
  "cliProviders": {
    "anthropic": {
      "command": "claude",
      "timeout": 120000
    }
  }
}
```

That's the minimal configuration. The hub will now route all Anthropic API requests through the `claude` CLI instead of directly to `api.anthropic.com`.

Restart your hub for the change to take effect.

### Configuration Options

| Field | Default | Description |
|-------|---------|-------------|
| `command` | `"claude"` | Path to the Claude Code CLI executable |
| `args` | `[]` | Extra CLI arguments to pass on every invocation |
| `timeout` | `120000` | Maximum response time in milliseconds (2 minutes) |

If `claude` is not on your hub's PATH, use the full path:

```json
{
  "cliProviders": {
    "anthropic": {
      "command": "/home/user/.claude/local/claude",
      "timeout": 120000
    }
  }
}
```

### Mixing Providers

You can use CLI proxy for Anthropic while using direct API keys for other providers:

```json
{
  "cliProviders": {
    "anthropic": {
      "command": "claude"
    }
  },
  "sharedApiKeys": {
    "openai": "sk-...",
    "gemini": "AIz..."
  }
}
```

Agents using Anthropic models go through Claude Code. Agents using OpenAI or Gemini models use the shared API keys directly.

## How It Works in the Browser

Once your hub has `cliProviders` configured, the browser picks it up automatically.

1. Your browser connects to the hub via WebSocket
2. The hub sends back a list of available providers (including CLI-backed ones)
3. When you create an agent using an Anthropic model, API requests are routed through the hub
4. The hub spawns `claude -p` (Claude Code in pipe mode) for each request
5. The response is translated back to the standard Anthropic SSE format
6. Your agent receives the response exactly as if it came from the API directly

There is nothing to configure in the browser. If the hub advertises Anthropic as an available provider, the browser routes to it. Your agents work identically -- tools, DOM manipulation, state, storage, scheduling, everything.

### Browser-Only Agents

Browser-only agents (not connected to a hub) always use your browser API key directly. CLI proxy requires a hub.

### Hub-Persisted Agents

Agents that are [persisted to the hub](Installing-A-Hub.md) also benefit from CLI proxy. When the hub runs the agentic loop on behalf of a persisted agent, it routes through the same `claude` CLI. This means your persisted agents can run autonomously (scheduled tasks, event triggers, push notifications) using your Claude Code plan -- even when your browser is closed.

## How It Works Under the Hood

The CLI proxy translates between the Anthropic Messages API format and Claude Code's pipe mode:

1. **Request translation** -- the hub takes the standard API request body (messages, tools, system prompt, model) and formats it as input for `claude -p --output-format stream-json`
2. **Tool schema injection** -- since Claude Code's built-in tools are disabled (`--tools ''`), the hub includes compact tool schemas in the system prompt so the model knows the exact parameter names and types for each tool
3. **Tool call parsing** -- the model outputs tool calls as `<tool_call>` XML in its text response. The hub parses these and converts them to proper Anthropic `tool_use` content blocks
4. **SSE synthesis** -- the parsed response is re-encoded as standard Anthropic Server-Sent Events, which the browser's agentic loop consumes normally

The browser's tool executor then handles the tool calls (DOM updates, JavaScript execution, fetch requests, etc.) exactly as it would with a direct API response.

### Model Selection

The model your agent is configured to use is passed through to Claude Code via the `--model` flag. If your Claude Code plan includes access to that model, it works. If not, Claude Code will return an error.

### Budget Limits

The hub calculates a per-request budget from the agent's `max_tokens` setting using the model's pricing information, and passes it as `--max-budget-usd` to prevent runaway costs within a single CLI invocation.

## Limitations

- **Latency** -- spawning a CLI process adds overhead compared to a direct API call. Expect slightly longer time-to-first-token.
- **No native streaming** -- responses are buffered (not streamed token-by-token) because tool call parsing requires seeing the complete response. You will see the full response appear at once rather than streaming in.
- **Claude Code plan limits** -- your subscription's fair-use policy still applies. Heavy agent workloads may hit rate limits.
- **Anthropic only** -- CLI proxy currently works with the `claude` CLI for Anthropic models. Other providers (OpenAI, Gemini, Ollama) use direct API keys or their own endpoints.

## Further Reading

- [Installing a Hub](Installing-A-Hub.md) -- full hub setup guide
- [Getting Started](Getting-Started.md) -- creating your first agent
- [Scheduling Tasks](Scheduling-Tasks.md) -- autonomous agent execution on the hub
