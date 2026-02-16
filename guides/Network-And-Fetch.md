# Network and Fetch

Agents can make HTTP requests to external APIs, fetch web pages, and perform web searches. How these requests are handled depends on whether the agent is running in the browser alone or connected to a hub.

Of course, your agents can just create this for you if you ask them.

## The `fetch` Tool

The `fetch` tool lets agents make HTTP requests:

```
fetch({ url: 'https://api.example.com/data', method: 'GET' })
```

### Supported options

| Parameter | Description |
|---|---|
| `url` | The URL to fetch (required) |
| `method` | HTTP method: `GET`, `POST`, `PUT`, `DELETE`, `PATCH` (default: `GET`) |
| `headers` | Request headers as key-value pairs |
| `body` | Request body (for POST, PUT, PATCH) |
| `timeout` | Request timeout in milliseconds |

### Response

The tool returns:

```json
{
  "status": 200,
  "headers": { "content-type": "application/json" },
  "body": "{\"result\": \"success\"}"
}
```

## CORS Constraints

Browser agents are subject to standard CORS (Cross-Origin Resource Sharing) restrictions:

- **CORS-friendly APIs work directly** -- many public APIs (Google, GitHub, most REST APIs) include the appropriate CORS headers
- **APIs without CORS headers will fail** in browser-only mode -- the browser blocks the response
- **To bypass CORS**, connect to a hub -- requests are proxied through the hub server

## Hub Fetch Proxy

When an agent is connected to a hub, HTTP requests can be proxied through the hub server using the `web_fetch` tool. This provides several advantages:

- **Bypasses CORS** -- the hub makes the request server-side, so CORS restrictions do not apply
- **SSRF protection** -- private IP ranges are blocked, and redirect targets are validated at each hop
- **Header stripping** -- sensitive headers (`authorization`, `cookie`, `x-api-key`, `proxy-authorization`, `set-cookie`) are stripped from proxied requests to prevent credential leakage
- **Redirect safety** -- redirects are followed manually with private IP checks at every hop, preventing SSRF via 302 redirects

## Network Policy

Agents have a configurable network policy that controls which domains they can access:

- The policy is enforced across all network tools (`fetch`, `web_fetch`, `web_search`)
- Administrators can restrict agents to specific domains or block certain destinations
- The current network policy is visible via the `capabilities` tool

## Web Search

Hub-connected agents can also perform web searches using the `web_search` tool. This provides structured search results that agents can use to find information, look up documentation, or research topics.

## Best Practices

- **Use the `fetch` tool** for API calls rather than using `runjs` with native `fetch` -- the tool respects network policy and handles CORS properly
- **Connect to a hub** if you need to access APIs that do not support CORS
- **Respect rate limits** on external APIs -- the system does not automatically throttle outbound requests
- **Use `web_fetch`** (hub) for scraping or accessing APIs that require server-side requests
- **Check `capabilities`** at startup to see what network tools are available and what the current network policy allows

## See Also

- [Installing a Hub](Installing-A-Hub.md) -- setting up a hub for fetch proxying
- [Security](../Security.md) -- network security model and SSRF protection
