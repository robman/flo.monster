# Voice

Agents can listen to speech and speak back using the browser's Web Speech API. Both speech-to-text (recognition) and text-to-speech (synthesis) are relayed transparently through the shell, since these APIs are not available inside sandboxed iframes.

Of course, your agents can just create this for you if you ask them.

## Speech-to-Text (Listening)

`flo.speech.listen()` starts a speech recognition session. It returns a **session object** immediately (not a Promise). The session captures speech continuously until you finalise with `done()` or discard with `cancel()`.

```javascript
var session = flo.speech.listen({
  lang: 'en-AU',                           // optional, defaults to 'en-US'
  oninterim: function(text) {              // optional, called with partial transcript
    document.getElementById('preview').textContent = text;
  }
});

// When the user is finished speaking...
var result = await session.done();
// result = { text: 'buy eggs', confidence: 0.95 }
// result is null if cancelled

// Or discard the recording:
session.cancel();
```

### Options

| Option | Type | Description |
|---|---|---|
| `lang` | string | BCP-47 language code (default: `'en-US'`) |
| `oninterim` | function | Callback receiving partial transcript text as the user speaks |

### Session methods

| Method | Returns | Description |
|---|---|---|
| `done()` | `Promise<{ text, confidence } \| null>` | Finalise recognition and return the result. Returns `null` if cancelled. |
| `cancel()` | void | Discard the session without returning a result. |

### Complete voice note example

```html
<button id="recordBtn" onclick="toggleRecording()">Press to Talk</button>
<div id="transcript"></div>
<button id="doneBtn" onclick="finishRecording()" style="display:none">Done</button>
<button id="cancelBtn" onclick="cancelRecording()" style="display:none">Cancel</button>

<script>
var currentSession = null;

function toggleRecording() {
  if (currentSession) return;
  document.getElementById('recordBtn').textContent = 'Listening...';
  document.getElementById('doneBtn').style.display = '';
  document.getElementById('cancelBtn').style.display = '';

  currentSession = flo.speech.listen({
    oninterim: function(text) {
      document.getElementById('transcript').textContent = text;
    }
  });
}

function finishRecording() {
  if (!currentSession) return;
  currentSession.done().then(function(result) {
    if (result) {
      document.getElementById('transcript').textContent = result.text;
    }
    resetUI();
  });
}

function cancelRecording() {
  if (!currentSession) return;
  currentSession.cancel();
  resetUI();
}

function resetUI() {
  currentSession = null;
  document.getElementById('recordBtn').textContent = 'Press to Talk';
  document.getElementById('doneBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'none';
}
</script>
```

## Text-to-Speech (Speaking)

`flo.speech.speak()` converts text to audible speech. It returns a Promise that resolves when the utterance finishes.

```javascript
// Basic usage
await flo.speech.speak('Hello!');

// With language and voice selection
await flo.speech.speak('Bonjour', {
  lang: 'fr-FR',
  voice: 'Thomas'   // specific voice name from voices()
});
```

### Options

| Option | Type | Description |
|---|---|---|
| `lang` | string | BCP-47 language code |
| `voice` | string | Voice name from the list returned by `voices()` |

### Listing available voices

```javascript
var voices = await flo.speech.voices();
// [{ name: 'Samantha', lang: 'en-US', local: true }, ...]
```

Each voice entry contains:

| Field | Type | Description |
|---|---|---|
| `name` | string | Voice name (use this in the `voice` option) |
| `lang` | string | Language code |
| `local` | boolean | Whether the voice is processed locally (vs cloud-based) |

## Voice-First Interaction

Voice capabilities can be combined with other flo APIs to build fully voice-driven agents:

- Use `flo.speech.listen()` and `flo.speech.speak()` together for natural dialogue
- The shell's built-in chat mic button provides quick voice input without custom UI
- Build custom voice interfaces with `listen`/`speak` in page `<script>` tags for more control
- Combine with `flo.ask()` to let the agent process voice input and respond audibly

## How It Works

Speech APIs are not available inside sandboxed iframes (which is where agent pages run). The shell transparently relays speech operations:

1. Iframe page JS calls `flo.speech.listen()` or `flo.speech.speak()`
2. Request is sent via `postMessage` to the shell (which has full browser API access)
3. Shell calls the Web Speech API on behalf of the agent
4. Results (transcripts, completion events) are relayed back to the iframe via `postMessage`

This is completely transparent to page JavaScript -- just use `flo.speech.*` as documented.

## Browser Support

Web Speech API availability varies by browser:

| Browser | Speech-to-Text | Text-to-Speech |
|---|---|---|
| Chrome / Edge | Full support | Full support |
| Safari (macOS) | Supported | Supported |
| Safari (iOS) | Supported (with quirks handled automatically) | Supported |
| Firefox | Limited | Supported |

### iOS Safari notes

- **Speech recognition auto-stops** after approximately 60 seconds of silence. The runtime automatically restarts recognition, so this is transparent to your code.
- **Text-to-speech** requires `cancel()` before `speak()` and periodic keepalive calls to prevent early cutoff. The runtime handles both of these automatically.
- **Microphone permission** must be enabled in agent settings before speech recognition can be used.

## Best Practices

- Use the `oninterim` callback for real-time visual feedback while the user is speaking
- Let the user control when to finalise (`done()`) versus discard (`cancel()`)
- Always handle the case where `done()` returns `null` (cancelled) or empty text
- Build the complete voice UI with `<script>` tags in a single `dom create` call rather than using separate `runjs` calls

## See Also

- [Bidirectional Interactions](Bidirectional-Interactions.md) -- `flo.notify()` and `flo.ask()` for agent communication
- [Living Lists](Living-Lists.md) -- interactive agent experiences
- [Media](Media.md) -- camera and microphone access via WebRTC
