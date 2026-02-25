/**
 * Page accessibility utilities — shared functions for obtaining accessibility
 * trees and page metadata from Playwright pages via CDP.
 *
 * Extracted from browse.ts so that both the browse tool and other consumers
 * (e.g. intervene/input) can reuse the same CDP-based accessibility logic.
 */

import type { Page } from 'playwright-core';
import {
  serializeAccessibilityTree,
  assignElementRefs,
  type AccessibilityNode,
} from './accessibility-tree.js';

// ---------------------------------------------------------------------------
// CDP types
// ---------------------------------------------------------------------------

/** CDP AX node as returned by Accessibility.getFullAXTree */
export interface CdpAXNode {
  nodeId: string;
  role?: { type: string; value: string };
  name?: { type: string; value: string };
  value?: { type: string; value: string };
  description?: { type: string; value: string };
  properties?: Array<{ name: string; value: { type: string; value: unknown } }>;
  childIds?: string[];
}

// ---------------------------------------------------------------------------
// Tree conversion
// ---------------------------------------------------------------------------

/**
 * Convert a flat list of CDP AX nodes into a tree of AccessibilityNode.
 */
export function cdpToAccessibilityTree(nodes: CdpAXNode[]): AccessibilityNode | null {
  if (nodes.length === 0) return null;

  const nodeMap = new Map<string, CdpAXNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  function convert(cdp: CdpAXNode): AccessibilityNode {
    const node: AccessibilityNode = {
      role: cdp.role?.value ?? 'none',
      name: cdp.name?.value ?? '',
    };

    if (cdp.value?.value) node.value = cdp.value.value;
    if (cdp.description?.value) node.description = cdp.description.value;

    // Map CDP properties to AccessibilityNode fields
    if (cdp.properties) {
      for (const prop of cdp.properties) {
        switch (prop.name) {
          case 'checked':  node.checked = prop.value.value === 'true' || prop.value.value === true; break;
          case 'disabled': node.disabled = prop.value.value === 'true' || prop.value.value === true; break;
          case 'expanded': node.expanded = prop.value.value === 'true' || prop.value.value === true; break;
          case 'focused':  node.focused = prop.value.value === 'true' || prop.value.value === true; break;
          case 'required': node.required = prop.value.value === 'true' || prop.value.value === true; break;
          case 'selected': node.selected = prop.value.value === 'true' || prop.value.value === true; break;
          case 'readonly': node.readonly = prop.value.value === 'true' || prop.value.value === true; break;
          case 'level':    node.level = Number(prop.value.value); break;
          case 'url':      node.url = String(prop.value.value); break;
        }
      }
    }

    if (cdp.childIds && cdp.childIds.length > 0) {
      node.children = [];
      for (const childId of cdp.childIds) {
        const childCdp = nodeMap.get(childId);
        if (childCdp) {
          node.children.push(convert(childCdp));
        }
      }
    }

    return node;
  }

  return convert(nodes[0]);
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

/**
 * Take a fresh accessibility snapshot via CDP, update the provided elementRefs
 * map, and return the serialized tree string.
 *
 * Uses CDP Accessibility.getFullAXTree because Playwright 1.58 removed
 * the deprecated page.accessibility API.
 */
export async function getAccessibilityTree(
  page: Page,
  elementRefs: Map<string, AccessibilityNode>,
): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const response = await cdp.send('Accessibility.getFullAXTree' as any);
    const nodes = (response as any).nodes as CdpAXNode[] | undefined;
    if (!nodes || nodes.length === 0) return '[empty page]';

    const snapshot = cdpToAccessibilityTree(nodes);
    if (!snapshot) return '[empty page]';

    // Update element refs (positional — regenerated each snapshot)
    const newRefs = assignElementRefs(snapshot);
    elementRefs.clear();
    for (const [key, node] of newRefs) {
      elementRefs.set(key, node);
    }

    return serializeAccessibilityTree(snapshot);
  } finally {
    await cdp.detach();
  }
}

/** Return a short metadata header: URL + title */
export async function getPageMetadata(page: Page): Promise<string> {
  const title = await page.title();
  const url = page.url();
  return `URL: ${url}\nTitle: ${title}`;
}
