# Installing a Hub

How to install and configure your own [flo.monster](https://flo.monster) hub server -- the optional server that gives your agents extra superpowers.

## What Is the Hub?

By default, [flo.monster](https://flo.monster) agents run entirely in your browser. They are powerful, but they are tied to that browser.

A hub is an optional server that removes that limitation. When you connect your browser to a hub, your agents gain:

- **Persistence** -- agents can continue running even when the browser is closed 
- **System tools** -- bash shell, filesystem access on the server
- **Fetch proxy** -- server-side HTTP requests that bypass CORS restrictions
- **Multi-browser reach** -- one agent, many displays across different devices
- **Push notifications** -- agents can notify you on your phone
- **Scheduling** -- cron jobs and event triggers for autonomous execution
- **Shared API keys** -- the hub operator may provide keys so users don't need their own

The hub is open source and runs on your own hardware. You control the data, the keys, and the access.

## Automated Installation

The fastest way to get a hub running is the automated installer.

### macOS / Linux

```bash
curl -fsSL https://flo.monster/install/hub.sh | bash
```

### Windows

```powershell
Invoke-WebRequest -Uri https://flo.monster/install/hub.ps1 -OutFile hub.ps1; .\hub.ps1
```

### Two-Step Alternative

If you prefer to review the script before running it:

```bash
curl -fsSL https://flo.monster/install/hub.sh -o hub.sh
less hub.sh    # review
bash hub.sh
```

### What the Installer Detects

The installer examines your environment and adapts:

| Environment | Behaviour |
|-------------|-----------|
| macOS | Creates a Multipass VM to run the hub |
| Linux desktop | Creates a Multipass VM to run the hub |
| Linux server (headless) | Installs directly on the host |

During installation, you will be prompted for:

- **Email address** -- for TLS certificate registration (if using a domain)
- **Setup type** -- local only (LAN access) or domain + TLS (internet access)
- **Domain name** -- if you chose domain + TLS

### What the Installer Does

1. **Creates OS users** -- `flo-hub` (runs the server process) and `flo-agent` (runs agent bash commands with reduced privileges)
2. **Installs Node.js** via nvm (version 22+)
3. **Clones the repository** and installs dependencies
4. **Generates `hub.json`** with a secure authentication token
5. **Optionally configures Caddy** for automatic TLS certificate provisioning
6. **Optionally creates a systemd service** for automatic startup on boot

After installation, the hub is running and ready to accept connections.

## Manual Installation

If you prefer full control, you can install manually.

### Prerequisites

- Node.js 22 or later
- git
- pnpm (recommended) or npm

### Steps

```bash
# Clone the repository
git clone https://github.com/robman/flo.monster.git
cd flo.monster

# Install dependencies
pnpm install

# Initialise hub configuration
pnpm --filter @flo-monster/hub exec flo-hub init

# Start the hub
pnpm --filter @flo-monster/hub exec flo-hub
```

Or install globally:

```bash
npm install -g @flo-monster/hub
flo-hub init
flo-hub
```

The `init` command creates `~/.flo-monster/hub.json` with default settings and generates a secure authentication token. The server starts on `ws://127.0.0.1:8765` by default.

## Connecting from the Browser

Once your hub is running:

1. Open [flo.monster](https://flo.monster) in your browser
2. Open **Settings** (the gear icon)
3. Under **Hub Connection**, enter:
   - **URL**: `wss://your-domain.com:8765` for TLS, or `ws://127.0.0.1:8765` for local (not recommended)
   - **Token**: your authentication token (from `hub.json` or shown during install)
4. Click **Connect**

### Connection Rules

- `ws://` is allowed for localhost and private IP addresses (RFC 1918: `10.*`, `172.16-31.*`, `192.168.*`)
- `wss://` (TLS) is required for all public IP addresses and domain names
- This is enforced by the browser client and cannot be bypassed -- it prevents credentials from being sent in plaintext over the internet

## Configuration

All hub configuration lives in `~/.flo-monster/hub.json`. Edit this file and restart the hub to apply changes.

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `host` | `"127.0.0.1"` | Bind address. Use `"0.0.0.0"` for remote access. |
| `port` | `8765` | WebSocket server port |
| `authToken` | *(generated)* | Authentication token for connections |
| `localhostBypassAuth` | `true` | Skip token check for localhost connections (development only) |
| `trustProxy` | `false` | Enable when behind a reverse proxy (nginx, Caddy, Cloudflare) |
| `tools.bash.runAsUser` | -- | OS user for agent bash commands (e.g., `"flo-agent"`) |
| `tools.bash.mode` | `"restricted"` | `"restricted"` (command filtering enabled) or `"unrestricted"` |

### Example Configuration

```json
{
  "host": "0.0.0.0",
  "port": 8765,
  "name": "My Hub",
  "authToken": "your-secure-token-here",
  "localhostBypassAuth": false,
  "trustProxy": true,

  "tools": {
    "bash": {
      "enabled": true,
      "mode": "restricted",
      "runAsUser": "flo-agent"
    },
    "filesystem": {
      "enabled": true,
      "allowedPaths": ["/home/user/projects"],
      "blockedPaths": ["/home/user/.ssh", "/home/user/.gnupg", "/home/user/.aws"]
    }
  },

  "fetchProxy": {
    "enabled": true,
    "allowedPatterns": ["*"],
    "blockedPatterns": ["localhost", "127.*", "10.*", "192.168.*"]
  },

  "sharedApiKeys": {
    "anthropic": "sk-ant-api03-..."
  },

  "failedAuthConfig": {
    "maxAttempts": 5,
    "lockoutMinutes": 15
  }
}
```

## Security

The hub provides multiple layers of defence to protect your system from agent-executed commands.

### OS User Isolation

When configured, agent bash commands run as a dedicated low-privilege OS user (`flo-agent` by default), not as the hub process user. This provides OS-level isolation -- even if an agent manages to bypass command filtering, it cannot escalate to hub-level privileges.

Set up with the automated installer, or manually:

```bash
sudo flo-admin setup            # Creates 'flo-agent' user, configures sudoers
sudo flo-admin setup --user me  # Custom username
```

### Per-Agent Sandboxes

Each hub-persisted agent gets its own sandboxed directory under the configured `sandboxPath`. Agents cannot access other agents' directories or escape to parent paths. Symlink traversal outside sandbox boundaries is detected and blocked. If you want to share files with your agent (e.g. a git repo) then copy or move them into here.

### Command Filtering

In `restricted` mode (the default), the hub blocks 45+ dangerous command patterns including: `crontab`, `systemctl`, `kill`, `apt`/`apt-get`, `shutdown`, `mount`, `iptables`, `rm -rf /`, `mkfs`, and more. The filter detects compound commands (`;`, `&&`, `||`, `|`), wrapper commands (`bash -c`, `sh -c`, `env`), and shell metacharacters that could bypass splitting.

### Authentication

- Set a strong, random token for any non-localhost deployment
- Failed authentication attempts are rate-limited (default: 5 attempts, then 15-minute lockout)
- Generate a secure token: `flo-hub token`

### TLS for Production

For any deployment accessible beyond localhost, use TLS:

```json
{
  "tls": {
    "certFile": "/etc/ssl/certs/hub.pem",
    "keyFile": "/etc/ssl/private/hub.key"
  }
}
```

Then connect using `wss://` instead of `ws://`. The automated installer can configure Caddy for automatic certificate provisioning.

### File Permissions

The installer sets restrictive file permissions: `hub.json` is `0600` (owner read/write only), the home directory is `0750`. Sensitive files containing API keys or session data are never world-readable.

For a comprehensive security hardening guide, see [Security](../Security.md).

## Management Commands

### Multipass Installation (macOS / Linux Desktop)

```bash
multipass shell flo-hub           # SSH into the VM
multipass stop flo-hub            # Stop the VM
multipass start flo-hub           # Start the VM
multipass delete flo-hub          # Remove the VM entirely
```

### Direct Installation (Linux Server)

```bash
systemctl status flo-hub          # Check hub status
systemctl stop flo-hub            # Stop the hub
systemctl start flo-hub           # Start the hub
systemctl restart flo-hub         # Restart after config changes
journalctl -u flo-hub -f          # Stream hub logs
```

### Admin CLI

The `flo-admin` CLI provides management commands for running hubs:

```bash
flo-admin agents list                    # List running agents
flo-admin agents inspect <agent-id>      # Agent details and recent messages
flo-admin agents log <agent-id>          # Conversation history
flo-admin agents schedules               # List all scheduled tasks
flo-admin agents pause <agent-id>        # Pause an agent
flo-admin agents stop <agent-id>         # Stop an agent
flo-admin connections list               # Show connected clients
flo-admin stats                          # Server statistics
```

## Shared API Keys

If you're running a hub then you can store your API keys in your hub config so you don't have to enter them again in each new browser you use.

### Configuration

Add your keys to `hub.json`:

```json
{
  "sharedApiKeys": {
    "anthropic": "sk-ant-api03-your-key-here",
    "openai": "sk-your-openai-key-here",
    "gemini": "your-gemini-key-here"
  },
  "providers": {
    "ollama": {
      "endpoint": "http://192.168.0.1:11434"
    }
  }
}
```

Supported providers: `anthropic`, `openai`, `gemini`, `ollama`.

### How It Works

1. When a browser connects, the hub announces which providers have shared keys available
2. In the browser, the user chooses to use their own key or the hub's shared key
3. When using shared keys, API requests are proxied through the hub
4. The browser never sees the actual API key -- it stays on the server

### Browser Setup

1. Connect to a hub that has shared keys configured
2. In **Settings**, under **API Key Source**, choose "Use hub's shared key"
3. Select which connected hub to use
4. The hub handles API authentication transparently

## Persisting Agents

Once connected to a hub, you can persist browser agents to the hub for always-on execution:

1. Create and configure an agent in the browser
2. Click the **monitor icon** in the agent header to see mode options
3. Click to persist to the hub
4. The agent's state, conversation, storage, and files transfer to the hub
5. The hub now runs the agent's brain -- it survives browser close

When a browser reconnects, it becomes a display surface for the hub-persisted agent. The hub is the authority for all state; the browser renders and relays user input.

## Developer Testing

If you're working on the installer itself, you can test changes without deploying to production by overriding two environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `FLO_BASE_URL` | `https://flo.monster` | Where the installer downloads its cloud-init template from. Set to a local directory path to use local files instead. |
| `FLO_REPO_BRANCH` | *(default branch)* | Git branch to clone inside the VM. Test your changes on a pushed branch without merging to main. |
| `FLO_REPO_URL` | `https://github.com/robman/flo.monster.git` | Git repository URL. Override to test against a fork. |

### Example: Test a Feature Branch

Push your branch to GitHub, then run the installer against it using the local cloud-init template:

```bash
FLO_BASE_URL=./scripts FLO_REPO_BRANCH=my-feature-branch ./scripts/install-hub.sh
```

This uses the local `hub-cloud-init.yaml` (no CDN needed) and clones your branch inside the VM instead of main.

### Example: Test a Fork

```bash
FLO_REPO_URL=https://github.com/yourfork/flo.monster.git FLO_REPO_BRANCH=my-branch ./scripts/install-hub.sh
```

### Windows

```powershell
$env:FLO_BASE_URL = "C:\path\to\repo\scripts"
$env:FLO_REPO_BRANCH = "my-feature-branch"
.\scripts\install-hub.ps1
```

The installer logs any active overrides at startup so you can confirm which values are in effect.

## Troubleshooting

### Connection Refused

- Verify the hub is running: check with `systemctl status flo-hub` or `flo-hub` in the terminal
- Ensure the host and port match your connection settings
- For remote access, check that the firewall allows the configured port

### Authentication Failed

- Verify your token matches the `authToken` in `hub.json`
- If connecting from localhost, ensure `localhostBypassAuth` is `true`
- If locked out, wait for the lockout period to expire (default 15 minutes)

### Hub-Persisted Agent Not Responding

- Check that the agent is not paused: `flo-admin agents list`
- Review agent logs: `flo-admin agents log <agent-id>`
- Verify API keys are configured -- the hub needs keys for persisted agents
- Restart the agent: `flo-admin agents kill <agent-id>`, then resume from the browser

## What Each Setup Unlocks

flo.monster runs over HTTPS, so PWA installation and push notifications work regardless of how your hub is connected. The hub setup tier determines access scope, not feature availability.

| | Browser only | Hub on LAN | Hub with public domain |
|---|---|---|---|
| PWA install | yes | yes | yes |
| Push notifications | -- | yes | yes |
| Agent persistence | -- | yes | yes |
| System tools (bash, filesystem) | -- | yes | yes |
| Scheduling (cron, event triggers) | -- | yes | yes |
| Fetch proxy (bypass CORS) | -- | yes | yes |
| Multi-browser (same network) | -- | yes | yes |
| Multi-browser (anywhere) | -- | -- | yes |
| WebSocket encryption | n/a | no (ws://) | yes (wss://) |

**Browser only** -- agents run in the browser tab and stop when it closes. No server needed.

**Hub on LAN** -- full hub features. Push notifications work because the hub sends outbound to push services (FCM/APNs) -- it does not need to be publicly reachable. Credentials traverse the LAN unencrypted over `ws://`.

**Hub with public domain** -- same features, plus access from any network and encrypted transport via `wss://`. Requires a domain with DNS pointing to a public IP, and the automated installer configures Caddy for automatic TLS certificate provisioning.

## Using Dynamic DNS (No Domain Required)

You don't need to own a domain name to get a public hub with TLS. If your home router supports Dynamic DNS (DDNS), you can use a free DDNS hostname instead. This gives you encrypted `wss://` connections and access from anywhere -- the same as a "real" domain.

### How It Works

Dynamic DNS services give you a hostname like `myhub.duckdns.org` that always points to your home IP address, even when your ISP changes it. Your router (or a small client running on your network) keeps the DNS record updated automatically.

Combined with port forwarding, this makes your hub reachable from the internet -- and Caddy handles TLS certificates automatically.

### Step 1: Choose a DDNS Provider

Many home routers have built-in support for one or more of these services:

| Provider | Free tier | Notes |
|----------|-----------|-------|
| [DuckDNS](https://www.duckdns.org) | Yes (unlimited) | Simple, no account needed beyond login |
| [No-IP](https://www.noip.com) | Yes (3 hostnames) | Widely supported by routers |
| [Dynu](https://www.dynu.com) | Yes | Supports custom domains too |
| [FreeDNS](https://freedns.afraid.org) | Yes | Large selection of shared domains |

Check your router's admin page -- most consumer routers (Netgear, ASUS, TP-Link, etc.) have a DDNS section under WAN or Internet settings where you can enter your provider credentials.

### Step 2: Configure Your Router

1. **Set up DDNS** in your router's admin panel. Enter your provider, hostname, and credentials. The router will automatically update the DNS record whenever your public IP changes.

2. **Set up port forwarding** to route incoming traffic to your hub machine:

   | External port | Internal IP | Internal port | Protocol |
   |---------------|-------------|---------------|----------|
   | 80 | *(your hub machine's LAN IP)* | 80 | TCP |
   | 443 | *(your hub machine's LAN IP)* | 443 | TCP |
   | 8765 | *(your hub machine's LAN IP)* | 8765 | TCP |

   **Why three ports?**
   - **Port 80** -- Caddy needs this for the Let's Encrypt ACME HTTP-01 challenge (certificate provisioning). Traffic on this port is only used briefly during certificate issuance and renewal.
   - **Port 443** -- Caddy serves HTTPS here (optional, for general web access to your hub).
   - **Port 8765** -- The WebSocket port your browser connects to via `wss://`.

   If your hub runs inside a Multipass VM, forward to the VM's IP (find it with `multipass info flo-hub`), not your host machine's IP.

### Step 3: Run the Installer

Run the installer with your DDNS hostname as the domain:

```bash
curl -fsSL https://flo.monster/install/hub.sh | bash
```

When prompted, choose **Domain + TLS** and enter your DDNS hostname (e.g. `myhub.duckdns.org`). The installer configures Caddy, which automatically provisions a Let's Encrypt TLS certificate for your hostname.

### Step 4: Connect

In your browser, connect to your hub using the DDNS hostname:

- **URL**: `wss://myhub.duckdns.org:8765`
- **Token**: the authentication token shown during installation

This works from any network -- home, office, mobile data -- with full TLS encryption.

### Troubleshooting DDNS Setup

**Certificate provisioning fails (Caddy logs show ACME errors)**
- Verify port 80 is forwarded correctly. Let's Encrypt must reach your machine on port 80 to complete the HTTP-01 challenge.
- Some ISPs block inbound port 80. Check with your ISP, or try a provider that supports DNS-01 challenges (which don't need inbound ports).
- Wait a few minutes after setting up DDNS -- DNS propagation can take time.

**Connection works on LAN but not from outside**
- Confirm your DDNS hostname resolves to your public IP: `nslookup myhub.duckdns.org`
- Check that port 8765 is forwarded. Some routers only forward when the rule is explicitly saved and applied.
- Some routers don't support "NAT loopback" (connecting to your own public IP from inside your network). If this affects you, use the LAN IP (`ws://192.168.x.x:8765`) when at home and the DDNS hostname when away.

**Hub becomes unreachable after IP change**
- Verify your router's DDNS client is running and authenticated. Most routers show the last update time in the DDNS settings page.
- If your router doesn't support your DDNS provider, you can run a lightweight update client on the hub machine itself. DuckDNS, for example, provides a simple cron-based updater.

## Further Reading

- **[Scheduling Tasks](Scheduling-Tasks.md)** -- Cron jobs and event triggers for autonomous agents
- **[Messaging and Push Notifications](Messaging-Push-Notifications.md)** -- Sending notifications to your phone
- **[Security](../Security.md)** -- Full security hardening guide
