# Context Management

How [flo.monster](https://flo.monster) manages conversation context efficiently.

## The Problem

Long conversations consume large context windows. A 100-turn conversation might have 300+ messages — user messages, assistant responses, tool calls, tool results. Sending all of them to the LLM on every turn is expensive and slow. Most of those messages contain details the agent no longer needs in full.

## Terse Mode (Default)

Terse mode is [flo.monster](https://flo.monster)'s solution to context bloat. It compresses old conversation turns into brief summaries while keeping recent turns in full detail.

### How It Works

1. **Agents include `<terse>` tags in their responses:**

```
I created the dashboard with three sections for shopping, todos, and schedule.
<terse>created dashboard with shopping, todo, schedule sections</terse>
```

2. **Users never see the terse tags.** The UI strips them from the displayed response.

3. **The system stores the summaries** in a terse log file (`context.terse.json`), tagged with turn IDs and timestamps.

4. **When building the next API request**, old turns are compressed into an activity log. Only the last N turns are sent in full.

### The Activity Log

Old turns become a compact activity log that gives the agent a sense of history without the full cost:

```
[Context -- Activity Log]
[t1 2024-01-15T10:30] assistant: created dashboard with shopping, todo, schedule sections
[t2 2024-01-15T10:32] assistant: added 3 items to shopping list
[t3 2024-01-15T10:35] assistant: marked 2 todos as complete
[t4 2024-01-15T10:38] assistant: reorganised dashboard layout, moved schedule to top
[t5 2024-01-15T10:40] assistant: added weather widget using fetch API
```

### The Result

A 100-turn conversation sends roughly 50 terse activity log entries plus the last 3 full recent turns, instead of 300+ complete messages. This dramatically reduces token usage and cost while preserving the agent's awareness of what happened.

## Full Mode

Full mode sends every message to the LLM on every turn. No compression, no activity log.

Use this when the agent needs complete context — for example, during debugging sessions, complex analysis tasks, or short intensive conversations where every detail matters.

## Switching Modes

In agent settings, use the **Context Strategy** dropdown:

- **Slim (terse + recent turns)** — The default. Activity log plus last N full turns.
- **Full (all messages)** — Everything sent on every turn.

You can also configure the number of recent turns to keep in full detail (1 to 10, default 3). This controls how many of the most recent turns are sent as complete messages rather than compressed into the activity log.

## context_search Tool

Even in terse mode, the full conversation history is preserved. Agents can search it on demand using the `context_search` tool, without paying the cost of loading the entire history into context.

### Search Mode — Find Messages by Keyword

```javascript
context_search({ mode: 'search', query: 'colour palette', before: 2, after: 2 })
```

Searches across message text, tool names, tool inputs, and tool results. Case-insensitive. The `before` and `after` parameters control how many surrounding messages to include (default: 2 each). Overlapping context windows are merged into contiguous ranges.

**Example result:**
```
--- messages 14-18 of 42 ---
[user t7] Can you make a colour palette?
[assistant t7] I'll create a nature-inspired palette. [tool: dom({action: 'create', ...})]
[user t8] Can you make the greens warmer?
[assistant t8] Updated the palette with warmer greens.
```

### Tail Mode — Recent Messages

```javascript
context_search({ mode: 'tail', last: 20 })
```

Retrieves the last N messages. Useful for reviewing recent activity.

### Head Mode — Beginning of Conversation

```javascript
context_search({ mode: 'head', first: 10 })
```

Retrieves the first N messages. Useful for reading initial instructions or the overview context.

### Turn Mode — Specific Turn by ID

```javascript
context_search({ mode: 'turn', turnId: 't5' })
```

Retrieves all messages for a specific turn. Turn IDs (shown in the activity log) are sequential: `t1`, `t2`, `t3`, and so on.

You can include surrounding turns for additional context:

```javascript
context_search({ mode: 'turn', turnId: 't5', before: 2, after: 1 })
```

### Parameters Reference

| Parameter | Required | Description |
|-----------|----------|-------------|
| `mode` | Yes | `'search'`, `'tail'`, `'head'`, or `'turn'` |
| `query` | search only | Case-insensitive text to find |
| `before` | No | Messages before each match (default: 2) |
| `after` | No | Messages after each match (default: 2) |
| `last` | No | Number of recent messages for tail mode (default: 10) |
| `first` | No | Number of messages from the start for head mode (default: 10) |
| `turnId` | turn only | The turn ID to retrieve (e.g., `'t5'`) |

## How It Works Technically

### Two Files

The context system maintains two files per agent:

- **`context.json`** — The full conversation history. Every message, tool call, and tool result, tagged with turn IDs.
- **`context.terse.json`** — The activity log. Each entry has a timestamp, turn ID, role, and terse summary.

### Turn IDs

Every message is tagged with a sequential turn ID: `t1`, `t2`, `t3`, and so on. Turn IDs are used in the activity log, in `context_search` results, and for the `turn` mode lookup.

### Context Builder

When preparing an API request, the context builder:

1. Loads the terse entries and full history.
2. In slim mode: identifies the last K turn IDs (configurable, default 3).
3. Filters terse entries to exclude those K recent turns (since they will be sent in full).
4. Formats the remaining terse entries as the activity log.
5. Builds the final message array: `[activity_log_user_msg, activity_log_ack, ...full_recent_messages]`.

In full mode, the builder simply returns all messages from the full history.

## Best Practices

- **Terse mode works well for most agents.** It is the default for a reason — it keeps costs low and responses fast while preserving enough context for continuity.

- **Use `context_search` when agents need to recall specifics.** If the agent needs to remember what colour palette it created 50 turns ago, `context_search({ mode: 'search', query: 'colour palette' })` is far cheaper than sending the full history. Agents should automatically use this when needed, or when you prompt them to.

- **Switch to full mode for short, intensive sessions.** When every detail matters and the conversation will be short (under 20 turns), full mode avoids any risk of losing nuance.

- **The architect-subagents pattern naturally produces compact context.** Subagents have minimal history (just their task), so they never accumulate large contexts. The main agent stays idle most of the time, and when it wakes, it has the activity log plus recent full turns — plenty of context for making decisions.

- **Write good terse summaries.** The quality of terse mode depends on the summaries agents write. A good summary captures what was done and any key decisions, not just "updated the page".

## Related Guides

- [Storage and State](Storage-And-State.md) — Persistence, reactive state, and the architect-subagents pattern
- [Getting Started](Getting-Started.md) — First steps with [flo.monster](https://flo.monster) 
