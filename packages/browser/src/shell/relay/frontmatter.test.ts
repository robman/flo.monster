import { describe, it, expect } from 'vitest';
import { parseFrontmatter, simpleGlobMatch } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses standard frontmatter with --- delimiters', () => {
    const content = `---
title: Hello World
author: Alice
---
Body content here.`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'Hello World', author: 'Alice' });
  });

  it('handles string, number, boolean, and quoted string values', () => {
    const content = `---
name: myfile
count: 42
ratio: 3.14
enabled: true
disabled: false
label: "quoted value"
tag: 'single quoted'
---
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      name: 'myfile',
      count: 42,
      ratio: 3.14,
      enabled: true,
      disabled: false,
      label: 'quoted value',
      tag: 'single quoted',
    });
  });

  it('handles inline array values like [a, b, c]', () => {
    const content = `---
tags: [alpha, beta, gamma]
tools: [bash, read, write]
---
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({
      tags: ['alpha', 'beta', 'gamma'],
      tools: ['bash', 'read', 'write'],
    });
  });

  it('returns null for no frontmatter', () => {
    const content = 'Just some plain text without frontmatter.';
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null for single --- (no closing delimiter)', () => {
    const content = `---
title: Incomplete
No closing delimiter here.`;
    expect(parseFrontmatter(content)).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(parseFrontmatter('')).toBeNull();
  });

  it('handles \\r\\n line endings', () => {
    const content = '---\r\ntitle: CRLF Test\r\ncount: 7\r\n---\r\nBody.';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'CRLF Test', count: 7 });
  });

  it('handles frontmatter with extra whitespace', () => {
    const content = `---
  title:   Spaced Out
  count:   99
---
`;
    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: 'Spaced Out', count: 99 });
  });
});

describe('simpleGlobMatch', () => {
  it('*.md matches file.md but not file.txt', () => {
    expect(simpleGlobMatch('*.md', 'file.md')).toBe(true);
    expect(simpleGlobMatch('*.md', 'file.txt')).toBe(false);
  });

  it('*.srcdoc.md matches game.srcdoc.md but not game.md', () => {
    expect(simpleGlobMatch('*.srcdoc.md', 'game.srcdoc.md')).toBe(true);
    expect(simpleGlobMatch('*.srcdoc.md', 'game.md')).toBe(false);
  });

  it('* matches everything', () => {
    expect(simpleGlobMatch('*', 'anything.txt')).toBe(true);
    expect(simpleGlobMatch('*', 'file.md')).toBe(true);
    expect(simpleGlobMatch('*', '')).toBe(true);
  });

  it('exact match works (no wildcard)', () => {
    expect(simpleGlobMatch('readme.md', 'readme.md')).toBe(true);
    expect(simpleGlobMatch('readme.md', 'other.md')).toBe(false);
  });
});
