# Hooks

Hooks let you intercept agent actions before or after they happen. They are like middleware for agent tool calls -- you can block dangerous operations, log activity, automate workflows, or run custom code in response to agent behaviour.

Of course, your agents can just create this for you if you ask them.

## Hook Types

There are six hook types, each firing at a different point in the agent lifecycle:

| Hook | When It Fires | What It Can Do |
|------|---------------|----------------|
| `PreToolUse` | Before a tool executes | Block, allow, modify, or log the call |
| `PostToolUse` | After a tool completes | Log results, run side effects, trigger automation |
| `UserPromptSubmit` | Before the agent processes a user message | Validate or transform input |
| `Stop` | When the agent attempts to stop | Prevent premature stops |
| `AgentStart` | When the agent starts | Initialise resources |
| `AgentEnd` | When the agent terminates | Clean up, send notifications |

## Declarative Rules

Hooks are configured as declarative rules -- no code required for common patterns. In the browser, open **Settings > Hooks** and click **Add Hook Rule**. On a hub, add rules to `hub.json`.

### Browser Hook Example

Block any bash command containing `rm -rf`:

```
Event Type: PreToolUse
Matcher: ^bash$
Action: script
JavaScript:
  if (toolInput.command?.includes('rm -rf')) {
    return { decision: 'deny', reason: 'Dangerous command blocked' };
  }
```

### Hub Shell Hook Example (hub.json)

Hub hooks execute shell commands (not declarative actions). They use template variables that are shell-escaped for security:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": "echo '[AUDIT] Agent running bash: {{input.command}}' >> /var/log/flo-audit.log"
      }
    ],
    "PostToolUse": [
      {
        "matcher": "files",
        "command": "cd {{sandbox}} && git add -A && git commit -m 'auto-save after {{toolName}}' 2>/dev/null || true",
        "continueOnError": true
      }
    ]
  }
}
```

## Hook Actions

Each hook rule specifies an action to take when the rule matches:

| Action | Behaviour |
|--------|-----------|
| `deny` | Block the operation. An optional `reason` message is returned to the agent. |
| `allow` | Explicitly allow the operation, overriding later deny rules. |
| `log` | Log the hook context to the console and continue execution. |
| `script` | Execute custom JavaScript in the agent's sandboxed context (browser hooks only). |

## Tool Name Matching

The `matcher` field is a regex pattern tested against the tool name:

| Pattern | Matches |
|---------|---------|
| `^bash$` | Exactly the `bash` tool |
| `^(bash\|write_file)$` | Either `bash` or `write_file` |
| `fetch\|web_fetch` | Any tool containing `fetch` or `web_fetch` |
| `write_` | Tools starting with `write_` |
| `.*` | Any tool (wildcard) |
| *(omitted)* | Any tool (same as `.*`) |

## Input Matching

`inputMatchers` checks tool input fields using regex patterns. All specified patterns must match (AND logic):

```json
{
  "matcher": "^write_file$",
  "inputMatchers": {
    "path": "\\.env$",
    "content": "API_KEY"
  },
  "action": "deny",
  "reason": "Cannot write API keys to .env files"
}
```

This rule only fires when the tool is `write_file` AND the path ends with `.env` AND the content contains `API_KEY`.

If a specified field does not exist in the tool input or is not a string, the matcher does not apply and the rule is skipped.

More examples:

| Input Matcher | Effect |
|---------------|--------|
| `{ "url": ".*\\.exe$" }` | Blocks URLs ending in `.exe` |
| `{ "command": "rm\\s+-rf" }` | Blocks commands containing `rm -rf` |
| `{ "path": "\\.(env\|key\|pem)$" }` | Blocks writes to sensitive file types |

## Writing Hook Scripts (Browser)

Scripts run in the agent's sandboxed iframe/worker context. They have access to hook data and can call tools, but cannot access shell internals.

### Available Variables

| Variable | Available In | Description |
|----------|-------------|-------------|
| `type` | All hooks | The hook type (e.g., `'pre_tool_use'`) |
| `agentId` | All hooks | The agent's identifier |
| `toolName` | PreToolUse, PostToolUse | Name of the tool being called |
| `toolInput` | PreToolUse, PostToolUse | Tool input parameters (object) |
| `toolResult` | PostToolUse only | `{ content, is_error? }` -- the tool's result |
| `prompt` | UserPromptSubmit only | The user's message text |
| `stopReason` | Stop only | Why the agent is stopping |

### Available Functions

| Function | Description |
|----------|-------------|
| `callTool(name, input)` | Execute any available tool. Returns `{ content, is_error? }`. |
| `log(...args)` | Log messages to the browser console with a hook prefix. |

### Returning Decisions

Scripts can return a decision object to override the hook outcome:

```javascript
// Block the operation
return { decision: 'deny', reason: 'Not allowed' };

// Explicitly allow
return { decision: 'allow' };

// No return = continue to next hook (default behaviour)
```

### callTool Routing

The `callTool` function routes to the appropriate handler automatically:

| Tool | Routed To | Requires |
|------|-----------|----------|
| `bash`, `read_file`, `write_file`, `list_directory` | Hub | Connected hub |
| `runjs`, `dom`, `fetch`, `storage`, `files` | Agent worker | Active agent |

### Script Examples

**Log all tool calls:**

```javascript
// Event: PreToolUse, Action: script
log('Tool called:', toolName, 'with input:', JSON.stringify(toolInput));
```

**Block writes to sensitive files:**

```javascript
// Event: PreToolUse, Matcher: ^write_file$, Action: script
if (toolInput.path?.includes('.env')) {
  return { decision: 'deny', reason: 'Cannot modify .env files' };
}
```

**Auto-format Python files after write:**

```javascript
// Event: PostToolUse, Matcher: ^write_file$, Action: script
if (toolInput.path?.endsWith('.py')) {
  await callTool('bash', { command: `black ${toolInput.path}` });
  log('Formatted:', toolInput.path);
}
```

**Update the agent's DOM after tool use:**

```javascript
// Event: PostToolUse, Action: script
await callTool('runjs', {
  context: 'iframe',
  code: 'var d = document.createElement("div"); d.className = "notification"; d.textContent = "Tool ' + toolName + ' completed"; document.body.appendChild(d);'
});

// or dom (but this reads then appends)
await callTool('dom', {
  action: 'modify',
  selector: 'body',
  innerHTML: document.body.innerHTML + '<div class="notification">Tool ' + toolName + ' completed</div>'
});
```

> **Note:** `alert()` is not available in the sandboxed execution environment. Use `log()` for debugging output, or build UI elements in the agent's DOM.

## Hub Shell Hooks

On the hub, hooks can execute shell commands instead of JavaScript. These are configured in `hub.json` (or via the `--config` flag).

### Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^bash$",
        "command": "echo 'Agent running: {{input.command}}' >> /var/log/flo-audit.log",
        "continueOnError": true
      }
    ],
    "PostToolUse": [
      {
        "matcher": "^write_file$",
        "command": "cd {{sandbox}} && git add -A && git commit -m 'auto-save after {{toolName}}' 2>/dev/null || true"
      }
    ]
  }
}
```

### Template Variables

Hub hook commands support variable substitution:

| Variable | Description |
|----------|-------------|
| `{{toolName}}` | Name of the tool |
| `{{input.fieldName}}` | Value from the tool's input (e.g., `{{input.command}}`, `{{input.path}}`) |
| `{{result}}` | Tool result content (PostToolUse only) |
| `{{sandbox}}` | The agent's sandbox directory path |

All template values are **shell-escaped** using POSIX single-quote wrapping for security. You do not need to add your own escaping.

### Behaviour

- **PreToolUse hooks:** A non-zero exit code blocks the tool execution
- **PostToolUse hooks:** Runs after the tool completes; exit code is logged but does not affect the result
- **`timeout`:** Default 5 seconds (configurable in milliseconds)
- **`continueOnError`:** Default `true` -- failures are logged but do not block the operation

## Priority and Ordering

Hooks are evaluated in priority order (higher numbers first):

1. Hooks are sorted by `priority` (higher runs first, default is 0)
2. Evaluation stops immediately on a `deny` decision
3. An `allow` is remembered but evaluation continues (a later `deny` still wins)
4. If no explicit decision is made, the operation proceeds normally

```
Priority 100: deny   --> DENY (stops here)
Priority 50:  allow  --> (continues evaluating)
Priority 10:  log    --> ALLOW (from priority 50)
```

## Use Cases

- **Audit logging** -- Log all tool calls to a file for review
- **Access control** -- Block specific tools or restrict URL patterns
- **Auto-save** -- Commit files to git after every write
- **Validation** -- Check tool inputs before execution (reject dangerous patterns)
- **Notifications** -- Send alerts or update the agent's DOM on specific actions
- **Code formatting** -- Run linters or formatters after file writes

## Hook Persistence

Hooks configured for an agent persist with the agent session. When an agent is persisted to a hub, its hooks are included in the session dependencies and continue to function on the hub side.

Skill-scoped hooks (defined within a skill's frontmatter) are registered automatically when the skill is invoked and cleaned up when the agent session ends. You do not need to configure these manually -- they come with the skill. See [Skills](Skills.md) for details.

## Error Handling

By default, if a hook script throws an error, the error is logged but does not block the operation (`continueOnError: true`).

To make errors block the operation:

1. Uncheck **Continue on error** when creating a browser hook
2. Set `"continueOnError": false` for hub hooks

With `continueOnError` disabled, a script error results in a `deny` decision with the error message as the reason.

## Security

- **Scripts run in the agent sandbox** -- Hook scripts execute in the agent's iframe/worker context, not the shell. They have the same isolation as agent code.
- **callTool respects existing security** -- Hub tools require a connected hub; browser tools execute in the agent sandbox.
- **No shell access from scripts** -- Scripts cannot access shell DOM, storage, or APIs directly.
- **Hub hook commands are shell-escaped** -- Template values use POSIX single-quote wrapping to prevent injection. Never interpolate unsanitised values into shell commands yourself -- the system handles this.
- **Skill-scoped hooks are automatic** -- Registered on skill invocation, cleaned up on session end.

## See Also

- [Skills](Skills.md) -- On-demand knowledge and skill-scoped hooks
- [Installing a Hub](Installing-A-Hub.md) -- Set up a hub for server-side hooks and system tools
- [Security](../Security.md) -- The full security model and invariants
- [Getting Started](Getting-Started.md) -- First steps with [flo.monster](https://flo.monster) 
