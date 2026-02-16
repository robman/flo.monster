import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateBootstrapScript } from './iframe-template.js';

describe('flo.speech bootstrap API', () => {
  let originalPostMessage: typeof window.parent.postMessage;
  let postedMessages: any[];

  beforeEach(() => {
    postedMessages = [];
    // Mock parent.postMessage
    originalPostMessage = window.parent.postMessage;
    // In JSDOM, window === window.parent, so we mock postMessage on window
    window.postMessage = vi.fn((msg) => {
      postedMessages.push(msg);
    }) as any;
  });

  afterEach(() => {
    window.postMessage = originalPostMessage;
    delete (window as any).flo;
  });

  function evalBootstrap() {
    const scriptHtml = generateBootstrapScript('test-agent');
    // Extract the script content between <script ...> and </script>
    const match = scriptHtml.match(/<script[^>]*>([\s\S]*)<\/script>/);
    if (!match) throw new Error('Could not extract script content');
    // Execute the bootstrap script
    const fn = new Function(match[1]);
    fn();
    return (window as any).flo;
  }

  describe('flo.speech.listen()', () => {
    it('should return a session object with done() and cancel() methods', () => {
      const flo = evalBootstrap();
      expect(flo.speech).toBeDefined();
      expect(typeof flo.speech.listen).toBe('function');

      const session = flo.speech.listen();
      expect(session).toBeDefined();
      expect(typeof session.done).toBe('function');
      expect(typeof session.cancel).toBe('function');
    });

    it('should send speech_listen_start message to shell', () => {
      const flo = evalBootstrap();
      flo.speech.listen({ lang: 'fr-FR' });

      const msg = postedMessages.find(m => m.type === 'speech_listen_start');
      expect(msg).toBeDefined();
      expect(msg.agentId).toBe('test-agent');
      expect(msg.lang).toBe('fr-FR');
      expect(msg.id).toBeTruthy();
    });

    it('should call oninterim callback when speech_interim received', () => {
      const flo = evalBootstrap();
      const oninterim = vi.fn();
      const session = flo.speech.listen({ oninterim });

      const msg = postedMessages.find(m => m.type === 'speech_listen_start');

      // Simulate shell sending speech_interim
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_interim', id: msg.id, text: 'hello' },
      }));

      expect(oninterim).toHaveBeenCalledWith('hello');
    });

    it('done() should resolve with result when speech_result received', async () => {
      const flo = evalBootstrap();
      const session = flo.speech.listen();
      const donePromise = session.done();

      const msg = postedMessages.find(m => m.type === 'speech_listen_start');

      // Simulate shell sending speech_result
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_result', id: msg.id, text: 'hello world', confidence: 0.95 },
      }));

      const result = await donePromise;
      expect(result).toEqual({ text: 'hello world', confidence: 0.95 });
    });

    it('done() should resolve with null when speech_cancelled received', async () => {
      const flo = evalBootstrap();
      const session = flo.speech.listen();
      const donePromise = session.done();

      const msg = postedMessages.find(m => m.type === 'speech_listen_start');

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_cancelled', id: msg.id },
      }));

      const result = await donePromise;
      expect(result).toBeNull();
    });

    it('cancel() should send speech_listen_cancel message', () => {
      const flo = evalBootstrap();
      const session = flo.speech.listen();
      const startMsg = postedMessages.find(m => m.type === 'speech_listen_start');

      session.cancel();

      const cancelMsg = postedMessages.find(m => m.type === 'speech_listen_cancel');
      expect(cancelMsg).toBeDefined();
      expect(cancelMsg.id).toBe(startMsg.id);
    });

    it('done() should reject when speech_error received', async () => {
      const flo = evalBootstrap();
      const session = flo.speech.listen();
      const donePromise = session.done();

      const msg = postedMessages.find(m => m.type === 'speech_listen_start');

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_error', id: msg.id, error: 'mic failed' },
      }));

      await expect(donePromise).rejects.toThrow('mic failed');
    });
  });

  describe('flo.speech.speak()', () => {
    it('should return a promise and send speech_speak message', () => {
      const flo = evalBootstrap();
      const promise = flo.speech.speak('Hello', { voice: 'Samantha', lang: 'en-US' });
      expect(promise).toBeInstanceOf(Promise);

      const msg = postedMessages.find(m => m.type === 'speech_speak');
      expect(msg).toBeDefined();
      expect(msg.text).toBe('Hello');
      expect(msg.voice).toBe('Samantha');
      expect(msg.lang).toBe('en-US');
    });

    it('should resolve when speech_speak_done received', async () => {
      const flo = evalBootstrap();
      const promise = flo.speech.speak('Hello');
      const msg = postedMessages.find(m => m.type === 'speech_speak');

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_speak_done', id: msg.id },
      }));

      await expect(promise).resolves.toBeUndefined();
    });

    it('should reject when speech_error received for speak', async () => {
      const flo = evalBootstrap();
      const promise = flo.speech.speak('Hello');
      const msg = postedMessages.find(m => m.type === 'speech_speak');

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_error', id: msg.id, error: 'synthesis failed' },
      }));

      await expect(promise).rejects.toThrow('synthesis failed');
    });
  });

  describe('flo.speech.voices()', () => {
    it('should return a promise and send speech_voices message', () => {
      const flo = evalBootstrap();
      const promise = flo.speech.voices();
      expect(promise).toBeInstanceOf(Promise);

      const msg = postedMessages.find(m => m.type === 'speech_voices');
      expect(msg).toBeDefined();
    });

    it('should resolve with voice list when speech_voices_result received', async () => {
      const flo = evalBootstrap();
      const promise = flo.speech.voices();
      const msg = postedMessages.find(m => m.type === 'speech_voices');

      const voices = [
        { name: 'Samantha', lang: 'en-US', local: true },
        { name: 'Google UK', lang: 'en-GB', local: false },
      ];

      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'speech_voices_result', id: msg.id, voices },
      }));

      const result = await promise;
      expect(result).toEqual(voices);
    });
  });
});
