# Hub Browser

Agents connected to a hub can browse the web using a headless Chromium instance managed by the hub. This gives agents the ability to navigate pages, read content, fill forms, click buttons, and extract information -- all through a real browser engine.

## Enabled by Default

Browse is enabled by default on new hub installs. The installer runs `npx patchright install chromium` to download the Chromium binary (~120 MB).

No additional configuration is needed -- agents will automatically have access to the `browse` tool when connected to the hub.

## How It Works

Each agent gets its own Chromium process with a persistent browser profile (via patchright's `launchPersistentContext`). Hub-persisted agents store their browser data at `~/.flo-monster/agents/{id}/browser/` for cookie and state persistence across sessions. A proxy layer enforces security policies on all network requests made by the browser.

When an agent uses the `browse` tool, it can:

- Navigate to a URL and read the page content as an accessibility snapshot
- Click elements, type text, scroll, and interact with forms
- Take screenshots (delivered as a live stream to the browser UI)
- Wait for navigation or network idle
- Go back, forward, or reload

The hub manages browser sessions automatically -- creating them on first use and cleaning them up after inactivity.

## Configuration

Browse settings live under `tools.browse` in your `hub.json`:

```json
{
  "tools": {
    "browse": {
      "enabled": true
    }
  }
}
```

All settings besides `enabled` have sensible defaults and are optional:

| Setting | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable or disable the browse tool |
| `maxConcurrentSessions` | `3` | Maximum simultaneous browser sessions across all agents |
| `sessionTimeoutMinutes` | `30` | Idle timeout before a session is closed |
| `allowedDomains` | `[]` (all allowed) | Whitelist of domains agents can visit. Empty means all domains are allowed |
| `blockedDomains` | `[]` | Domains agents cannot visit |
| `blockPrivateIPs` | `true` | Block requests to private/internal IP ranges (SSRF protection) |
| `rateLimitPerDomain` | `10` | Maximum requests per minute per domain. `0` = unlimited |
| `viewport` | `{"width": 1280, "height": 720}` | Browser viewport size |

## Disabling Browse

To disable browse, set `enabled` to `false` in your `hub.json` and restart the hub:

```json
{
  "tools": {
    "browse": {
      "enabled": false
    }
  }
}
```

## Manual Chromium Install

If you installed the hub before browse was added, or if the Chromium binary is missing, install it manually:

```bash
cd /path/to/flo.monster
npx patchright install chromium
```

On a system with the `flo-hub` user (automated installs):

```bash
sudo -u flo-hub bash -c 'source ~/.nvm/nvm.sh && cd ~/flo.monster && npx patchright install chromium'
```

## Security

All browser traffic is proxied through the hub's security layer:

- **Private IP blocking** -- requests to `10.*`, `172.16-31.*`, `192.168.*`, `127.*`, `::1`, and link-local addresses are blocked by default, preventing SSRF attacks against internal services
- **Domain policies** -- `allowedDomains` and `blockedDomains` let you control which sites agents can visit
- **Rate limiting** -- per-domain rate limits prevent abuse
- **Session isolation** -- each agent gets its own browser context with separate cookies, storage, and state
- **Timeout enforcement** -- idle sessions are automatically closed

## Further Reading

- [Installing a Hub](Installing-A-Hub.md) -- full hub setup guide
