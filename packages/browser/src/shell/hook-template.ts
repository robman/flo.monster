/**
 * Hook template rendering utilities.
 *
 * Provides variable substitution for hook command templates, allowing
 * dynamic values to be injected based on tool execution context.
 */

/**
 * Context for rendering hook templates.
 */
export interface HookTemplateContext {
  /** Name of the tool being executed */
  toolName?: string;
  /** Input parameters passed to the tool */
  toolInput?: Record<string, unknown>;
  /** Result from tool execution (PostToolUse only) */
  toolResult?: {
    content: string;
    is_error?: boolean;
  };
}

/**
 * Render a hook command template by substituting variables.
 *
 * Template variables:
 * - {{toolName}} - name of the tool
 * - {{input.fieldName}} - value from tool input (e.g., {{input.path}})
 * - {{result.content}} - tool result content (PostToolUse only)
 * - {{result.is_error}} - whether tool result is error (PostToolUse only)
 *
 * @param template The command template string
 * @param context The context with values to substitute
 * @returns The rendered command string
 *
 * @example
 * ```typescript
 * const command = renderHookTemplate(
 *   'echo "Tool {{toolName}} called with path {{input.path}}"',
 *   { toolName: 'read_file', toolInput: { path: '/tmp/test.txt' } }
 * );
 * // Result: 'echo "Tool read_file called with path /tmp/test.txt"'
 * ```
 */
export function renderHookTemplate(
  template: string,
  context: HookTemplateContext
): string {
  let result = template;

  // Replace {{toolName}}
  result = result.replace(/\{\{toolName\}\}/g, context.toolName ?? '');

  // Replace {{input.X}} patterns
  result = result.replace(/\{\{input\.(\w+)\}\}/g, (_match, fieldName) => {
    const value = context.toolInput?.[fieldName];
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  });

  // Replace {{result.content}}
  result = result.replace(
    /\{\{result\.content\}\}/g,
    context.toolResult?.content ?? ''
  );

  // Replace {{result.is_error}}
  result = result.replace(
    /\{\{result\.is_error\}\}/g,
    String(context.toolResult?.is_error ?? false)
  );

  return result;
}
