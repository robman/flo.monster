import type { AgentContainer } from '../../agent/agent-container.js';
import type { PermissionApprovalDialog } from '../../ui/permission-approval-dialog.js';
import type { PermissionApprovalResult } from '../../ui/permission-approval-dialog.js';

// SpeechRecognition types are not in standard TS DOM lib — use any
interface SpeechSession {
  recognition: any;
  finalText: string;
  interimText: string;  // Track latest interim text for fallback
  confidence: number;
  agentId: string;
}

export interface SpeechContext {
  permissionApprovals: Map<string, PermissionApprovalResult>;
  permissionApprovalDialog: PermissionApprovalDialog | null;
  setPermissionApprovalDialog: (dialog: PermissionApprovalDialog) => void;
  onPermissionChange: ((agentId: string, permission: string, enabled: boolean) => void) | null;
}

const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

const activeSessions = new Map<string, SpeechSession>();

/**
 * Forcefully stop a recognition instance.
 * Nulls out handlers first to prevent onend auto-restart,
 * then uses abort() for immediate cleanup (vs stop() which tries to return results).
 */
function killRecognition(recognition: any): void {
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  try {
    recognition.abort();
  } catch (_e) { /* ignore */ }
}

export async function handleSpeechListenStart(
  msg: { type: 'speech_listen_start'; id: string; agentId: string; lang?: string },
  agent: AgentContainer,
  target: Window,
  ctx: SpeechContext,
): Promise<void> {
  // Check microphone permission
  const micEnabled = agent.config.sandboxPermissions?.microphone ?? false;

  if (!micEnabled) {
    const cacheKey = `${agent.id}:microphone`;
    const cached = ctx.permissionApprovals.get(cacheKey);

    if (cached) {
      if (!cached.approved) {
        target.postMessage({
          type: 'speech_error',
          id: msg.id,
          error: 'Microphone permission was denied.',
        }, '*');
        return;
      }
      // cached.approved = true — fall through
    } else {
      // Show approval dialog
      const { PermissionApprovalDialog } = await import('../../ui/permission-approval-dialog.js');
      if (!ctx.permissionApprovalDialog) {
        const dialog = new PermissionApprovalDialog();
        ctx.permissionApprovalDialog = dialog;
        ctx.setPermissionApprovalDialog(dialog);
      }

      const result = await ctx.permissionApprovalDialog.show(agent.config.name, 'microphone');
      ctx.permissionApprovals.set(cacheKey, result);

      if (!result.approved) {
        target.postMessage({
          type: 'speech_error',
          id: msg.id,
          error: 'Microphone permission was denied by the user.',
        }, '*');
        return;
      }

      // Update agent config
      const updatedPermissions = { ...agent.config.sandboxPermissions, microphone: true };
      agent.updateConfig({ sandboxPermissions: updatedPermissions });

      // Notify for persistence if "Allow Always"
      if (result.persistent && ctx.onPermissionChange) {
        ctx.onPermissionChange(agent.id, 'microphone', true);
      }
    }
  }

  // Check SpeechRecognition availability
  if (!SpeechRecognitionAPI) {
    target.postMessage({
      type: 'speech_error',
      id: msg.id,
      error: 'SpeechRecognition not supported',
    }, '*');
    return;
  }

  // Kill any existing session with the same id (shouldn't happen, but defensive)
  const existing = activeSessions.get(msg.id);
  if (existing) {
    killRecognition(existing.recognition);
    activeSessions.delete(msg.id);
  }

  const recognition = new SpeechRecognitionAPI();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = msg.lang || 'en-US';

  const session: SpeechSession = {
    recognition,
    finalText: '',
    interimText: '',
    confidence: 0,
    agentId: msg.agentId,
  };

  recognition.onresult = (event: any) => {
    let finalText = session.finalText;
    let confidence = session.confidence;
    let interimText = '';

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
        confidence = result[0].confidence;
      } else {
        interimText += result[0].transcript;
      }
    }

    session.finalText = finalText;
    session.confidence = confidence;
    session.interimText = interimText;

    // Post interim update with combined final + interim text
    const fullInterim = finalText + interimText;
    if (fullInterim) {
      target.postMessage({
        type: 'speech_interim',
        id: msg.id,
        text: fullInterim,
      }, '*');
    }
  };

  recognition.onerror = (event: any) => {
    // 'no-speech' and 'aborted' are non-errors (silence or intentional stop)
    if (event.error === 'no-speech' || event.error === 'aborted') {
      return;
    }
    target.postMessage({
      type: 'speech_error',
      id: msg.id,
      error: event.error,
    }, '*');
  };

  recognition.onend = () => {
    // If session is still active (not done/cancelled), auto-restart
    // iOS Safari stops recognition after ~60s of silence
    if (activeSessions.has(msg.id)) {
      try {
        recognition.start();
      } catch (_err) {
        // start() can throw if recognition is in bad state — clean up
        activeSessions.delete(msg.id);
      }
    }
  };

  activeSessions.set(msg.id, session);
  recognition.start();
}

export function handleSpeechListenDone(
  msg: { type: 'speech_listen_done'; id: string; agentId: string },
  _agent: AgentContainer,
  target: Window,
): void {
  const session = activeSessions.get(msg.id);
  activeSessions.delete(msg.id);

  if (!session) {
    target.postMessage({
      type: 'speech_result',
      id: msg.id,
      text: '',
      confidence: 0,
    }, '*');
    return;
  }

  // Capture for closure — TS can't narrow `session` inside nested functions
  const s = session;
  let resolved = false;

  function sendResult() {
    if (resolved) return;
    resolved = true;

    // Use finalText if available, fall back to interimText (what the user saw on screen)
    const text = s.finalText || s.interimText;
    target.postMessage({
      type: 'speech_result',
      id: msg.id,
      text,
      confidence: s.confidence,
    }, '*');
  }

  // Wait for recognition to fully stop (onend fires after any pending
  // onresult events are delivered), so the final transcript is captured.
  session.recognition.onend = () => {
    sendResult();
  };

  try {
    session.recognition.stop();
  } catch (_e) {
    // If stop() throws, send what we have immediately
    sendResult();
  }

  // Timeout fallback in case onend never fires (500ms)
  setTimeout(sendResult, 500);
}

export function handleSpeechListenCancel(
  msg: { type: 'speech_listen_cancel'; id: string; agentId: string },
  _agent: AgentContainer,
  target: Window,
): void {
  const session = activeSessions.get(msg.id);
  activeSessions.delete(msg.id);

  if (session) {
    killRecognition(session.recognition);
  }

  target.postMessage({
    type: 'speech_cancelled',
    id: msg.id,
  }, '*');
}

export function handleSpeechSpeak(
  msg: { type: 'speech_speak'; id: string; agentId: string; text: string; voice?: string; lang?: string },
  _agent: AgentContainer,
  target: Window,
): void {
  if (typeof speechSynthesis === 'undefined') {
    target.postMessage({
      type: 'speech_error',
      id: msg.id,
      error: 'SpeechSynthesis not supported',
    }, '*');
    return;
  }

  const utterance = new SpeechSynthesisUtterance(msg.text);

  if (msg.voice) {
    const voices = speechSynthesis.getVoices();
    const match = voices.find(v => v.name === msg.voice);
    if (match) {
      utterance.voice = match;
    }
  }

  if (msg.lang) {
    utterance.lang = msg.lang;
  }

  // Cancel any current speech first (required for iOS Safari)
  speechSynthesis.cancel();

  // iOS Safari keepalive: resume() periodically to prevent early cutoff
  let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (keepaliveInterval !== null) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
  };

  utterance.onend = () => {
    cleanup();
    target.postMessage({
      type: 'speech_speak_done',
      id: msg.id,
    }, '*');
  };

  utterance.onerror = (event: any) => {
    cleanup();
    // 'interrupted' happens from cancel() — not a real error
    if (event.error === 'interrupted') {
      return;
    }
    target.postMessage({
      type: 'speech_error',
      id: msg.id,
      error: event.error,
    }, '*');
  };

  speechSynthesis.speak(utterance);

  // Set up iOS keepalive
  keepaliveInterval = setInterval(() => {
    if (speechSynthesis.speaking) {
      speechSynthesis.resume();
    }
  }, 5000);
}

export function handleSpeechVoices(
  msg: { type: 'speech_voices'; id: string; agentId: string },
  target: Window,
): void {
  const sendVoices = () => {
    const voices = speechSynthesis.getVoices();
    const mapped = voices.map(v => ({
      name: v.name,
      lang: v.lang,
      local: v.localService,
    }));
    target.postMessage({
      type: 'speech_voices_result',
      id: msg.id,
      voices: mapped,
    }, '*');
  };

  const voices = speechSynthesis.getVoices();
  if (voices.length > 0) {
    sendVoices();
    return;
  }

  // Voices may not be loaded yet on first call — wait for voiceschanged
  let resolved = false;

  const onVoicesChanged = () => {
    if (resolved) return;
    resolved = true;
    speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
    sendVoices();
  };

  speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);

  // Fallback timeout in case voiceschanged never fires
  setTimeout(() => {
    if (resolved) return;
    resolved = true;
    speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
    sendVoices();
  }, 2000);
}

export function cleanupSpeechSessions(agentId: string): void {
  let hadSessions = false;

  for (const [id, session] of activeSessions) {
    if (session.agentId === agentId) {
      killRecognition(session.recognition);
      activeSessions.delete(id);
      hadSessions = true;
    }
  }

  if (hadSessions && typeof speechSynthesis !== 'undefined') {
    speechSynthesis.cancel();
  }
}

/**
 * Stop all active speech recognition sessions.
 * Called before the conversation mic button starts its own SpeechRecognition
 * to avoid Chrome's single-instance restriction.
 */
export function stopAllSpeechSessions(): void {
  for (const [id, session] of activeSessions) {
    killRecognition(session.recognition);
    activeSessions.delete(id);
  }
}
