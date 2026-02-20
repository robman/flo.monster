import { describe, it, expect, beforeEach } from 'vitest';
import { SSEParser } from '../sse-parser.js';

describe('SSEParser', () => {
  let parser: SSEParser;

  beforeEach(() => {
    parser = new SSEParser();
  });

  it('parses a single complete event', () => {
    const events = parser.feed('event: message_start\ndata: {"type":"message_start"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message_start');
    expect(events[0].data).toBe('{"type":"message_start"}');
  });

  it('parses event split across multiple chunks', () => {
    let events = parser.feed('event: mess');
    expect(events).toHaveLength(0);
    events = parser.feed('age_start\ndata: {"type"');
    expect(events).toHaveLength(0);
    events = parser.feed(':"message_start"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('message_start');
    expect(events[0].data).toBe('{"type":"message_start"}');
  });

  it('parses multiple events in one chunk', () => {
    const events = parser.feed(
      'event: a\ndata: first\n\nevent: b\ndata: second\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('a');
    expect(events[0].data).toBe('first');
    expect(events[1].event).toBe('b');
    expect(events[1].data).toBe('second');
  });

  it('handles data-only events (no event field)', () => {
    const events = parser.feed('data: hello\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBeUndefined();
    expect(events[0].data).toBe('hello');
  });

  it('handles multi-line data', () => {
    const events = parser.feed('data: line1\ndata: line2\ndata: line3\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('line1\nline2\nline3');
  });

  it('ignores comments', () => {
    const events = parser.feed(': this is a comment\ndata: real data\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('real data');
  });

  it('handles empty data between events', () => {
    const events = parser.feed('data: first\n\ndata: second\n\n');
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('first');
    expect(events[1].data).toBe('second');
  });

  it('handles \\r\\n line endings (Gemini SSE format)', () => {
    const events = parser.feed('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}\r\n\r\n');
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('{"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}');
    expect(events[1].data).toBe('{"candidates":[{"content":{"parts":[{"text":" world"}]}}]}');
  });

  it('handles \\r\\n line endings split across chunks', () => {
    let events = parser.feed('data: first\r\n');
    expect(events).toHaveLength(0);
    events = parser.feed('\r\ndata: second\r\n\r\n');
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe('first');
    expect(events[1].data).toBe('second');
  });

  it('handles mixed \\n and \\r\\n line endings', () => {
    const events = parser.feed('event: a\r\ndata: first\r\n\r\nevent: b\ndata: second\n\n');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('a');
    expect(events[0].data).toBe('first');
    expect(events[1].event).toBe('b');
    expect(events[1].data).toBe('second');
  });

  it('reset clears state', () => {
    parser.feed('event: partial\ndata: incom');
    parser.reset();
    const events = parser.feed('data: fresh\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe('fresh');
    expect(events[0].event).toBeUndefined();
  });
});
