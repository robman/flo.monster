# Web UI

How agents create and control web UIs in [flo.monster](https://flo.monster).

Of course, your agents can just create this for you if you ask them.

## The Living Skin

Every [flo.monster](https://flo.monster) agent gets a web page it actively controls. This is not static output — it is a dynamic, interactive surface. The agent can create forms, games, dashboards, 3D experiences, and more. It sees and responds when users interact. This is a space you share with the agent, not output you receive from it.

The agent's page lives inside a sandboxed iframe. The agent has full control over the HTML, CSS, and JavaScript within that iframe, but it is securely isolated from the rest of the browser.

## The DOM Tool

The `dom` tool is how agents manipulate their page. It supports several actions:

### `create` — Set Full Page HTML

Replaces the entire page content. Use this to set up the initial UI.

```javascript
dom({
  action: 'create',
  html: `
    <div id="app">
      <h1>My Dashboard</h1>
      <div id="content">Loading...</div>
    </div>
    <style>
      body { font-family: system-ui; padding: 20px; }
      h1 { color: #333; }
    </style>
  `
})
```

Scripts included in the HTML auto-execute — no need for a separate `runjs` call to initialise them.

### `modify` — Modify Specific Elements

Updates part of the page by targeting a CSS selector. You can replace the outer element with `html` or just its contents with `innerHTML`.

```javascript
// Replace element contents
dom({ action: 'modify', selector: '#content', innerHTML: '<p>Dashboard loaded!</p>' })

// Replace the entire element
dom({ action: 'modify', selector: '#content', html: '<section id="content"><p>New structure</p></section>' })
```

### `query` — Read Element Content

Reads the content, attributes, and rendered dimensions of elements on the page.

```javascript
dom({ action: 'query', selector: '#score' })
// Returns text content, attributes, dimensions, and visibility info
```

### `listen` / `wait_for` — Register Event Listeners

Subscribes to DOM events on specific elements. When the event fires, it wakes the agent with the event data.

```javascript
// Register a click listener
dom({ action: 'listen', selector: '#submit-btn', events: ['click'] })

// Block until an event fires (with optional timeout)
dom({ action: 'wait_for', selector: '#submit-btn', event: 'click', timeout: 30000 })
```

The `wait_for` action blocks until the event fires (or the timeout expires), returning event data including form data for submit events.

### `rendered_info` — Get Page Dimensions

DOM tool responses include rendered dimensions, scroll position, and visibility information. This is returned automatically with `create`, `modify`, and `query` actions. Check for `0x0` or `NOT VISIBLE` to verify layouts.

### `error_info` — Check for JavaScript Errors

Runtime errors, `console.error()` calls, and resource load failures are automatically batched and reported back to the agent. This triggers a new turn so the agent can diagnose and fix the issue. Errors are throttled to a maximum of 1 per 2 seconds to prevent floods.

## runjs — Execute Arbitrary JavaScript

The `runjs` tool executes JavaScript code directly, with two execution contexts:

### `context: 'iframe'` — DOM Access

Runs code in the page's iframe, with full access to the DOM, `document`, `window`, and all page APIs.

```javascript
runjs({
  context: 'iframe',
  code: `
    const el = document.getElementById('counter');
    const current = parseInt(el.textContent);
    el.textContent = current + 1;
    return el.textContent;
  `
})
```

Use this for DOM manipulation, animations, reading page state, or anything that needs access to the rendered page.

### `context: 'worker'` — Pure Computation (Default)

Runs code in a Web Worker with no DOM access. This is the default context.

```javascript
runjs({
  code: `
    const result = Array.from({ length: 1000 }, (_, i) => i * i)
      .filter(n => n % 7 === 0);
    return result.length;
  `
})
```

Use this for data processing, calculations, and anything that does not need the DOM.

### When to Use Each

| Use case | Context |
|----------|---------|
| Update page elements | `iframe` |
| Read DOM state | `iframe` |
| Run animations | `iframe` |
| Data processing | `worker` (default) |
| Complex calculations | `worker` (default) |
| JSON parsing/transformation | `worker` (default) |

**Tip:** `runjs` wraps your code in a function body — use `return` to get values back. Bare expressions return `undefined`.

**Tip:** Prefer embedding logic in `<script>` tags within `dom create` rather than making separate `runjs` calls. Reserve `runjs` for one-off debugging or late-binding logic.

## View States

Agents can be displayed in four view states, controlling how the UI and chat are shown:

| State | Chat | UI | Use Case |
|-------|------|----|----------|
| `max` | Visible | Visible | Full view — chat and UI side by side (desktop default) |
| `min` | Hidden | Hidden | Dashboard card, minimised |
| `ui-only` | Hidden | Full screen | Games, apps, immersive experiences |
| `chat-only` | Full screen | Hidden | Text-focused, mobile-friendly |

### Switching View States

Agents can request a view state change using the `view_state` tool:

```javascript
view_state({ state: 'ui-only' })
```

Users can always override the agent's request using the UI controls in the agent header.

### Mobile Behaviour

On mobile devices, only `ui-only` and `chat-only` are available (`max` is desktop only). The default is `chat-only` — users see only the chat panel. Switch to `ui-only` when the page is the primary experience. In `ui-only` mode, the user cannot see the chat panel, so the agent should communicate through the page, not text responses.

## CSS and Styling

Agents have full CSS control within their iframe. All standard CSS features work:

- Inline styles on elements
- `<style>` blocks in the page HTML
- External stylesheets via `<link>` tags
- CSS variables (custom properties)
- CSS animations and transitions
- Media queries for responsive design

```javascript
dom({
  action: 'create',
  html: `
    <style>
      :root { --primary: #2563eb; --bg: #f8fafc; }
      body { background: var(--bg); font-family: system-ui; }
      .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; }
      .btn { background: var(--primary); color: white; border: none; padding: 8px 16px; border-radius: 6px; }
    </style>
    <div class="card">
      <h2>Styled Card</h2>
      <button class="btn">Click me</button>
    </div>
  `
})
```

## Responsive Design

Agents can use media queries, flexbox, grid, and viewport units (`vh`, `vw`) to create responsive layouts. The iframe resizes with the browser viewport.

**Best practice:** Design pages to fit the viewport using flexbox/grid and `vh`/`vw` units. Avoid fixed pixel heights that cause overflow. Use scrolling layouts only when content genuinely requires it. Hub agents may be viewed from multiple browsers with different screen sizes simultaneously — always use responsive CSS rather than hard-coding dimensions.

## DOM Persistence

The page state (body innerHTML plus element attributes) is captured and restored across sessions. When a user returns to an agent, they see the page exactly as they left it.

For more on how agent data persists, see [Storage and State](Storage-And-State.md).

## Script Behaviour in DOM Updates

Scripts included in `dom create` and `dom modify` auto-execute. This means you can set up DOM structure and interactivity in a single call:

```javascript
dom({
  action: 'create',
  html: `
    <button id="btn">Click me</button>
    <div id="count">0</div>
    <script>
      var clicks = 0;
      document.getElementById('btn').onclick = function() {
        clicks++;
        document.getElementById('count').textContent = clicks;
      };
    </script>
  `
})
```

**Important:** Use `var` (not `const`/`let`) for top-level variables in scripts, or assign to `window`. This avoids "already declared" errors when DOM updates cause scripts to re-run:

```javascript
// Good — survives re-execution
var state = { count: 0 };
// or
window.state = { count: 0 };

// Bad — will error on second execution
const state = { count: 0 };  // "state is already declared"
```

## Best Practices

These patterns come from the built-in flo-cookbook skill that agents can load on demand:

- **Set initial UI immediately, refine later.** Use `dom create` to build the complete page in one call, then use `dom modify` for incremental updates.
- **Use semantic HTML.** Proper structure helps the agent understand and modify the page.
- **Use CSS variables for theming.** Define colours and spacing as custom properties so the agent can update the theme by changing a few values.
- **Prefer inline event handlers and `<script>` tags.** Embedding logic directly in the HTML avoids extra `runjs` calls and makes the page interactive immediately.
- **Use `var` for top-level script variables.** Prevents "already declared" errors when scripts re-run.
- **Do not use `alert()`, `confirm()`, or `prompt()`.** These are blocked in the sandboxed iframe. Use `flo.notify()`, `flo.ask()`, or build custom UI instead.
- **Do not use `dom modify` on `<script>` tags.** Browsers do not re-execute modified scripts. Rebuild the containing element or use `runjs` instead.

## Related Guides

- [Bidirectional Interactions](Bidirectional-Interactions.md) — How agents and users interact through the UI
- [Storage and State](Storage-And-State.md) — Persistence and reactive state
- [Getting Started](Getting-Started.md) — First steps with [flo.monster](https://flo.monster) 
