# Geolocation

Agents can request your location for location-aware features. The browser's Geolocation API is relayed to the sandboxed iframe via `postMessage`, since `navigator.geolocation` is blocked inside sandboxed iframes.

Of course, your agents can just create this for you if you ask them.

## Getting Current Position

`flo.geolocation.getCurrentPosition()` returns a one-shot position reading:

```javascript
var pos = await flo.geolocation.getCurrentPosition({ enableHighAccuracy: true });
console.log(pos.latitude + ', ' + pos.longitude + ' (+-' + pos.accuracy + 'm)');
```

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `enableHighAccuracy` | boolean | `false` | Use GPS (true) or network location (false) |
| `timeout` | number | `30000` | Maximum wait time in milliseconds |
| `maximumAge` | number | `0` | Accept a cached position up to this many milliseconds old |

### Response

The returned object contains:

| Field | Type | Description |
|---|---|---|
| `latitude` | number | Latitude in decimal degrees |
| `longitude` | number | Longitude in decimal degrees |
| `accuracy` | number | Accuracy in metres |
| `altitude` | number or null | Altitude in metres (if available) |
| `altitudeAccuracy` | number or null | Altitude accuracy in metres (if available) |
| `heading` | number or null | Direction of travel in degrees (if available) |
| `speed` | number or null | Speed in metres per second (if available) |
| `timestamp` | number | Time the position was determined (milliseconds since epoch) |

### Permission flow

1. Agent calls `flo.geolocation.getCurrentPosition()`
2. If geolocation is not pre-enabled in agent settings, the user sees an approval dialogue: Deny / Allow Once / Allow Always
3. If denied at the approval dialogue, the Promise rejects with an error
4. If approved, the browser's native geolocation prompt appears (if not already granted)
5. Position data is proxied from the shell to the iframe via `postMessage`

You can also request permission proactively:

```javascript
var granted = await flo.requestPermission('geolocation');
```

## Watching Position

`flo.geolocation.watchPosition()` provides continuous position tracking. It calls your callback each time the position changes.

```javascript
var watch = flo.geolocation.watchPosition(
  function(pos) {
    // Called on each position update
    updateMap(pos.latitude, pos.longitude);
  },
  function(err) {
    // Optional error callback
    console.error('Location error:', err.message, 'code:', err.code);
  },
  { enableHighAccuracy: true }
);

// Stop tracking when finished
watch.stop();
```

The options are the same as `getCurrentPosition()`.

## Error Handling

```javascript
try {
  var pos = await flo.geolocation.getCurrentPosition();
} catch (e) {
  // e.message contains the error description
  // Common errors:
  // "Geolocation permission was denied by the user."  -- agent-level approval denied
  // "User denied Geolocation"                         -- browser permission denied
  // "Position unavailable"                             -- device cannot determine position
  // "Timeout expired"                                  -- took too long
}
```

### Error codes

Errors include a numeric `code` property matching the standard `GeolocationPositionError` codes:

| Code | Constant | Description |
|---|---|---|
| 1 | `PERMISSION_DENIED` | The user denied the permission request |
| 2 | `POSITION_UNAVAILABLE` | The device could not determine its position |
| 3 | `TIMEOUT` | The request exceeded the timeout period |

## Complete Example -- Location Display

```html
<div id="location" style="padding:20px;font-family:system-ui">
  <h2>My Location</h2>
  <div id="coords">Getting location...</div>
  <div id="accuracy" style="color:#666;margin-top:4px"></div>
  <button onclick="getLocation()" style="margin-top:12px;padding:8px 16px">Refresh</button>
  <button onclick="toggleWatch()" id="watchBtn" style="margin-top:12px;padding:8px 16px">
    Start Tracking
  </button>
</div>

<script>
var currentWatch = null;

async function getLocation() {
  try {
    var pos = await flo.geolocation.getCurrentPosition({ enableHighAccuracy: true });
    document.getElementById('coords').textContent =
      pos.latitude.toFixed(6) + ', ' + pos.longitude.toFixed(6);
    document.getElementById('accuracy').textContent =
      'Accuracy: ' + Math.round(pos.accuracy) + 'm';
  } catch (e) {
    document.getElementById('coords').textContent = 'Error: ' + e.message;
  }
}

function toggleWatch() {
  if (currentWatch) {
    currentWatch.stop();
    currentWatch = null;
    document.getElementById('watchBtn').textContent = 'Start Tracking';
  } else {
    currentWatch = flo.geolocation.watchPosition(
      function(pos) {
        document.getElementById('coords').textContent =
          pos.latitude.toFixed(6) + ', ' + pos.longitude.toFixed(6);
        document.getElementById('accuracy').textContent =
          'Accuracy: ' + Math.round(pos.accuracy) + 'm';
      },
      function(err) {
        document.getElementById('coords').textContent = 'Error: ' + err.message;
      },
      { enableHighAccuracy: true }
    );
    document.getElementById('watchBtn').textContent = 'Stop Tracking';
  }
}

getLocation();
</script>
```

## Use Cases

- **Location-aware dashboards** -- display information relevant to where the user is
- **Distance calculations** -- compute distances between coordinates using the haversine formula
- **Local weather and business lookups** -- combine with the `fetch` tool to query location-based APIs
- **Fitness tracking** -- use `watchPosition` with high accuracy for continuous GPS tracking
- **Geocoding** -- combine coordinates with a geocoding API via `fetch` to convert between coordinates and addresses

## Privacy

Location is only shared when the user explicitly grants permission. There are two layers of consent:

1. **Agent-level approval** -- the [flo.monster](https://flo.monster) shell asks whether this agent should be allowed to access location
2. **Browser-level permission** -- the browser's standard geolocation prompt

The user can deny at either stage. Agents should handle denial gracefully and provide alternative functionality when location is not available.

## See Also

- [Network and Fetch](Network-And-Fetch.md) -- using the `fetch` tool for geocoding APIs and location-based services
- [Web UI](Web-UI.md) -- building interactive agent pages
