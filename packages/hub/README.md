# flo.monster Hub

The hub server provides system-level tools (bash, filesystem) to flo.monster agents running in the browser. It connects via WebSocket and can run locally or on a remote machine.

## Quick Start

```bash
# From the flo.monster root directory
cd packages/hub

# Initialize config with auth token
pnpm dev init

# Start the hub
pnpm dev
```

The hub will start on `ws://127.0.0.1:8765` by default.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Browser (flo.monster UI)                                │
│   - Loads from Vite dev server (https://localhost:5173) │
│   - Connects to hub via WebSocket                       │
│   - Agents get bash/filesystem tools from hub           │
└─────────────────────────────────────────────────────────┘
            │
            │ WebSocket (ws://host:8765)
            ▼
┌─────────────────────────────────────────────────────────┐
│ Hub Server                                              │
│   - Provides bash tool (execute shell commands)         │
│   - Provides filesystem tool (read/write/list files)    │
│   - Can proxy fetch requests (bypass browser CORS)      │
│   - Can run agents headlessly (Phase 7)                 │
└─────────────────────────────────────────────────────────┘
```

## Configuration

Config file: `~/.flo-monster/hub.json`

### Generate Default Config

```bash
pnpm dev init
```

This creates a config with a random auth token.

### Config Options

```json
{
  "port": 8765,
  "host": "127.0.0.1",
  "name": "My Hub",
  "authToken": "your-secret-token",
  "localhostBypassAuth": true,
  "tools": {
    "bash": {
      "enabled": true,
      "allowedCommands": [],
      "blockedCommands": ["rm -rf /", "mkfs", "dd if="]
    },
    "filesystem": {
      "enabled": true,
      "allowedPaths": ["/home", "/tmp"],
      "blockedPaths": ["/etc/shadow", "/etc/passwd"]
    }
  },
  "fetchProxy": {
    "enabled": true,
    "allowedPatterns": ["*"],
    "blockedPatterns": []
  }
}
```

### Config Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `port` | number | 8765 | WebSocket server port |
| `host` | string | "127.0.0.1" | Bind address. Use "0.0.0.0" for remote access |
| `name` | string | "flo.monster Hub" | Friendly name shown in browser UI |
| `authToken` | string | undefined | Required for remote connections |
| `localhostBypassAuth` | boolean | true | Skip auth for localhost connections |
| `tools.bash.enabled` | boolean | true | Enable bash tool |
| `tools.bash.allowedCommands` | string[] | [] | Whitelist (empty = allow all except blocked) |
| `tools.bash.blockedCommands` | string[] | [...] | Commands to block (substring match) |
| `tools.filesystem.enabled` | boolean | true | Enable filesystem tool |
| `tools.filesystem.allowedPaths` | string[] | ["/home", "/tmp"] | Allowed path prefixes |
| `tools.filesystem.blockedPaths` | string[] | [] | Blocked path prefixes (checked first) |
| `fetchProxy.enabled` | boolean | true | Enable fetch proxying |
| `fetchProxy.allowedPatterns` | string[] | ["*"] | URL patterns to allow |
| `fetchProxy.blockedPatterns` | string[] | [] | URL patterns to block |

## CLI Commands

```bash
# Start the hub server
pnpm dev

# Initialize config with random auth token
pnpm dev init

# Generate a new auth token (prints to stdout)
pnpm dev token

# Show help
pnpm dev -- --help
```

## Running on a Remote VM

### 1. Configure for Remote Access

Edit `~/.flo-monster/hub.json`:

```json
{
  "host": "0.0.0.0",
  "authToken": "generate-a-strong-token-here",
  "localhostBypassAuth": false
}
```

### 2. Generate Auth Token

```bash
pnpm dev token
# Output: Generated token: abc123...
```

Copy this token - you'll need it in the browser.

### 3. Start the Hub

```bash
pnpm dev
# Output: Hub "My Hub" listening on ws://0.0.0.0:8765
```

### 4. Firewall

Open port 8765 (or your configured port):

```bash
# Ubuntu/Debian
sudo ufw allow 8765/tcp

# CentOS/RHEL
sudo firewall-cmd --add-port=8765/tcp --permanent
sudo firewall-cmd --reload
```

### 5. Connect from Browser

In the flo.monster UI:
1. Open Settings (gear icon)
2. Find "Hub Connections" section
3. Click "Add Hub"
4. Enter:
   - URL: `ws://your-vm-ip:8765`
   - Name: `My Remote Hub`
   - Token: (the token you generated)
5. Click Connect

## Security Considerations

### Authentication

- **Always use a strong auth token** for remote hubs
- The `localhostBypassAuth` option is convenient for local development but should be `false` for remote access
- Tokens are sent in the WebSocket handshake, so use WSS (WebSocket Secure) in production

### Tool Restrictions

**Bash tool:**
- Use `blockedCommands` to prevent dangerous operations
- Use `allowedCommands` (whitelist) for maximum security
- Commands are checked via substring match

**Filesystem tool:**
- `allowedPaths` restricts which directories can be accessed
- `blockedPaths` takes precedence over `allowedPaths`
- Symlink traversal outside allowed paths is blocked

### Recommended Production Config

```json
{
  "host": "0.0.0.0",
  "authToken": "long-random-token-here",
  "localhostBypassAuth": false,
  "tools": {
    "bash": {
      "enabled": true,
      "blockedCommands": [
        "rm -rf /",
        "rm -rf /*",
        "mkfs",
        "dd if=",
        ":(){ :|:& };:",
        "> /dev/sd",
        "chmod -R 777 /",
        "curl | sh",
        "wget | sh"
      ]
    },
    "filesystem": {
      "enabled": true,
      "allowedPaths": ["/home/agent/workspace"],
      "blockedPaths": [
        "/home/agent/.ssh",
        "/home/agent/.gnupg",
        "/home/agent/.aws"
      ]
    }
  }
}
```

## TLS/SSL Configuration

For secure WebSocket connections (wss://), you can configure TLS with certificate files.

### Config Options

Add a `tls` section to your `~/.flo-monster/hub.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "authToken": "your-secret-token",
  "localhostBypassAuth": false,
  "tls": {
    "certFile": "/etc/letsencrypt/live/yourdomain.com/fullchain.pem",
    "keyFile": "/etc/letsencrypt/live/yourdomain.com/privkey.pem"
  },
  "tools": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `tls.certFile` | string | Path to the certificate file (PEM format). For Let's Encrypt, use `fullchain.pem` |
| `tls.keyFile` | string | Path to the private key file (PEM format). For Let's Encrypt, use `privkey.pem` |

### Using Let's Encrypt Certificates

1. **Install certbot:**
   ```bash
   sudo apt install certbot
   ```

2. **Obtain a certificate:**
   ```bash
   sudo certbot certonly --standalone -d yourdomain.com
   ```

3. **Configure the hub:**
   ```json
   {
     "tls": {
       "certFile": "/etc/letsencrypt/live/yourdomain.com/fullchain.pem",
       "keyFile": "/etc/letsencrypt/live/yourdomain.com/privkey.pem"
     }
   }
   ```

4. **Set permissions** (the hub process needs read access):
   ```bash
   # Option 1: Run hub as root (not recommended)
   # Option 2: Add your user to the ssl-cert group
   sudo usermod -aG ssl-cert $USER
   sudo chgrp ssl-cert /etc/letsencrypt/live/yourdomain.com/privkey.pem
   sudo chmod g+r /etc/letsencrypt/live/yourdomain.com/privkey.pem
   ```

5. **Start the hub:**
   ```bash
   pnpm dev
   # Output: Hub server started on wss://0.0.0.0:8765
   ```

### Connecting from the Browser

When TLS is enabled, use `wss://` instead of `ws://` in the browser:

1. Open Settings in the flo.monster UI
2. Add Hub with URL: `wss://yourdomain.com:8765`
3. Enter your auth token
4. Click Connect

### Self-Signed Certificates (Development)

For development, you can use self-signed certificates:

```bash
# Generate self-signed cert
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes

# Configure hub
{
  "tls": {
    "certFile": "./cert.pem",
    "keyFile": "./key.pem"
  }
}
```

Note: Browsers will show a security warning for self-signed certificates. You may need to visit `https://your-host:8765` first and accept the certificate before WebSocket connections will work.

## Tools Provided

### bash

Execute shell commands on the hub host.

```typescript
{
  name: 'bash',
  input: {
    command: string,    // Required: command to execute
    cwd?: string,       // Working directory
    timeout?: number    // Timeout in ms (default: 30000)
  }
}
```

Example agent usage:
```
I'll check what files are in the current directory.
[uses bash tool with command: "ls -la"]
```

### filesystem

File system operations on the hub host.

```typescript
{
  name: 'filesystem',
  input: {
    action: 'read' | 'write' | 'list' | 'mkdir' | 'delete' | 'stat',
    path: string,
    content?: string   // Required for 'write' action
  }
}
```

Actions:
- `read` - Read file contents
- `write` - Write content to file (creates if not exists)
- `list` - List directory contents
- `mkdir` - Create directory (recursive)
- `delete` - Delete file or empty directory
- `stat` - Get file/directory metadata

## Troubleshooting

### "Connection refused"

- Check the hub is running: `pnpm dev`
- Check firewall allows the port
- Verify the URL includes `ws://` or `wss://`

### "Authentication failed"

- Verify the token matches exactly
- Check `localhostBypassAuth` setting
- Ensure you're connecting from the expected IP

### "Tool not found"

- Check the tool is enabled in config
- Reconnect to refresh tool list

### "Path not allowed"

- Check `allowedPaths` includes the path prefix
- Check `blockedPaths` doesn't block it
- Paths must be absolute

### "Command blocked"

- Check `blockedCommands` for substring matches
- If using `allowedCommands`, ensure command is listed

## Development

```bash
# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Type check
./scripts/typecheck.sh
```

## Protocol Reference

The hub uses a JSON-based WebSocket protocol. See `packages/core/src/types/protocol.ts` for full type definitions.

### Connection Flow

1. Client connects to WebSocket
2. Client sends: `{ type: 'auth', token: 'xxx' }`
3. Hub sends: `{ type: 'auth_result', success: true, hubId: 'xxx', hubName: 'xxx' }`
4. Hub sends: `{ type: 'announce_tools', tools: [...] }`
5. Client can now send tool requests

### Tool Execution

Request:
```json
{ "type": "tool_request", "id": "req-1", "name": "bash", "input": { "command": "ls" } }
```

Response:
```json
{ "type": "tool_result", "id": "req-1", "result": "file1.txt\nfile2.txt" }
```
