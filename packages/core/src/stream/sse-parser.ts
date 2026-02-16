import type { SSEEvent } from '../types/provider.js';

export type { SSEEvent };

export class SSEParser {
  private buffer = '';
  private currentEvent: string | undefined = undefined;
  private currentData: string[] = [];

  feed(chunk: string): SSEEvent[] {
    const events: SSEEvent[] = [];
    this.buffer += chunk;

    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (line === '') {
        // Empty line = end of event
        if (this.currentData.length > 0) {
          events.push({
            event: this.currentEvent,
            data: this.currentData.join('\n'),
          });
        }
        this.currentEvent = undefined;
        this.currentData = [];
      } else if (line.startsWith(':')) {
        // Comment, ignore
      } else if (line.startsWith('event:')) {
        this.currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        this.currentData.push(line.slice(5).trimStart());
      } else if (line.startsWith('data')) {
        // "data" without colon = empty data line
        this.currentData.push('');
      }
    }

    return events;
  }

  reset(): void {
    this.buffer = '';
    this.currentEvent = undefined;
    this.currentData = [];
  }
}
