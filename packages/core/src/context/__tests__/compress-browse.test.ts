import { describe, it, expect } from 'vitest';
import { compressBrowseResults } from '../compress-browse.js';

// Helper to build a browse tool_result content string
function makeBrowseResult(url: string, title: string, tree: string = '- RootWebArea "Page"\n  - link "Home" [e1]\n  - heading "Welcome" [e2]'): string {
  return `URL: ${url}\nTitle: ${title}\n\n${tree}`;
}

// Helper to build an intervention notification with a page snapshot
function makeIntervention(actions: string, url: string, title: string, tree: string = '- RootWebArea "Page"\n  - link "Home" [e1]'): string {
  return `[User intervention ended — visible mode]\n\nUser actions during intervention:\n${actions}\n\nCurrent page state:\nURL: ${url}\nTitle: ${title}\n\n${tree}`;
}

// Helper to wrap content in a user message with tool_result block
function toolResultMsg(toolUseId: string, content: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

// Helper to wrap text in an assistant message
function assistantMsg(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

// Helper for a user text message (e.g. intervention notification)
function userTextMsg(text: string): Record<string, unknown> {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

describe('compressBrowseResults', () => {
  it('returns messages as-is when there are no browse results', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      assistantMsg('Hi there'),
    ];
    const result = compressBrowseResults(messages);
    expect(result).toBe(messages); // same reference — no modification
  });

  it('returns messages as-is when there is only one browse result', () => {
    const messages = [
      toolResultMsg('t1', makeBrowseResult('https://example.com', 'Example')),
    ];
    const result = compressBrowseResults(messages);
    expect(result).toBe(messages);
  });

  it('compresses earlier browse results but keeps the last one intact', () => {
    const tree1 = '- RootWebArea "Page1"\n  - link "Link1" [e1]';
    const tree2 = '- RootWebArea "Page2"\n  - link "Link2" [e1]\n  - button "Submit" [e2]';
    const messages = [
      toolResultMsg('t1', makeBrowseResult('https://a.com', 'Page A', tree1)),
      assistantMsg('I see the page'),
      toolResultMsg('t2', makeBrowseResult('https://b.com', 'Page B', tree2)),
    ];

    const result = compressBrowseResults(messages);

    // First result should be compressed
    const firstContent = (result[0].content as any[])[0];
    expect(firstContent.content).toBe('Browsed: Page A (https://a.com)');
    expect(firstContent.type).toBe('tool_result');
    expect(firstContent.tool_use_id).toBe('t1');

    // Last result should be intact
    const lastContent = (result[2].content as any[])[0];
    expect(lastContent.content).toBe(makeBrowseResult('https://b.com', 'Page B', tree2));
  });

  it('compresses multiple earlier results, keeping only the last', () => {
    const messages = [
      toolResultMsg('t1', makeBrowseResult('https://a.com', 'Page A')),
      assistantMsg('Clicking link'),
      toolResultMsg('t2', makeBrowseResult('https://b.com', 'Page B')),
      assistantMsg('Scrolling down'),
      toolResultMsg('t3', makeBrowseResult('https://c.com', 'Page C')),
    ];

    const result = compressBrowseResults(messages);

    // First two compressed
    expect((result[0].content as any[])[0].content).toBe('Browsed: Page A (https://a.com)');
    expect((result[2].content as any[])[0].content).toBe('Browsed: Page B (https://b.com)');

    // Third kept intact
    expect((result[4].content as any[])[0].content).toContain('- RootWebArea');
  });

  it('truncates intervention notification trees', () => {
    const interventionText = makeIntervention(
      '  - mouse moved to (882, 581)\n  - scrolled down',
      'https://example.com',
      'Example Page',
      '- RootWebArea "Example Page"\n  - link "Home" [e1]\n  - heading "Welcome" [e2]',
    );
    const messages = [
      userTextMsg(interventionText),
      assistantMsg('I see the changes'),
      toolResultMsg('t1', makeBrowseResult('https://example.com', 'Example Page')),
    ];

    const result = compressBrowseResults(messages);

    // Intervention should have tree truncated
    const interventionBlock = (result[0].content as any[])[0];
    expect(interventionBlock.text).toContain('User actions during intervention');
    expect(interventionBlock.text).toContain('Current page state:\nURL: https://example.com\nTitle: Example Page');
    expect(interventionBlock.text).not.toContain('RootWebArea');

    // Browse result kept intact (it's the last)
    expect((result[2].content as any[])[0].content).toContain('- RootWebArea');
  });

  it('handles mixed browse results and interventions — last tree wins', () => {
    const messages = [
      toolResultMsg('t1', makeBrowseResult('https://a.com', 'Page A')),
      assistantMsg('Browsing'),
      userTextMsg(makeIntervention('  - clicked button', 'https://b.com', 'Page B')),
      assistantMsg('After intervention'),
      toolResultMsg('t2', makeBrowseResult('https://c.com', 'Page C')),
    ];

    const result = compressBrowseResults(messages);

    // First browse result compressed
    expect((result[0].content as any[])[0].content).toBe('Browsed: Page A (https://a.com)');

    // Intervention tree truncated
    const interventionBlock = (result[2].content as any[])[0];
    expect(interventionBlock.text).not.toContain('RootWebArea');
    expect(interventionBlock.text).toContain('URL: https://b.com');

    // Last browse result kept intact
    expect((result[4].content as any[])[0].content).toContain('- RootWebArea');
  });

  it('does not compress bot protection warnings (no tree)', () => {
    const botWarning = 'URL: https://protected.com\nTitle: Access Denied\n\n' +
      'BOT PROTECTION: This site uses advanced bot detection.';
    const messages = [
      toolResultMsg('t1', botWarning),
      toolResultMsg('t2', makeBrowseResult('https://example.com', 'Example')),
    ];

    const result = compressBrowseResults(messages);

    // Bot warning doesn't match the tree pattern (no "- " line after blank), stays intact
    expect((result[0].content as any[])[0].content).toBe(botWarning);
  });

  it('does not mutate input messages', () => {
    const original1 = makeBrowseResult('https://a.com', 'Page A');
    const original2 = makeBrowseResult('https://b.com', 'Page B');
    const messages = [
      toolResultMsg('t1', original1),
      toolResultMsg('t2', original2),
    ];

    // Deep snapshot of content before compression
    const contentBefore1 = (messages[0].content as any[])[0].content;
    const contentBefore2 = (messages[1].content as any[])[0].content;

    compressBrowseResults(messages);

    // Original messages unchanged
    expect((messages[0].content as any[])[0].content).toBe(contentBefore1);
    expect((messages[1].content as any[])[0].content).toBe(contentBefore2);
  });

  it('handles browse results with bot protection prefix before URL line', () => {
    const contentWithPrefix = '⚠️ BOT PROTECTION DETECTED\n\nURL: https://example.com\nTitle: Protected Page\n\n- RootWebArea "Protected"\n  - text "Captcha"';
    const messages = [
      toolResultMsg('t1', contentWithPrefix),
      toolResultMsg('t2', makeBrowseResult('https://other.com', 'Other Page')),
    ];

    const result = compressBrowseResults(messages);

    // First result with bot prefix should still be compressed (URL line found within first 10 lines)
    expect((result[0].content as any[])[0].content).toBe('Browsed: Protected Page (https://example.com)');
  });

  it('preserves non-browse content blocks in the same message', () => {
    const messages: Array<Record<string, unknown>> = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Here is the result' },
          { type: 'tool_result', tool_use_id: 't1', content: makeBrowseResult('https://a.com', 'Page A') },
        ],
      },
      toolResultMsg('t2', makeBrowseResult('https://b.com', 'Page B')),
    ];

    const result = compressBrowseResults(messages);

    // Text block preserved
    expect((result[0].content as any[])[0]).toEqual({ type: 'text', text: 'Here is the result' });
    // Browse result compressed
    expect((result[0].content as any[])[1].content).toBe('Browsed: Page A (https://a.com)');
    // Last browse result intact
    expect((result[1].content as any[])[0].content).toContain('- RootWebArea');
  });

  it('handles messages with string content (not array)', () => {
    const messages: Array<Record<string, unknown>> = [
      { role: 'user', content: 'Just a string message' },
      toolResultMsg('t1', makeBrowseResult('https://a.com', 'Page A')),
      toolResultMsg('t2', makeBrowseResult('https://b.com', 'Page B')),
    ];

    const result = compressBrowseResults(messages);

    // String content message passes through
    expect(result[0]).toBe(messages[0]);
    // First browse compressed, second kept
    expect((result[1].content as any[])[0].content).toBe('Browsed: Page A (https://a.com)');
    expect((result[2].content as any[])[0].content).toContain('- RootWebArea');
  });

  it('handles empty messages array', () => {
    const result = compressBrowseResults([]);
    expect(result).toEqual([]);
  });

  it('intervention as last tree is kept intact', () => {
    const interventionText = makeIntervention(
      '  - clicked link',
      'https://example.com',
      'Example Page',
    );
    const messages = [
      toolResultMsg('t1', makeBrowseResult('https://a.com', 'Page A')),
      userTextMsg(interventionText),
    ];

    const result = compressBrowseResults(messages);

    // Browse result compressed (not the last tree)
    expect((result[0].content as any[])[0].content).toBe('Browsed: Page A (https://a.com)');
    // Intervention kept intact (it IS the last tree)
    expect((result[1].content as any[])[0].text).toContain('RootWebArea');
  });
});
