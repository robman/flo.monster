# Files

Agents have access to a file system for persistent storage. The backing implementation depends on where the agent is running: browser-only agents use the browser's Origin Private File System (OPFS), while hub-connected agents use the real server filesystem.

## Two File Systems

| | Browser (OPFS) | Hub (Filesystem) |
|---|---|---|
| **Backing store** | Browser Origin Private File System | Disk at `~/.flo-monster/agents/{id}/files/` |
| **Persistence** | Session-scoped, tied to the opaque origin | Survives browser close, server restarts |
| **Isolation** | Per-agent opaque origin (no path traversal possible) | Sandboxed to agent directory (symlink traversal blocked) |
| **Access** | `files` tool only | `files` tool + `bash` + `filesystem` tools |

Both use the same `files` tool API, so agent code works identically regardless of where it runs.

## The `files` Tool

### Write a file

```
files({ action: 'write_file', path: 'notes.txt', content: 'Hello, world!' })
```

Creates or overwrites a file at the given path.

### Read a file

```
files({ action: 'read_file', path: 'notes.txt' })
```

Returns the file content as text.

### List files

```
files({ action: 'list', pattern: '*.md' })
```

Lists files matching the glob pattern. Without a pattern, lists all files.

### Delete a file

```
files({ action: 'delete', path: 'notes.txt' })
```

Removes the specified file.

### Read frontmatter

```
files({ action: 'frontmatter', pattern: '*.srcdoc.md' })
```

Reads YAML frontmatter from matching `.md` files. Useful for discovering saved UI skins and templates with their metadata.

## Browser Files (OPFS)

When an agent runs in the browser without a hub connection, the `files` tool uses the browser's Origin Private File System:

- Files persist within the agent's session but are tied to the opaque iframe origin
- Each agent is completely isolated -- there is no way to access another agent's files
- No path traversal is possible due to the opaque origin sandbox
- Files may not survive browser data clearing

## Hub Files

When connected to a hub, the same `files` tool API is backed by the real filesystem:

- Files are stored on disk at `~/.flo-monster/agents/{id}/files/`
- Files persist across browser sessions, server restarts, and device changes
- The agent's file access is sandboxed to its own directory
- Symlink traversal is blocked -- symlinks that would escape the sandbox are rejected
- The hub also provides `bash` and `filesystem` tools for broader file system access (still sandboxed)

## Common Patterns

### Saving agent memory

```js
await flo.callTool('files', { action: 'write_file', path: 'memory.md', content: '...' })
```

Agents can maintain persistent memory across sessions by writing to files on startup and reading them back when they resume.

### Loading configuration on startup

```js
var config = await flo.callTool('files', { action: 'read_file', path: 'config.json' })
```

Check for existing files at session start to resume context and preferences.

### Managing UI skins

Save and load `.srcdoc` files to manage multiple UI layouts. Use frontmatter in companion `.srcdoc.md` files to store metadata like title and description. See [Templates](Templates.md) for details.

### Listing available files

```js
var files = await flo.callTool('files', { action: 'list', pattern: '*.md' })
```

Discover what files exist before reading them.

## See Also

- [Storage and State](Storage-And-State.md) -- key-value storage and reactive state
- [Templates](Templates.md) -- saving and loading UI skins with `.srcdoc` files
- [Installing a Hub](Installing-A-Hub.md) -- setting up a hub for persistent file storage
