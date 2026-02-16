# Storage and State

Persistence and reactive state in [flo.monster](https://flo.monster) — how agents remember things and stay efficient.

Of course, your agents can just create this for you if you ask them.

## Three Storage Mechanisms

[flo.monster](https://flo.monster) provides three ways for agents to store data:

| Mechanism | Purpose | Scope |
|-----------|---------|-------|
| `storage` tool | Simple key-value persistence | Per agent, survives across sessions |
| `flo.state` / `state` tool | Reactive state shared between agent and page JS, with escalation rules | Per agent, survives across sessions |
| `files` tool | OPFS filesystem for larger data (documents, snapshots, binary data) | Per agent |

## The storage Tool

Basic key-value persistence. Each agent has its own isolated store.

### Set a Value

```javascript
storage({ action: 'set', key: 'preferences', value: { theme: 'dark', language: 'en' } })
```

Values can be any JSON-serialisable type: strings, numbers, booleans, arrays, objects.

### Get a Value

```javascript
storage({ action: 'get', key: 'preferences' })
// Returns: { theme: 'dark', language: 'en' }
```

### Delete a Value

```javascript
storage({ action: 'delete', key: 'preferences' })
```

### List All Keys

```javascript
storage({ action: 'list' })
// Returns: ['preferences', 'history', 'bookmarks']
```

### From Page JavaScript

Page JS can also access storage via `flo.callTool`:

```javascript
// Set
await flo.callTool('storage', { action: 'set', key: 'items', value: [1, 2, 3] });

// Get
var items = await flo.callTool('storage', { action: 'get', key: 'items' });
// items = [1, 2, 3]

// List keys
var keys = await flo.callTool('storage', { action: 'list' });

// Delete
await flo.callTool('storage', { action: 'delete', key: 'items' });
```

### Limits

When connected to a hub, storage enforces per-agent limits:
- Maximum 1,000 keys
- Maximum 1 MB per value
- Maximum 10 MB total per agent

## flo.state — Reactive State

The `state` tool provides reactive, persistent state shared between the agent (LLM) and page JavaScript. Both sides can read and write. Changes made by either side are visible to the other. Escalation rules let page JS wake the agent when conditions are met.

### Agent-Side API (state tool)

#### Set State

```javascript
state({ action: 'set', key: 'shopping', value: ['milk', 'eggs', 'bread'] })
```

**Important:** State values are native JSON. Use `value: []` for an empty array, not `value: "[]"`.

#### Get State

```javascript
state({ action: 'get', key: 'shopping' })
// Returns: ['milk', 'eggs', 'bread']
```

#### Get All State

```javascript
state({ action: 'get_all' })
// Returns: { shopping: ['milk', 'eggs', 'bread'], score: 42 }
```

#### Delete State

```javascript
state({ action: 'delete', key: 'shopping' })
```

### Page-Side API (flo.state)

Available globally in `<script>` tags within the agent's iframe.

#### Read State (Synchronous)

```javascript
var items = flo.state.get('shopping');
// Returns the current value from the local cache, or undefined if not set
```

#### Write State

```javascript
flo.state.set('shopping', ['milk', 'eggs', 'bread', 'butter']);
// Updates state, fires onChange callbacks, checks escalation rules, persists
```

#### Read All State

```javascript
var all = flo.state.getAll();
// Returns a shallow copy of all state: { shopping: [...], score: 42 }
```

#### Subscribe to Changes

```javascript
// Watch a specific key
var unsubscribe = flo.state.onChange('shopping', function(newValue, oldValue, key) {
  console.log('Shopping list updated:', newValue);
  renderShoppingList(newValue);
});

// Watch with wildcard pattern
flo.state.onChange('player.*', function(newValue, oldValue, key) {
  console.log(key + ' changed to ' + newValue);
  // Fires for 'player.score', 'player.health', 'player.level', etc.
});

// Unsubscribe
unsubscribe();
```

The `onChange` callback receives `(newValue, oldValue, key)` and returns an unsubscribe function.

### Two-Way Updates

Both the agent and page JS can update state, and both see the changes:

1. **Agent updates state** via the `state` tool:

```javascript
state({ action: 'set', key: 'score', value: 42 })
```

2. **Page JS is notified** via `flo.state.onChange`:

```javascript
flo.state.onChange('score', function(newVal) {
  document.getElementById('score').textContent = newVal;
});
```

3. **Page JS updates state**:

```javascript
flo.state.set('score', 43);
```

4. **Agent is notified** if an escalation rule matches (see below).

## Escalation Rules

Escalation rules wake the agent when a state condition is met. This avoids constant polling — the agent only activates when something meaningful happens.

### Setting an Escalation Rule (Agent-Side)

```javascript
state({
  action: 'escalate',
  key: 'todos',
  condition: 'val > 10',
  message: 'Todo list is getting long — time to prioritise'
})
```

### Setting an Escalation Rule (Page JS)

```javascript
flo.state.escalate('inventory', 'val < 5', 'Inventory is running low');
```

### Supported Conditions

| Condition | Fires when |
|-----------|------------|
| `'val > 100'` | Value exceeds 100 |
| `'val >= 10'` | Value is 10 or more |
| `'val < 5'` | Value drops below 5 |
| `'val == "complete"'` | Value equals "complete" |
| `'val != "pending"'` | Value is not "pending" |
| `'always'` | Every time the value changes |
| `'changed'` | Every time the value changes (alias for always) |

Conditions are evaluated safely using declarative operators — no `eval()` or `Function()`.

### What the Agent Receives

When an escalation fires, the agent gets a `state_escalation` notification containing:

```json
{
  "key": "todos",
  "value": ["item1", "item2", "...11 items"],
  "message": "Todo list is getting long — time to prioritise",
  "snapshot": { "todos": [...], "score": 42, "settings": {...} }
}
```

The `snapshot` is the full state at the time of escalation, so the agent has complete context.

### Managing Escalation Rules

```javascript
// Remove a rule (agent-side)
state({ action: 'clear_escalation', key: 'todos' })

// Remove a rule (page JS)
flo.state.clearEscalation('todos');

// List all active rules (agent-side)
state({ action: 'escalation_rules' })
// Returns: [{ key: 'todos', condition: 'val > 10', message: '...' }]
```

## The Architect-Subagents Pattern

The recommended pattern for efficient agents combines `flo.state` with subagents:

### Step 1 — Agent Builds the UI and Sets Up State

The main agent creates the page, initialises `flo.state`, and sets up escalation rules.

```javascript
// Set initial state
state({ action: 'set', key: 'expenses', value: [] })
state({ action: 'set', key: 'total', value: 0 })

// Set escalation rule
state({ action: 'escalate', key: 'total', condition: 'val > 1000', message: 'Monthly budget exceeded' })

// Create the UI with embedded scripts
dom({ action: 'create', html: '...' })
```

### Step 2 — Agent Goes Idle (Zero Token Cost)

Once setup is complete, the agent finishes processing. It costs nothing while idle.

### Step 3 — Page JS Handles User Input

Page JavaScript manages routine interactions using `flo.state`:

```javascript
flo.state.onChange('expenses', function(expenses) {
  renderExpenseList(expenses);
  var total = expenses.reduce(function(sum, e) { return sum + e.amount; }, 0);
  flo.state.set('total', total);
});
```

### Step 4 — Subagents Handle AI Tasks

When the page needs AI-powered processing, it spawns a lightweight subagent:

```javascript
var result = await flo.callTool('subagent', {
  task: 'Categorise this expense: "Coffee at Blue Bottle, $4.50". Return JSON: { category, subcategory }'
}, { timeout: 300000 });
```

Each subagent call costs roughly 200 tokens, compared to 2,000+ for waking the main agent.

### Step 5 — Main Agent Wakes Only for Escalations

When the budget-exceeded escalation fires, the main agent wakes with full context and can take meaningful action — send a notification, adjust the budget, or reorganise priorities.

### Result

Routine operations (adding expenses, categorising, updating totals) cost 10-20x less than waking the main agent for every interaction.

## Hub Persistence

When an agent is persisted to a hub, state is owned by the hub. The hub is the single source of truth:

- All state writes go through the hub
- All state reads come from the hub
- Connected browsers receive state updates via WebSocket
- State survives hub restarts (stored on disk)
- Escalation rules are preserved across restarts

## Related Guides

- [Bidirectional Interactions](Bidirectional-Interactions.md) — How agents and users interact through the UI
- [Web UI](Web-UI.md) — How agents create and control their page
- [Context Management](Context-Management.md) — Efficient conversation context handling
- [Getting Started](Getting-Started.md) — First steps with [flo.monster](https://flo.monster) 
