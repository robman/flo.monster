/**
 * Safe declarative expression evaluator.
 * Replaces new Function() for evaluating conditions on state values.
 * Supports comparison operators and keywords — no arbitrary JS execution.
 */

/**
 * Evaluate a safe condition expression against a value.
 *
 * Supported expressions:
 * - 'always' — always true
 * - 'changed' — always true (caller determines if change occurred)
 * - 'true' / 'false' — boolean literals
 * - '> N', '>= N', '< N', '<= N' — numeric comparisons
 * - '== value', '!= value' — string equality (or numeric if both parse as numbers)
 * - '== "quoted"', '!= "quoted"' — explicit string comparison
 *
 * Returns false for any unrecognized expression (fail-safe).
 */
export function evaluateSafeCondition(condition: string, value: unknown): boolean {
  const trimmed = condition.trim();

  // Special keywords
  if (trimmed === 'always') return true;
  if (trimmed === 'changed') return true;
  if (trimmed === 'true') return value === true || value === 'true';
  if (trimmed === 'false') return value === false || value === 'false';

  // Numeric comparisons
  const numValue = typeof value === 'number' ? value : Number(value);

  if (trimmed.startsWith('>= ')) {
    const threshold = Number(trimmed.slice(3));
    return !isNaN(numValue) && !isNaN(threshold) && numValue >= threshold;
  }
  if (trimmed.startsWith('> ')) {
    const threshold = Number(trimmed.slice(2));
    return !isNaN(numValue) && !isNaN(threshold) && numValue > threshold;
  }
  if (trimmed.startsWith('<= ')) {
    const threshold = Number(trimmed.slice(3));
    return !isNaN(numValue) && !isNaN(threshold) && numValue <= threshold;
  }
  if (trimmed.startsWith('< ')) {
    const threshold = Number(trimmed.slice(2));
    return !isNaN(numValue) && !isNaN(threshold) && numValue < threshold;
  }

  // Equality — check for quoted strings first
  if (trimmed.startsWith('== ')) {
    const target = trimmed.slice(3);
    // Quoted string comparison
    const quoted = target.match(/^"(.*)"$/) || target.match(/^'(.*)'$/);
    if (quoted) {
      return String(value) === quoted[1];
    }
    // Unquoted — try numeric first, then string
    return String(value) === target;
  }
  if (trimmed.startsWith('!= ')) {
    const target = trimmed.slice(3);
    const quoted = target.match(/^"(.*)"$/) || target.match(/^'(.*)'$/);
    if (quoted) {
      return String(value) !== quoted[1];
    }
    return String(value) !== target;
  }

  // Unrecognized expression — fail safe (no execution)
  return false;
}
