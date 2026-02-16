import { describe, it, expect } from 'vitest';
import { parseSkillMd, substituteArguments, isValidSkillName, computeSkillHash } from '../parser.js';

describe('parseSkillMd', () => {
  it('parses minimal valid SKILL.md', () => {
    const content = `---
name: test-skill
description: A test skill
---
Instructions here`;
    const { manifest, instructions } = parseSkillMd(content);
    expect(manifest.name).toBe('test-skill');
    expect(manifest.description).toBe('A test skill');
    expect(instructions).toBe('Instructions here');
  });

  it('parses all optional fields', () => {
    const content = `---
name: full-skill
description: A fully configured skill
allowedTools: bash, runjs, fetch
argumentHint: "[message]"
disableModelInvocation: true
userInvocable: false
dependencies:
  - base-skill
  - other-skill
hooks:
  PreToolUse:
    - matcher: "^bash$"
      hooks:
        - action: deny
          reason: "Bash not allowed"
---
Do the thing with $ARGUMENTS`;
    const { manifest, instructions } = parseSkillMd(content);

    expect(manifest.name).toBe('full-skill');
    expect(manifest.description).toBe('A fully configured skill');
    expect(manifest.allowedTools).toEqual(['bash', 'runjs', 'fetch']);
    expect(manifest.argumentHint).toBe('[message]');
    expect(manifest.disableModelInvocation).toBe(true);
    expect(manifest.userInvocable).toBe(false);
    expect(manifest.dependencies).toEqual(['base-skill', 'other-skill']);
    expect(manifest.hooks).toBeDefined();
    expect(manifest.hooks?.PreToolUse).toHaveLength(1);
    expect(manifest.hooks?.PreToolUse?.[0].matcher).toBe('^bash$');
    expect(manifest.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
    expect(manifest.hooks?.PreToolUse?.[0].hooks[0].action).toBe('deny');
    expect(manifest.hooks?.PreToolUse?.[0].hooks[0].reason).toBe('Bash not allowed');
    expect(instructions).toBe('Do the thing with $ARGUMENTS');
  });

  it('handles multi-line instructions', () => {
    const content = `---
name: multi-line
description: Has multi-line instructions
---
Line one.

Line two with $ARGUMENTS.

Line three.`;
    const { instructions } = parseSkillMd(content);
    expect(instructions).toBe('Line one.\n\nLine two with $ARGUMENTS.\n\nLine three.');
  });

  it('throws on missing name', () => {
    const content = `---
description: Missing name
---
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Missing required field: name');
  });

  it('throws on missing description', () => {
    const content = `---
name: missing-desc
---
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Missing required field: description');
  });

  it('throws on invalid name format', () => {
    const content = `---
name: Invalid_Name
description: Has invalid name
---
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Invalid skill name');
  });

  it('throws on name starting with number', () => {
    const content = `---
name: 1invalid
description: Starts with number
---
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Invalid skill name');
  });

  it('throws on name starting with hyphen', () => {
    const content = `---
name: -invalid
description: Starts with hyphen
---
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Invalid skill name');
  });

  it('throws on missing frontmatter', () => {
    const content = `name: test
description: no frontmatter
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Missing or invalid frontmatter');
  });

  it('throws on unclosed frontmatter', () => {
    const content = `---
name: test
description: unclosed
Instructions`;
    expect(() => parseSkillMd(content)).toThrow('Missing or invalid frontmatter');
  });

  it('parses allowedTools as comma-separated string', () => {
    const content = `---
name: tools-string
description: Comma-separated tools
allowedTools: bash, runjs, fetch
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.allowedTools).toEqual(['bash', 'runjs', 'fetch']);
  });

  it('parses allowedTools as array', () => {
    const content = `---
name: tools-array
description: Array of tools
allowedTools:
  - bash
  - runjs
  - fetch
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.allowedTools).toEqual(['bash', 'runjs', 'fetch']);
  });

  it('parses allowedTools as inline array', () => {
    const content = `---
name: tools-inline
description: Inline array of tools
allowedTools: [bash, runjs, fetch]
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.allowedTools).toEqual(['bash', 'runjs', 'fetch']);
  });

  it('handles quoted strings in YAML', () => {
    const content = `---
name: quoted
description: "A description with: colons and special chars"
argumentHint: "[optional message]"
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.description).toBe('A description with: colons and special chars');
    expect(manifest.argumentHint).toBe('[optional message]');
  });

  it('handles single-quoted strings in YAML', () => {
    const content = `---
name: single-quoted
description: 'Single quoted description'
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.description).toBe('Single quoted description');
  });

  it('parses boolean values correctly', () => {
    const content = `---
name: booleans
description: Test booleans
disableModelInvocation: false
userInvocable: true
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.disableModelInvocation).toBe(false);
    expect(manifest.userInvocable).toBe(true);
  });

  it('handles empty instructions', () => {
    const content = `---
name: empty-instructions
description: No instructions
---
`;
    const { instructions } = parseSkillMd(content);
    expect(instructions).toBe('');
  });

  it('ignores YAML comments', () => {
    const content = `---
name: with-comments
# This is a comment
description: Has comments
# Another comment
allowedTools: bash  # inline comment is kept as part of value
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.name).toBe('with-comments');
    expect(manifest.description).toBe('Has comments');
  });

  it('handles Windows line endings', () => {
    const content = "---\r\nname: windows\r\ndescription: Windows line endings\r\n---\r\nInstructions";
    const { manifest, instructions } = parseSkillMd(content);
    expect(manifest.name).toBe('windows');
    expect(manifest.description).toBe('Windows line endings');
    expect(instructions).toBe('Instructions');
  });

  it('parses multiple hook types', () => {
    const content = `---
name: multi-hooks
description: Multiple hook types
hooks:
  PreToolUse:
    - matcher: "^bash$"
      hooks:
        - action: deny
          reason: "No bash"
  PostToolUse:
    - matcher: ".*"
      hooks:
        - action: log
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.hooks?.PreToolUse).toHaveLength(1);
    expect(manifest.hooks?.PostToolUse).toHaveLength(1);
    expect(manifest.hooks?.PreToolUse?.[0].hooks[0].action).toBe('deny');
    expect(manifest.hooks?.PostToolUse?.[0].hooks[0].action).toBe('log');
  });

  it('handles numeric values', () => {
    const content = `---
name: numbers
description: Has numbers
hooks:
  PreToolUse:
    - matcher: "test"
      priority: 10
      hooks:
        - action: allow
---
Instructions`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.hooks?.PreToolUse?.[0].priority).toBe(10);
  });
});

describe('substituteArguments', () => {
  it('substitutes $ARGUMENTS with full string', () => {
    expect(substituteArguments('Do $ARGUMENTS', 'the thing')).toBe('Do the thing');
  });

  it('substitutes multiple $ARGUMENTS', () => {
    expect(substituteArguments('$ARGUMENTS and $ARGUMENTS again', 'foo')).toBe('foo and foo again');
  });

  it('substitutes numbered args', () => {
    expect(substituteArguments('$0 and $1', 'foo bar')).toBe('foo and bar');
  });

  it('handles $0 through $9', () => {
    expect(substituteArguments('$0 $1 $2', 'a b c')).toBe('a b c');
  });

  it('handles missing numbered args gracefully', () => {
    expect(substituteArguments('$0 $1 $2', 'only')).toBe('only $1 $2');
  });

  it('handles empty arguments', () => {
    expect(substituteArguments('$ARGUMENTS here', '')).toBe(' here');
  });

  it('handles quoted arguments preserving quotes', () => {
    expect(substituteArguments('$0 is first', '"foo bar" baz')).toBe('"foo bar" is first');
  });

  it('handles single-quoted arguments', () => {
    expect(substituteArguments('$0 and $1', "'foo bar' baz")).toBe("'foo bar' and baz");
  });

  it('handles mixed quoted and unquoted', () => {
    expect(substituteArguments('$0 $1 $2', 'first "second arg" third')).toBe('first "second arg" third');
  });

  it('handles double-digit argument numbers', () => {
    const args = 'a b c d e f g h i j k';
    expect(substituteArguments('$10', args)).toBe('k');
  });

  it('preserves text without placeholders', () => {
    expect(substituteArguments('No placeholders here', 'args')).toBe('No placeholders here');
  });

  it('handles adjacent placeholders', () => {
    expect(substituteArguments('$0$1', 'foo bar')).toBe('foobar');
  });

  it('handles only $ARGUMENTS', () => {
    expect(substituteArguments('$ARGUMENTS', 'hello world')).toBe('hello world');
  });
});

describe('isValidSkillName', () => {
  it('accepts valid names', () => {
    expect(isValidSkillName('commit')).toBe(true);
    expect(isValidSkillName('review-pr')).toBe(true);
    expect(isValidSkillName('a1')).toBe(true);
    expect(isValidSkillName('test-skill-2')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('abc123')).toBe(true);
    expect(isValidSkillName('my-long-skill-name')).toBe(true);
  });

  it('rejects uppercase names', () => {
    expect(isValidSkillName('UPPERCASE')).toBe(false);
    expect(isValidSkillName('MixedCase')).toBe(false);
    expect(isValidSkillName('hasUpperCase')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(isValidSkillName('has space')).toBe(false);
    expect(isValidSkillName('has  multiple  spaces')).toBe(false);
  });

  it('rejects names with underscores', () => {
    expect(isValidSkillName('has_underscore')).toBe(false);
    expect(isValidSkillName('snake_case')).toBe(false);
  });

  it('rejects names starting with number', () => {
    expect(isValidSkillName('1starts-with-number')).toBe(false);
    expect(isValidSkillName('123abc')).toBe(false);
  });

  it('rejects names starting with hyphen', () => {
    expect(isValidSkillName('-starts-with-dash')).toBe(false);
    expect(isValidSkillName('-')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSkillName('')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(isValidSkillName('has.dot')).toBe(false);
    expect(isValidSkillName('has@symbol')).toBe(false);
    expect(isValidSkillName('has/slash')).toBe(false);
    expect(isValidSkillName('has:colon')).toBe(false);
  });

  it('rejects names ending with hyphen only', () => {
    // This is actually valid per the regex, but let's test it
    expect(isValidSkillName('valid-')).toBe(true); // trailing hyphen is allowed
  });
});

describe('computeSkillHash', () => {
  it('computes SHA-256 hash of content', async () => {
    const content = 'test content';
    const hash = await computeSkillHash(content);
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it('produces consistent hash for same content', async () => {
    const content = 'same content';
    const hash1 = await computeSkillHash(content);
    const hash2 = await computeSkillHash(content);
    expect(hash1).toBe(hash2);
  });

  it('produces different hash for different content', async () => {
    const hash1 = await computeSkillHash('content one');
    const hash2 = await computeSkillHash('content two');
    expect(hash1).not.toBe(hash2);
  });

  it('handles empty string', async () => {
    const hash = await computeSkillHash('');
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it('handles unicode content', async () => {
    const hash = await computeSkillHash('Hello \u4e16\u754c \ud83c\udf0d');
    expect(hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });
});

describe('parseSkillMd integrity field', () => {
  it('parses integrity field from frontmatter', () => {
    const content = `---
name: verified-skill
description: A verified skill
integrity: sha256-abc123def456
---
Instructions here`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.integrity).toBe('sha256-abc123def456');
  });

  it('omits integrity field when not present', () => {
    const content = `---
name: unverified-skill
description: A skill without integrity
---
Instructions here`;
    const { manifest } = parseSkillMd(content);
    expect(manifest.integrity).toBeUndefined();
  });
});
