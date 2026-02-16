import type { SkillManifest } from '../types/skills.js';
import type { HookRulesConfig, HookRuleConfig, HookActionConfig } from '../types/hooks.js';

/**
 * Parse a SKILL.md file content into manifest and instructions
 *
 * The format is:
 * ```
 * ---
 * name: skill-name
 * description: What the skill does
 * allowedTools: bash, runjs  # optional, comma-separated
 * hooks:  # optional
 *   PreToolUse:
 *     - matcher: "^bash$"
 *       hooks:
 *         - action: deny
 *           reason: "Not allowed"
 * dependencies:  # optional
 *   - other-skill
 * argumentHint: "[message]"  # optional
 * disableModelInvocation: false  # optional
 * userInvocable: true  # optional
 * ---
 *
 * Instructions with $ARGUMENTS, $0, $1 substitution...
 * ```
 */
export function parseSkillMd(content: string): { manifest: SkillManifest; instructions: string } {
  // Find the YAML frontmatter between --- markers
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error('Missing or invalid frontmatter: SKILL.md must start with --- and have a closing ---');
  }

  const yamlContent = frontmatterMatch[1];
  const instructions = frontmatterMatch[2].trim();

  // Parse the YAML
  const parsed = parseSimpleYaml(yamlContent);

  // Validate required fields
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Missing required field: name');
  }
  if (!parsed.description || typeof parsed.description !== 'string') {
    throw new Error('Missing required field: description');
  }

  // Validate name format
  if (!isValidSkillName(parsed.name)) {
    throw new Error(`Invalid skill name "${parsed.name}": must be lowercase letters, numbers, and hyphens, starting with a letter`);
  }

  // Build the manifest
  const manifest: SkillManifest = {
    name: parsed.name,
    description: parsed.description,
  };

  // Handle allowedTools (can be comma-separated string or array)
  if (parsed.allowedTools !== undefined) {
    if (typeof parsed.allowedTools === 'string') {
      manifest.allowedTools = parsed.allowedTools.split(',').map((s: string) => s.trim()).filter(Boolean);
    } else if (Array.isArray(parsed.allowedTools)) {
      manifest.allowedTools = parsed.allowedTools.map((s: string) => String(s).trim());
    }
  }

  // Handle hooks
  if (parsed.hooks && typeof parsed.hooks === 'object') {
    manifest.hooks = parseHooksConfig(parsed.hooks as Record<string, unknown>);
  }

  // Handle dependencies
  if (parsed.dependencies !== undefined) {
    if (Array.isArray(parsed.dependencies)) {
      manifest.dependencies = parsed.dependencies.map((s: unknown) => String(s).trim());
    }
  }

  // Handle optional string fields
  if (typeof parsed.argumentHint === 'string') {
    manifest.argumentHint = parsed.argumentHint;
  }

  // Handle optional boolean fields
  if (typeof parsed.disableModelInvocation === 'boolean') {
    manifest.disableModelInvocation = parsed.disableModelInvocation;
  }
  if (typeof parsed.userInvocable === 'boolean') {
    manifest.userInvocable = parsed.userInvocable;
  }

  // Handle optional integrity field
  if (typeof parsed.integrity === 'string') {
    manifest.integrity = parsed.integrity;
  }

  return { manifest, instructions };
}

/**
 * Parse hooks configuration from parsed YAML
 */
function parseHooksConfig(hooks: Record<string, unknown>): HookRulesConfig {
  const config: HookRulesConfig = {};

  const hookTypes = ['PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'AgentStart', 'AgentEnd'] as const;

  for (const hookType of hookTypes) {
    const rules = hooks[hookType];
    if (Array.isArray(rules)) {
      config[hookType] = rules.map(parseHookRule);
    }
  }

  return config;
}

/**
 * Parse a single hook rule
 */
function parseHookRule(rule: unknown): HookRuleConfig {
  if (typeof rule !== 'object' || rule === null) {
    throw new Error('Invalid hook rule: must be an object');
  }

  const ruleObj = rule as Record<string, unknown>;
  const result: HookRuleConfig = {
    hooks: [],
  };

  if (typeof ruleObj.matcher === 'string') {
    result.matcher = ruleObj.matcher;
  }

  if (ruleObj.inputMatchers && typeof ruleObj.inputMatchers === 'object') {
    result.inputMatchers = ruleObj.inputMatchers as Record<string, string>;
  }

  if (typeof ruleObj.priority === 'number') {
    result.priority = ruleObj.priority;
  }

  if (Array.isArray(ruleObj.hooks)) {
    result.hooks = ruleObj.hooks.map(parseHookAction);
  }

  return result;
}

/**
 * Parse a hook action
 */
function parseHookAction(action: unknown): HookActionConfig {
  if (typeof action !== 'object' || action === null) {
    throw new Error('Invalid hook action: must be an object');
  }

  const actionObj = action as Record<string, unknown>;
  const result: HookActionConfig = {
    type: 'action',
    action: 'allow',
  };

  if (typeof actionObj.action === 'string') {
    const validActions = ['deny', 'allow', 'log', 'script'];
    if (validActions.includes(actionObj.action)) {
      result.action = actionObj.action as 'deny' | 'allow' | 'log' | 'script';
    }
  }

  if (typeof actionObj.reason === 'string') {
    result.reason = actionObj.reason;
  }

  if (typeof actionObj.script === 'string') {
    result.script = actionObj.script;
  }

  if (typeof actionObj.continueOnError === 'boolean') {
    result.continueOnError = actionObj.continueOnError;
  }

  return result;
}

/**
 * Simple YAML parser that handles:
 * - Simple key: value pairs
 * - Arrays (both inline [a, b] and multi-line with - item)
 * - Nested objects
 * - Strings (with or without quotes)
 * - Booleans (true/false)
 * - Numbers
 */
function parseSimpleYaml(content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  return parseYamlLines(lines, 0, 0).result;
}

interface ParseResult {
  result: Record<string, unknown>;
  endIndex: number;
}

function parseYamlLines(lines: string[], startIndex: number, baseIndent: number): ParseResult {
  const result: Record<string, unknown> = {};
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    // Calculate indentation
    const indent = line.search(/\S/);
    if (indent === -1) {
      i++;
      continue;
    }

    // If we've dedented, we're done with this block
    if (indent < baseIndent) {
      return { result, endIndex: i };
    }

    // If this is the first line or at expected indent, process it
    if (indent === baseIndent) {
      const trimmed = line.trim();

      // Check if this is an array item at the current level
      if (trimmed.startsWith('- ')) {
        // This shouldn't happen at the object level
        return { result, endIndex: i };
      }

      // Parse key: value
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) {
        i++;
        continue;
      }

      const key = trimmed.substring(0, colonIndex).trim();
      const valueStr = trimmed.substring(colonIndex + 1).trim();

      if (valueStr === '') {
        // Could be a nested object or array - look at next line
        const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
        if (nextNonEmpty !== null) {
          const nextLine = lines[nextNonEmpty];
          const nextIndent = nextLine.search(/\S/);
          const nextTrimmed = nextLine.trim();

          if (nextIndent > indent) {
            if (nextTrimmed.startsWith('- ')) {
              // It's an array
              const arrayResult = parseYamlArray(lines, nextNonEmpty, nextIndent);
              result[key] = arrayResult.result;
              i = arrayResult.endIndex;
            } else {
              // It's a nested object
              const nestedResult = parseYamlLines(lines, nextNonEmpty, nextIndent);
              result[key] = nestedResult.result;
              i = nestedResult.endIndex;
            }
          } else {
            result[key] = null;
            i++;
          }
        } else {
          result[key] = null;
          i++;
        }
      } else {
        // Inline value
        result[key] = parseYamlValue(valueStr);
        i++;
      }
    } else {
      // Unexpected indent - skip
      i++;
    }
  }

  return { result, endIndex: i };
}

interface ArrayParseResult {
  result: unknown[];
  endIndex: number;
}

function parseYamlArray(lines: string[], startIndex: number, baseIndent: number): ArrayParseResult {
  const result: unknown[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent === -1) {
      i++;
      continue;
    }

    // If we've dedented, we're done with this array
    if (indent < baseIndent) {
      return { result, endIndex: i };
    }

    if (indent === baseIndent) {
      const trimmed = line.trim();

      if (!trimmed.startsWith('- ')) {
        // Not an array item at this level, done
        return { result, endIndex: i };
      }

      const itemContent = trimmed.substring(2).trim();

      if (itemContent === '') {
        // Empty array item with potential nested content
        const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
        if (nextNonEmpty !== null) {
          const nextLine = lines[nextNonEmpty];
          const nextIndent = nextLine.search(/\S/);

          if (nextIndent > indent) {
            const nextTrimmed = nextLine.trim();
            if (nextTrimmed.startsWith('- ')) {
              // Nested array
              const nestedArray = parseYamlArray(lines, nextNonEmpty, nextIndent);
              result.push(nestedArray.result);
              i = nestedArray.endIndex;
            } else {
              // Nested object
              const nestedObj = parseYamlLines(lines, nextNonEmpty, nextIndent);
              result.push(nestedObj.result);
              i = nestedObj.endIndex;
            }
          } else {
            result.push(null);
            i++;
          }
        } else {
          result.push(null);
          i++;
        }
      } else if (itemContent.includes(':')) {
        // Array item starts with key: value - could be inline object start
        // Check if there's nested content below
        const nextNonEmpty = findNextNonEmptyLine(lines, i + 1);
        if (nextNonEmpty !== null) {
          const nextLine = lines[nextNonEmpty];
          const nextIndent = nextLine.search(/\S/);

          // Calculate the indent of the content after "- "
          const itemContentIndent = indent + 2;

          if (nextIndent > indent && nextIndent >= itemContentIndent) {
            // There's nested content - parse as object including the first line
            const colonIdx = itemContent.indexOf(':');
            const firstKey = itemContent.substring(0, colonIdx).trim();
            const firstValue = itemContent.substring(colonIdx + 1).trim();

            const nestedObj = parseYamlLines(lines, nextNonEmpty, nextIndent);
            const obj = nestedObj.result;

            // Add the first key-value to the object
            if (firstValue === '') {
              // The value is the nested content
              // Need to look more carefully...
              // Actually, for "- matcher: regex" followed by "  hooks:" at same indent after -
              // This is tricky - let's handle the simple case
              obj[firstKey] = firstValue === '' ? null : parseYamlValue(firstValue);
            } else {
              obj[firstKey] = parseYamlValue(firstValue);
            }

            result.push(obj);
            i = nestedObj.endIndex;
          } else {
            // Single-line object
            const colonIdx = itemContent.indexOf(':');
            const key = itemContent.substring(0, colonIdx).trim();
            const value = itemContent.substring(colonIdx + 1).trim();
            result.push({ [key]: parseYamlValue(value) });
            i++;
          }
        } else {
          // Single-line object
          const colonIdx = itemContent.indexOf(':');
          const key = itemContent.substring(0, colonIdx).trim();
          const value = itemContent.substring(colonIdx + 1).trim();
          result.push({ [key]: parseYamlValue(value) });
          i++;
        }
      } else {
        // Simple value
        result.push(parseYamlValue(itemContent));
        i++;
      }
    } else {
      // More indented than expected - skip
      i++;
    }
  }

  return { result, endIndex: i };
}

function findNextNonEmptyLine(lines: string[], startIndex: number): number | null {
  for (let i = startIndex; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      return i;
    }
  }
  return null;
}

function parseYamlValue(value: string): unknown {
  // Handle inline arrays
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => parseYamlValue(s.trim()));
  }

  // Handle quoted strings
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Handle booleans
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Handle null
  if (value === 'null' || value === '~') return null;

  // Handle numbers
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;

  // Default to string
  return value;
}

/**
 * Substitute argument placeholders in skill instructions
 *
 * Supports:
 * - $ARGUMENTS - the full argument string
 * - $0, $1, $2... - individual arguments (space-separated, respecting quotes)
 */
export function substituteArguments(text: string, args: string): string {
  // Replace $ARGUMENTS with full args string
  let result = text.replace(/\$ARGUMENTS/g, args);

  // Parse arguments respecting quotes
  const parsedArgs = parseArguments(args);

  // Replace numbered arguments $0, $1, $2, etc.
  // Only replace if the argument exists
  result = result.replace(/\$(\d+)/g, (match, numStr) => {
    const num = parseInt(numStr, 10);
    if (num < parsedArgs.length) {
      return parsedArgs[num];
    }
    return match; // Keep original if arg doesn't exist
  });

  return result;
}

/**
 * Parse arguments string respecting quoted strings
 */
function parseArguments(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < args.length; i++) {
    const char = args[i];

    if (!inQuotes && (char === '"' || char === "'")) {
      // Start of quoted section - include the quote in the argument
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar) {
      // End of quoted section - include the quote in the argument
      current += char;
      inQuotes = false;
      quoteChar = '';
    } else if (!inQuotes && char === ' ') {
      // Space outside quotes - end of argument
      if (current !== '') {
        result.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  // Don't forget the last argument
  if (current !== '') {
    result.push(current);
  }

  return result;
}

/**
 * Validate skill name format
 * Must be lowercase letters, numbers, and hyphens. Must start with a letter.
 */
export function isValidSkillName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Compute SHA-256 hash of skill content for integrity verification.
 * Returns hash in format "sha256-{hex}"
 */
export async function computeSkillHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hashHex}`;
}
