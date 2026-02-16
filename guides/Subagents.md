# Subagents

Multi-agent patterns -- spawning lightweight workers for efficient task handling.

Of course, your agents can just create this for you if you ask them.

## What Are Subagents?

Subagents are lightweight, short-lived agents spawned by a parent agent. They share the parent's DOM (the same web page) but carry minimal context -- around 200 tokens compared to the 2,000+ tokens a full agent conversation requires. A subagent runs a focused task, returns a text result, and terminates.

Think of them as disposable specialists. The parent agent designs the page and sets up the rules; subagents handle the routine work.

## Why Subagents?

Cost and efficiency.

Every time an agent takes a turn, the full conversation history is sent to the model. As conversations grow, each turn becomes more expensive. A main agent with a long conversation history costs 2,000+ tokens per turn. A subagent, with its minimal context, costs roughly 200 tokens per turn.

For routine tasks -- classifying an input, updating a counter, validating a form, generating a summary -- subagents are 10-20x cheaper than waking the main agent. Meanwhile, the main agent stays asleep, preserving its context budget for architectural decisions and complex reasoning.

| Action | Tokens per Turn | Why |
|--------|----------------|-----|
| Main agent handles input | ~2,000+ | Full conversation context |
| Subagent handles input | ~200 | Minimal focused context |
| **100 routine actions (main agent)** | **~200,000** | |
| **100 routine actions (subagents)** | **~20,000** | **10x cheaper** |

## Basic Usage

The `subagent` tool spawns a new subagent:

```
subagent({
  task: "Classify this input and update flo.state",
  systemPrompt: "You classify items into categories: shopping, todo, exercise.",
  maxTokensPerSubagent: 5000,
  maxCostPerSubagent: 0.10
})
```

### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `task` | Yes | What the subagent should do. This is sent as the user message. |
| `systemPrompt` | No | Custom instructions for the subagent. If omitted, inherits the parent's system prompt. |
| `maxTokensPerSubagent` | No | Token budget cap for this subagent. |
| `maxCostPerSubagent` | No | Cost cap in USD for this subagent. |

The tool returns the subagent's final text response when it completes.

## From Page JavaScript

Page JavaScript can spawn subagents directly using `flo.callTool`. This is the foundation of the architect-subagents pattern -- the page handles user interactions autonomously by spawning subagents on demand, without waking the main agent.

```javascript
var result = await flo.callTool('subagent', {
  task: 'Classify this item: "buy eggs"',
  systemPrompt: 'You classify items into categories: shopping, todo, exercise, schedule, notes. Update flo.state with the result.'
}, { timeout: 300000 });

// result is the subagent's text response
console.log(result);
```

The `timeout` option (in milliseconds) defaults to 30 seconds for `flo.callTool`. For subagent tasks that may take longer, set a higher timeout as shown above.

## The Architect-Subagents Pattern

This is the flagship multi-agent pattern in [flo.monster](https://flo.monster), and the key to building cost-efficient interactive applications.

### How It Works

1. **Architect (main agent)** builds the UI, initialises `flo.state`, registers event handlers and escalation rules, then finishes processing. After setup, it costs zero tokens -- it is completely idle.

2. **Subagents** are spawned on demand by page JavaScript whenever a user action needs AI reasoning. Each subagent gets a tiny, focused prompt.

3. Subagents read and write `flo.state`. Because `flo.state` is reactive, the UI updates immediately via `flo.state.onChange` callbacks.

4. The architect only wakes for **escalations** -- significant events defined by `flo.state.escalate()` rules (e.g., "all tasks completed", "score exceeded threshold", "error state detected").

### Example Flow

```
User speaks: "buy eggs"
    |
    v
Page JS receives input
    |
    v
Page JS calls flo.callTool('subagent', {
  task: 'Classify "buy eggs" and add to the right list in flo.state'
})
    |
    v
Subagent runs (~200 tokens):
  - Reads flo.state to see existing categories
  - Classifies "buy eggs" as shopping
  - Calls state({ action: 'set', key: 'shopping', value: [...existing, newItem] })
    |
    v
flo.state.onChange('shopping', ...) fires in page JS
    |
    v
UI updates instantly -- "eggs" appears in Shopping section
    |
    v
Main agent stays asleep (zero cost)
```

### Real-World Example

The [Living Lists](Living-Lists.md) dashboard uses exactly this pattern. The main agent builds a categorised dashboard, then goes idle. Each user input -- "buy eggs", "dentist at 3pm Thursday", "go for a run tomorrow" -- is handled by a subagent that classifies and files the item. The main agent never wakes for routine inputs.

### Cost Comparison

Over a day of casual use with 100 interactions:

- **Without architect-subagents:** 100 turns x 2,000+ tokens = 200,000+ tokens
- **With architect-subagents:** 1 setup turn + 100 subagent turns x 200 tokens = 22,000 tokens

That is roughly **10x cheaper** for the same user experience.

## Shared DOM

Subagents share the parent agent's iframe. They can see and modify the same web page. This enables powerful patterns:

- A subagent updates a chart element -- the user sees the change immediately
- A subagent reads form values from the page, processes them, and updates the display
- A subagent modifies CSS classes or styles to reflect new state
- Multiple subagents can work on different parts of the page concurrently

Because the DOM is shared, there is no need to pass HTML back and forth. The subagent simply uses the `dom` tool to read or modify elements directly.

## Depth Limits

The maximum subagent nesting depth is 3. This means:

- An agent (depth 0) can spawn subagents (depth 1)
- Those subagents can spawn their own subagents (depth 2)
- Nesting continues up to depth 3
- Subagents at depth 3 **cannot** spawn further subagents

In practice, most patterns only use one level of nesting (the architect-subagents pattern). Deep nesting is rarely needed and increases complexity.

## Timeout

Subagents have a default timeout of 5 minutes. If a subagent does not complete within this window, it is terminated and the parent receives an error result:

```
Error: Subagent timed out after 5 minutes
```

For most focused tasks (classification, validation, data processing), subagents complete well within this limit.

## All Tools Available

Subagents have access to all the same tools as the parent agent:

- `dom` -- create, modify, query, and remove elements
- `storage` -- persistent key-value storage
- `state` -- reactive state (read, write, escalate)
- `files` -- file operations
- `fetch` / `web_fetch` / `web_search` -- network access (subject to network policy)
- `capabilities` -- runtime environment detection
- `context_search` -- conversation history lookup
- Hub tools (if connected): `bash`, `filesystem`, `schedule`

Subagents inherit the parent's permissions and network policy.

## Best Practices

**Give subagents focused, specific tasks.** A good subagent task is: *"Classify this input as shopping, todo, or exercise and update flo.state."* A poor task is: *"Handle everything the user might need."*

**Use `systemPrompt` to keep instructions minimal.** The whole point of subagents is reduced context. A focused system prompt of 50-100 words is ideal. If you omit `systemPrompt`, the subagent inherits the parent's full system prompt, which may be larger than necessary.

**Read state at the start, write state at the end.** Subagents should check current state via `flo.state.get()` or the `state` tool, do their reasoning, then write results back. This keeps the interaction pattern clean and predictable.

**Don't use subagents for tasks that need full conversation history.** If a task requires understanding what the user said 20 messages ago, use `context_search` in the main agent instead. Subagents have no access to the parent's conversation history.

**Let page JavaScript orchestrate.** In the architect-subagents pattern, the page JavaScript decides *when* to spawn a subagent and *what task* to give it. The main agent sets up the rules; the page runs the show.

## Further Reading

- **[Living Lists](Living-Lists.md)** -- The flagship demo using the architect-subagents pattern
- **[Storage and State](Storage-And-State.md)** -- Deep dive into `flo.state` and reactive persistence
- **[Bidirectional Interactions](Bidirectional-Interactions.md)** -- How agents and users interact through the UI
- **[Context Management](Context-Management.md)** -- How agents manage conversation context efficiently
