/**
 * Serializes Playwright accessibility snapshots into compact YAML-style text
 * that LLM agents can read to understand page structure.
 *
 * Produces ~2-5KB text instead of 500KB+ screenshots, works without vision models.
 */

/** Represents a node from Playwright's accessibility snapshot */
export interface AccessibilityNode {
  role: string;
  name: string;
  value?: string;
  description?: string;
  children?: AccessibilityNode[];
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  level?: number;
  valuemin?: number;
  valuemax?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  url?: string;
  keyshortcuts?: string;
  roledescription?: string;
}

export interface SerializeOptions {
  maxDepth?: number;   // Default: 10
  maxNodes?: number;   // Default: 500
}

export interface ElementRef {
  ref: string;       // e.g., "e1", "e2"
  node: AccessibilityNode;
}

const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
  'option', 'treeitem', 'menuitemcheckbox', 'menuitemradio',
]);

const SKIP_ROLES = new Set(['none', 'presentation']);

/**
 * Returns true for roles that get element refs (interactive elements).
 */
export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/**
 * Walk the tree, assign sequential ref IDs (e1, e2, ...) to all interactive elements.
 * Returns a Map from ref ID to node.
 */
export function assignElementRefs(root: AccessibilityNode): Map<string, AccessibilityNode> {
  const refs = new Map<string, AccessibilityNode>();
  let counter = 0;

  function walk(node: AccessibilityNode): void {
    if (isInteractiveRole(node.role)) {
      counter++;
      refs.set(`e${counter}`, node);
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);
  return refs;
}

/**
 * Check if a node has any interactive descendants within a given depth limit.
 */
function hasInteractiveDescendant(node: AccessibilityNode, maxLevels: number): boolean {
  if (maxLevels <= 0) return false;
  if (!node.children) return false;
  for (const child of node.children) {
    if (isInteractiveRole(child.role)) return true;
    if (hasInteractiveDescendant(child, maxLevels - 1)) return true;
  }
  return false;
}

/** Roles considered structural/semantic — never pruned as "empty" */
const SEMANTIC_ROLES = new Set([
  'main', 'navigation', 'banner', 'contentinfo', 'complementary', 'form',
  'region', 'search', 'article', 'dialog', 'alertdialog', 'application',
  'document', 'feed', 'figure', 'group', 'img', 'list', 'listitem',
  'math', 'note', 'table', 'rowgroup', 'row', 'cell', 'columnheader',
  'rowheader', 'toolbar', 'tree', 'treegrid', 'grid', 'menu', 'menubar',
  'tablist', 'tabpanel', 'directory', 'log', 'marquee', 'status',
  'timer', 'alert', 'progressbar', 'separator', 'heading', 'WebArea',
]);

/**
 * Check if a node is an empty leaf node with no semantic meaning.
 * Only skips truly empty text/generic-like nodes — never landmarks or semantic roles.
 */
function isEmptyLeafNode(node: AccessibilityNode): boolean {
  if (SEMANTIC_ROLES.has(node.role)) return false;
  if (isInteractiveRole(node.role)) return false;
  return (!node.name || node.name.trim() === '') && (!node.children || node.children.length === 0);
}

/**
 * Converts an accessibility tree into compact YAML-style text.
 *
 * Format for each node:
 *   - role "name" [ref=e1, key=value, ...]
 *
 * Interactive elements get ref=eN identifiers.
 * Nodes with role 'none'/'presentation' are skipped (children hoisted).
 * Empty generic containers without nearby interactive children are pruned.
 */
export function serializeAccessibilityTree(
  root: AccessibilityNode,
  options?: SerializeOptions,
): string {
  const maxDepth = options?.maxDepth ?? 10;
  const maxNodes = options?.maxNodes ?? 500;

  let nodeCount = 0;
  let refCounter = 0;
  let truncated = false;
  const lines: string[] = [];

  function emitNode(node: AccessibilityNode, depth: number): void {
    if (truncated) return;

    // Skip empty leaf nodes (empty text, generic, etc. with no semantic meaning)
    if (isEmptyLeafNode(node)) return;

    // Skip 'none' and 'presentation' roles — hoist children
    if (SKIP_ROLES.has(node.role)) {
      emitChildren(node, depth);
      return;
    }

    // Skip empty generic containers without interactive descendants within 2 levels
    if (
      node.role === 'generic' &&
      (!node.name || node.name.trim() === '') &&
      !hasInteractiveDescendant(node, 2)
    ) {
      emitChildren(node, depth);
      return;
    }

    // Check maxNodes
    nodeCount++;
    if (nodeCount > maxNodes) {
      truncated = true;
      lines.push(`${indent(depth)}[... truncated]`);
      return;
    }

    // Assign ref for interactive elements
    let ref: string | null = null;
    if (isInteractiveRole(node.role)) {
      refCounter++;
      ref = `e${refCounter}`;
    }

    // Attributes inside brackets
    const attrs: string[] = [];
    if (ref) attrs.push(`ref=${ref}`);
    if (node.value !== undefined) attrs.push(`value="${node.value}"`);
    if (node.checked) attrs.push('checked');
    if (node.disabled) attrs.push('disabled');
    if (node.expanded) attrs.push('expanded');
    if (node.focused) attrs.push('focused');
    if (node.required) attrs.push('required');
    if (node.selected) attrs.push('selected');
    if (node.readonly) attrs.push('readonly');
    if (node.pressed === true) attrs.push('pressed');
    if (node.pressed === 'mixed') attrs.push('pressed=mixed');
    if (node.level !== undefined) attrs.push(`level=${node.level}`);
    if (node.url !== undefined) {
      const truncatedUrl = node.url.length > 80 ? node.url.slice(0, 80) + '...' : node.url;
      attrs.push(`url=${truncatedUrl}`);
    }

    // Build line: "- role "name" [attrs]"
    let line = `${indent(depth)}- ${node.role}`;
    if (node.name && node.name.trim() !== '') {
      line += ` "${node.name}"`;
    }
    if (attrs.length > 0) {
      line += ` [${attrs.join(', ')}]`;
    }

    lines.push(line);

    // Recurse into children (respect maxDepth)
    if (depth < maxDepth) {
      emitChildren(node, depth + 1);
    }
  }

  function emitChildren(node: AccessibilityNode, childDepth: number): void {
    if (!node.children) return;
    for (const child of node.children) {
      if (truncated) return;
      emitNode(child, childDepth);
    }
  }

  function indent(depth: number): string {
    return '  '.repeat(depth);
  }

  // Start from root's children if root is a document/WebArea,
  // or emit the root itself
  emitNode(root, 0);

  return lines.join('\n');
}
