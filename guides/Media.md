# Media

Agents can access your camera and microphone for video capture, audio recording, image analysis, and more. Media streams are delivered to the sandboxed iframe via a WebRTC proxy, since direct `getUserMedia()` calls are blocked in sandboxed iframes.

Of course, your agents can just create this for you if you ask them.

## Camera Access

`flo.getCamera()` returns a `MediaStream` with a video track:

```javascript
var stream = await flo.getCamera();
var video = document.createElement('video');
video.srcObject = stream;
video.setAttribute('playsinline', '');
video.setAttribute('autoplay', '');
document.body.appendChild(video);
```

## Microphone Access

`flo.getMicrophone()` returns a `MediaStream` with an audio track:

```javascript
var stream = await flo.getMicrophone();
// Use with Web Audio API for analysis, recording, visualisation
var audioCtx = new AudioContext();
var source = audioCtx.createMediaStreamSource(stream);
```

## Combined Access

`flo.getMediaStream()` provides both video and audio in a single stream:

```javascript
var stream = await flo.getMediaStream({ video: true, audio: true });
```

Useful for video recording, conferencing-style features, or any scenario requiring synchronised audio and video.

## Stopping Streams

**Always use `flo.stopMediaStream(stream)` to release media devices:**

```javascript
flo.stopMediaStream(stream);
```

Do **not** call `stream.getTracks().forEach(t => t.stop())` directly. That only stops the local receiving end of the WebRTC connection -- the shell continues capturing from the camera or microphone hardware. Without calling `flo.stopMediaStream()`, the camera LED may stay on and hardware resources will not be released.

## Permission Flow

Media access follows a two-step permission model:

1. **Agent-level approval** -- if the permission (camera/microphone) is not pre-enabled in agent settings, the user sees an approval dialogue: Deny / Allow Once / Allow Always
2. **Browser permission prompt** -- if agent-level approval is granted, the browser's native camera/microphone prompt appears (if not already granted)

If either step is denied, the Promise rejects with an error.

You can request permission proactively using `flo.requestPermission()`:

```javascript
try {
  var granted = await flo.requestPermission('camera');
  // granted: true/false for browser permission
} catch (e) {
  // Throws if agent-level approval is denied
}
```

## Complete Camera Preview Example

```html
<div id="preview-container">
  <video id="camera" playsinline autoplay style="width:100%;border-radius:12px"></video>
</div>
<div style="display:flex;gap:12px;margin-top:12px">
  <button onclick="startCamera()" id="startBtn">Start Camera</button>
  <button onclick="takePhoto()" id="photoBtn" style="display:none">Take Photo</button>
  <button onclick="stopCamera()" id="stopBtn" style="display:none">Stop</button>
</div>
<canvas id="canvas" style="display:none"></canvas>
<div id="photos"></div>

<script>
var cameraStream = null;

async function startCamera() {
  try {
    cameraStream = await flo.getCamera();
    document.getElementById('camera').srcObject = cameraStream;
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('photoBtn').style.display = '';
    document.getElementById('stopBtn').style.display = '';
  } catch (e) {
    flo.notify('camera_error', { error: e.message });
  }
}

function takePhoto() {
  var video = document.getElementById('camera');
  var canvas = document.getElementById('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  var img = document.createElement('img');
  img.src = canvas.toDataURL('image/jpeg', 0.8);
  img.style.cssText = 'width:100%;border-radius:8px;margin-top:8px';
  document.getElementById('photos').prepend(img);
}

function stopCamera() {
  if (cameraStream) {
    flo.stopMediaStream(cameraStream);
    cameraStream = null;
  }
  document.getElementById('camera').srcObject = null;
  document.getElementById('startBtn').style.display = '';
  document.getElementById('photoBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'none';
}
</script>
```

## Error Handling

Media requests reject on failure. Always wrap calls in try/catch:

```javascript
try {
  var stream = await flo.getCamera();
} catch (e) {
  // e.message will be one of:
  // "Permission \"camera\" was denied by the user."  -- agent-level approval denied
  // "Media capture failed: NotFoundError: ..."       -- no camera device found
  // "Media capture failed: NotAllowedError: ..."     -- browser permission denied
  // "Media request timed out"                        -- 60-second timeout exceeded
}
```

## How It Works (WebRTC Proxy)

Camera and microphone APIs (`getUserMedia`) are not available inside sandboxed iframes. [flo.monster](https://flo.monster) uses a WebRTC loopback to deliver real `MediaStream` objects to the agent's page:

1. Iframe requests media via `postMessage` to the shell
2. Shell (running at the real origin) calls `navigator.mediaDevices.getUserMedia()`
3. Shell creates an `RTCPeerConnection` and adds the captured tracks
4. SDP offer/answer exchange happens via `postMessage` between shell and iframe
5. Iframe receives the `MediaStream` via the WebRTC connection

The result is that the iframe gets a real `MediaStream` object it can use with `<video>` elements, the Web Audio API, Canvas drawing, and any other standard media API -- all without direct hardware access.

## Use Cases

- **QR code scanning** -- capture video frames and analyse them with a QR library
- **Photo capture** -- draw video frames to a hidden `<canvas>` and use `toDataURL()`
- **Video recording** -- use `MediaRecorder` with the captured stream
- **Audio visualisation** -- connect the microphone stream to the Web Audio API
- **Real-time video effects** -- process video frames on a canvas

## iOS Safari Notes

- `getUserMedia()` always fails in sandboxed srcdoc iframes, but the WebRTC proxy handles this transparently
- Video elements **must** have both `playsinline` and `autoplay` attributes or video will not display
- Permission prompts may behave slightly differently compared to desktop browsers

## Best Practices

- Always use `playsinline autoplay` on video elements: `<video playsinline autoplay>`
- **Always** use `flo.stopMediaStream(stream)` to stop -- never `track.stop()` directly
- Use `flo.requestPermission()` proactively if you want to handle denial before showing camera UI
- Build the complete media UI with `<script>` tags in a single `dom create` call
- For photo capture, draw video frames to a hidden `<canvas>`, then use `canvas.toDataURL()`

## See Also

- [Voice](Voice.md) -- speech recognition and synthesis
- [Web UI](Web-UI.md) -- building interactive agent pages
- [Bidirectional Interactions](Bidirectional-Interactions.md) -- agent-page communication
