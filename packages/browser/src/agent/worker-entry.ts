// Worker entry point — runs inside an opaque-origin iframe's Web Worker.
// Receives messages from the iframe bootstrap and communicates via postMessage.

declare const self: DedicatedWorkerGlobalScope;

interface WorkerState {
  paused: boolean;
  config: any;
  pendingResponses: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }>;
}

const state: WorkerState = {
  paused: false,
  config: null,
  pendingResponses: new Map(),
};

let nextRequestId = 0;
function generateId(): string {
  return `req-${++nextRequestId}`;
}

// Send a request to the shell (via iframe) and wait for response
function sendAndWait(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = generateId();
    msg.id = id;
    state.pendingResponses.set(id, { resolve, reject });
    self.postMessage(msg);
  });
}

// Emit an agent event to the shell
function emitEvent(event: any): void {
  self.postMessage({ type: 'event', event });
}

self.addEventListener('message', async (e: MessageEvent) => {
  const data = e.data;
  if (!data) return;

  switch (data.type) {
    case 'start':
      state.config = data.config;
      if (data.userMessage) {
        // Will trigger agentic loop when implemented
        emitEvent({ type: 'state_change', from: 'pending', to: 'running' });
      }
      break;

    case 'user_message':
      if (!state.paused) {
        // Queue the message for the agentic loop
        emitEvent({ type: 'text_delta', text: '[Worker received message: ' + data.content + ']' });
      }
      break;

    case 'pause':
      state.paused = true;
      break;

    case 'resume':
      state.paused = false;
      break;

    // Responses from shell/iframe
    case 'api_response_chunk':
    case 'api_response_end':
    case 'api_response_error':
    case 'dom_result':
    case 'runjs_result':
    case 'storage_result':
    case 'fetch_response':
    case 'fetch_error': {
      const pending = state.pendingResponses.get(data.id);
      if (pending) {
        if (data.type.endsWith('_error') || data.error) {
          pending.reject(new Error(data.error || 'Request failed'));
        } else if (data.type.endsWith('_end')) {
          pending.resolve(null);
        } else {
          // For streaming, don't resolve yet - accumulate
          // This will be properly handled in the agentic loop
        }
      }
      break;
    }
  }
});
