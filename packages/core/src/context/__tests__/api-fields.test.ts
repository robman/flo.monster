import { describe, it, expect } from 'vitest';
import { toApiMessage, MESSAGE_API_FIELDS, GEMINI_API_FIELDS } from '../api-fields.js';

describe('toApiMessage', () => {
  it('keeps only role and content for a simple message', () => {
    const msg = { role: 'user', content: [{ type: 'text', text: 'hi' }] };
    expect(toApiMessage(msg)).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
  });

  it('strips turnId from messages', () => {
    const msg = { role: 'user', content: 'hi', turnId: 'turn-1' };
    expect(toApiMessage(msg)).toEqual({ role: 'user', content: 'hi' });
  });

  it('strips type (intervention) from messages', () => {
    const msg = { role: 'user', type: 'intervention', content: 'user intervened' };
    expect(toApiMessage(msg)).toEqual({ role: 'user', content: 'user intervened' });
  });

  it('strips messageType from messages', () => {
    const msg = { role: 'user', messageType: 'intervention', content: 'hi' };
    expect(toApiMessage(msg)).toEqual({ role: 'user', content: 'hi' });
  });

  it('strips timestamp from messages', () => {
    const msg = { role: 'assistant', content: 'hello', timestamp: 1234567890 };
    expect(toApiMessage(msg)).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('strips multiple internal fields at once', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      type: 'intervention',
      turnId: 'turn-3',
      messageType: 'intervention',
      timestamp: 1234567890,
    };
    expect(toApiMessage(msg)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    });
  });

  it('preserves OpenAI-specific fields (tool_calls, tool_call_id, name)', () => {
    const toolCallMsg = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      turnId: 'turn-1',
    };
    expect(toApiMessage(toolCallMsg)).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test', arguments: '{}' } }],
    });

    const toolResultMsg = {
      role: 'tool',
      tool_call_id: 'tc1',
      content: 'result',
      turnId: 'turn-1',
    };
    expect(toApiMessage(toolResultMsg)).toEqual({
      role: 'tool',
      tool_call_id: 'tc1',
      content: 'result',
    });
  });

  it('returns empty object for message with no API fields', () => {
    const msg = { type: 'announcement', turnId: 'turn-1', timestamp: 123 };
    expect(toApiMessage(msg)).toEqual({});
  });

  it('uses GEMINI_API_FIELDS to keep only role and parts', () => {
    const msg = { role: 'user', parts: [{ text: 'hi' }], turnId: 'turn-1', type: 'intervention' };
    expect(toApiMessage(msg, GEMINI_API_FIELDS)).toEqual({
      role: 'user',
      parts: [{ text: 'hi' }],
    });
  });

  it('GEMINI_API_FIELDS strips content (not a Gemini field)', () => {
    const msg = { role: 'model', parts: [{ text: 'hi' }], content: 'leftover' };
    expect(toApiMessage(msg, GEMINI_API_FIELDS)).toEqual({
      role: 'model',
      parts: [{ text: 'hi' }],
    });
  });

  it('does not mutate the input message', () => {
    const msg = { role: 'user', content: 'hi', type: 'intervention', turnId: 'turn-1' };
    const original = { ...msg };
    toApiMessage(msg);
    expect(msg).toEqual(original);
  });
});

describe('field set contents', () => {
  it('MESSAGE_API_FIELDS contains expected fields', () => {
    expect(MESSAGE_API_FIELDS.has('role')).toBe(true);
    expect(MESSAGE_API_FIELDS.has('content')).toBe(true);
    expect(MESSAGE_API_FIELDS.has('tool_calls')).toBe(true);
    expect(MESSAGE_API_FIELDS.has('tool_call_id')).toBe(true);
    expect(MESSAGE_API_FIELDS.has('name')).toBe(true);
    // Internal fields must NOT be in the set
    expect(MESSAGE_API_FIELDS.has('turnId')).toBe(false);
    expect(MESSAGE_API_FIELDS.has('type')).toBe(false);
    expect(MESSAGE_API_FIELDS.has('messageType')).toBe(false);
    expect(MESSAGE_API_FIELDS.has('timestamp')).toBe(false);
  });

  it('GEMINI_API_FIELDS contains expected fields', () => {
    expect(GEMINI_API_FIELDS.has('role')).toBe(true);
    expect(GEMINI_API_FIELDS.has('parts')).toBe(true);
    expect(GEMINI_API_FIELDS.has('content')).toBe(false);
    expect(GEMINI_API_FIELDS.has('turnId')).toBe(false);
    expect(GEMINI_API_FIELDS.has('type')).toBe(false);
  });
});
