/**
 * Tests for accessibility-tree serialization utilities.
 * Uses handcrafted AccessibilityNode trees — no Playwright imports needed.
 */

import { describe, it, expect } from 'vitest';
import {
  serializeAccessibilityTree,
  assignElementRefs,
  isInteractiveRole,
  type AccessibilityNode,
} from '../utils/accessibility-tree.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(
  role: string,
  name: string,
  extra?: Partial<AccessibilityNode>,
): AccessibilityNode {
  return { role, name, ...extra };
}

// ---------------------------------------------------------------------------
// 1. Basic serialization
// ---------------------------------------------------------------------------

describe('serializeAccessibilityTree', () => {
  describe('basic serialization', () => {
    it('serializes a simple tree with heading and text', () => {
      const root: AccessibilityNode = node('WebArea', 'Test Page', {
        children: [
          node('heading', 'Welcome', { level: 1 }),
          node('text', 'Hello world'),
        ],
      });

      const result = serializeAccessibilityTree(root);
      const lines = result.split('\n');
      expect(lines).toContain('- WebArea "Test Page"');
      expect(lines).toContain('  - heading "Welcome" [level=1]');
      expect(lines).toContain('  - text "Hello world"');
    });

    it('serializes nested tree with correct indentation', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('navigation', 'Main Nav', {
            children: [
              node('link', 'Home', { url: '/' }),
              node('link', 'Products', { url: '/products' }),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      const lines = result.split('\n');
      // WebArea has empty name so no quotes
      expect(lines[0]).toBe('- WebArea');
      expect(lines[1]).toBe('  - navigation "Main Nav"');
      expect(lines[2]).toMatch(/^\s{4}- link "Home" \[ref=e1, url=\/\]$/);
      expect(lines[3]).toMatch(/^\s{4}- link "Products" \[ref=e2, url=\/products\]$/);
    });

    it('produces example output from spec', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('heading', 'Welcome', { level: 1 }),
          node('navigation', '', {
            children: [
              node('link', 'Home', { url: '/' }),
              node('link', 'Products', { url: '/products' }),
            ],
          }),
          node('main', '', {
            children: [
              node('textbox', 'Search'),
              node('button', 'Go'),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // Root is WebArea with empty name — should still appear
      expect(result).toContain('- heading "Welcome" [level=1]');
      expect(result).toContain('- link "Home" [ref=');
      expect(result).toContain('- link "Products" [ref=');
      expect(result).toContain('- textbox "Search" [ref=');
      expect(result).toContain('- button "Go" [ref=');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Element refs
  // ---------------------------------------------------------------------------

  describe('element refs', () => {
    it('assigns refs to interactive elements only', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('heading', 'Title', { level: 2 }),
          node('button', 'Click me'),
          node('text', 'Some text'),
          node('link', 'A link', { url: '/foo' }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // heading and text should NOT have ref
      expect(result).toContain('- heading "Title" [level=2]');
      expect(result).not.toMatch(/heading "Title".*ref=/);
      expect(result).toContain('- text "Some text"');
      expect(result).not.toMatch(/text "Some text".*ref=/);
      // button and link should have ref
      expect(result).toContain('- button "Click me" [ref=e1]');
      expect(result).toContain('- link "A link" [ref=e2, url=/foo]');
    });

    it('assigns refs sequentially in tree order', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('textbox', 'First'),
          node('button', 'Second'),
          node('checkbox', 'Third'),
        ],
      });

      const result = serializeAccessibilityTree(root);
      expect(result).toContain('ref=e1');
      expect(result).toContain('ref=e2');
      expect(result).toContain('ref=e3');
      // Verify order
      const lines = result.split('\n');
      const refLines = lines.filter(l => l.includes('ref='));
      expect(refLines[0]).toContain('textbox "First"');
      expect(refLines[0]).toContain('ref=e1');
      expect(refLines[1]).toContain('button "Second"');
      expect(refLines[1]).toContain('ref=e2');
      expect(refLines[2]).toContain('checkbox "Third"');
      expect(refLines[2]).toContain('ref=e3');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Attributes
  // ---------------------------------------------------------------------------

  describe('attributes', () => {
    it('includes checked for checked checkbox', () => {
      const root: AccessibilityNode = node('checkbox', 'Accept terms', { checked: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('checked');
      expect(result).toContain('ref=e1');
    });

    it('includes disabled for disabled button', () => {
      const root: AccessibilityNode = node('button', 'Submit', { disabled: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('disabled');
    });

    it('includes expanded attribute', () => {
      const root: AccessibilityNode = node('combobox', 'Choose', { expanded: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('expanded');
    });

    it('includes focused attribute', () => {
      const root: AccessibilityNode = node('textbox', 'Email', { focused: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('focused');
    });

    it('includes required attribute', () => {
      const root: AccessibilityNode = node('textbox', 'Name', { required: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('required');
    });

    it('includes selected attribute', () => {
      const root: AccessibilityNode = node('option', 'Red', { selected: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('selected');
    });

    it('includes readonly attribute', () => {
      const root: AccessibilityNode = node('textbox', 'ID', { readonly: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('readonly');
    });

    it('includes pressed=true', () => {
      const root: AccessibilityNode = node('button', 'Bold', { pressed: true });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('pressed');
      expect(result).not.toContain('pressed=mixed');
    });

    it('includes pressed=mixed', () => {
      const root: AccessibilityNode = node('button', 'Toggle', { pressed: 'mixed' });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('pressed=mixed');
    });

    it('does not include pressed when false', () => {
      const root: AccessibilityNode = node('button', 'Normal', { pressed: false });
      const result = serializeAccessibilityTree(root);
      expect(result).not.toContain('pressed');
    });

    it('truncates long URLs to 80 chars', () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(100);
      expect(longUrl.length).toBeGreaterThan(80);
      const root: AccessibilityNode = node('link', 'Long Link', { url: longUrl });
      const result = serializeAccessibilityTree(root);
      // URL should be truncated
      expect(result).toContain('url=' + longUrl.slice(0, 80) + '...');
      expect(result).not.toContain(longUrl);
    });

    it('does not truncate short URLs', () => {
      const shortUrl = '/about';
      const root: AccessibilityNode = node('link', 'About', { url: shortUrl });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('url=/about');
      expect(result).not.toContain('...');
    });

    it('includes level for headings', () => {
      const root: AccessibilityNode = node('heading', 'Section', { level: 3 });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('level=3');
    });

    it('includes value attribute', () => {
      const root: AccessibilityNode = node('textbox', 'Search', { value: 'hello' });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('value="hello"');
    });

    it('combines multiple attributes correctly', () => {
      const root: AccessibilityNode = node('checkbox', 'Remember me', {
        checked: true,
        disabled: true,
      });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('ref=e1');
      expect(result).toContain('checked');
      expect(result).toContain('disabled');
      // All in one bracket group
      expect(result).toMatch(/\[ref=e1, checked, disabled\]/);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Pruning
  // ---------------------------------------------------------------------------

  describe('pruning', () => {
    it('skips nodes with role "none" and hoists children', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('none', '', {
            children: [
              node('button', 'Inside None'),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // The 'none' node should not appear
      expect(result).not.toContain('none');
      // But its child should appear at the hoisted depth
      expect(result).toContain('button "Inside None"');
    });

    it('skips nodes with role "presentation" and hoists children', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('presentation', '', {
            children: [
              node('link', 'Presented Link', { url: '/test' }),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      expect(result).not.toContain('presentation');
      expect(result).toContain('link "Presented Link"');
    });

    it('skips empty generic containers without interactive children', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('generic', '', {
            children: [
              node('text', 'Just text'),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // generic should be pruned, text hoisted
      expect(result).not.toContain('generic');
      expect(result).toContain('text "Just text"');
    });

    it('keeps generic containers WITH interactive children', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('generic', '', {
            children: [
              node('button', 'Click'),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // generic should be kept because it has an interactive child
      expect(result).toContain('generic');
      expect(result).toContain('button "Click"');
    });

    it('keeps generic containers with interactive descendants within 2 levels', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('generic', '', {
            children: [
              node('generic', '', {
                children: [
                  node('button', 'Deep Button'),
                ],
              }),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // Outer generic has interactive descendant within 2 levels
      expect(result).toContain('button "Deep Button"');
      // The outer generic should be kept (interactive child within 2 levels)
      const lines = result.split('\n');
      const genericLines = lines.filter(l => l.includes('generic'));
      expect(genericLines.length).toBeGreaterThan(0);
    });

    it('prunes generic containers when interactive descendants are too deep', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('generic', '', {
            children: [
              node('generic', '', {
                children: [
                  node('generic', '', {
                    children: [
                      node('button', 'Very Deep Button'),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // The outermost generic has interactive descendant at depth 3 — beyond 2 levels
      // So it gets pruned, and its children are hoisted
      // But the middle generic also checks: it has interactive at depth 2 — kept
      expect(result).toContain('button "Very Deep Button"');
    });

    it('skips empty text nodes', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('text', ''),
          node('text', '   '),
          node('heading', 'Real Content', { level: 1 }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      const lines = result.split('\n').filter(l => l.trim());
      // Only WebArea and heading should appear
      expect(lines.length).toBe(2);
      expect(result).toContain('heading "Real Content"');
    });

    it('keeps named generic containers', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('generic', 'Important Section', {
            children: [
              node('text', 'Some text'),
            ],
          }),
        ],
      });

      const result = serializeAccessibilityTree(root);
      // Generic with a name should be kept
      expect(result).toContain('generic "Important Section"');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Limits
  // ---------------------------------------------------------------------------

  describe('limits', () => {
    it('stops recursion at maxDepth', () => {
      // Build a deeply nested tree
      let current: AccessibilityNode = node('button', 'Deep Button');
      for (let i = 0; i < 20; i++) {
        current = node('group', `Level ${i}`, { children: [current] });
      }
      const root = node('WebArea', '', { children: [current] });

      const result = serializeAccessibilityTree(root, { maxDepth: 5 });
      // Count indent levels — max should be limited
      const lines = result.split('\n');
      for (const line of lines) {
        const indentLevel = (line.match(/^( *)/) || [''])[0].length / 2;
        // maxDepth=5 means depth 0..5, so indent levels 0..5
        expect(indentLevel).toBeLessThanOrEqual(5);
      }
      // The deep button should NOT appear (it's at depth 21)
      expect(result).not.toContain('Deep Button');
    });

    it('truncates after maxNodes', () => {
      const children: AccessibilityNode[] = [];
      for (let i = 0; i < 20; i++) {
        children.push(node('text', `Item ${i}`));
      }
      const root: AccessibilityNode = node('WebArea', '', { children });

      // maxNodes=5 — root + 4 children = 5, then truncated
      const result = serializeAccessibilityTree(root, { maxNodes: 5 });
      expect(result).toContain('[... truncated]');
      // Should have exactly 5 node lines + 1 truncation line
      const lines = result.split('\n').filter(l => l.trim());
      const nodeLines = lines.filter(l => l.includes('- '));
      expect(nodeLines.length).toBe(5);
    });

    it('does not truncate when under maxNodes', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('heading', 'Title'),
          node('button', 'OK'),
        ],
      });

      const result = serializeAccessibilityTree(root, { maxNodes: 100 });
      expect(result).not.toContain('truncated');
    });
  });

  // ---------------------------------------------------------------------------
  // 6. assignElementRefs
  // ---------------------------------------------------------------------------

  describe('assignElementRefs', () => {
    it('returns correct map of refs to interactive nodes', () => {
      const btn = node('button', 'Click');
      const lnk = node('link', 'Home', { url: '/' });
      const txt = node('text', 'Hello');
      const root: AccessibilityNode = node('WebArea', '', {
        children: [txt, btn, lnk],
      });

      const refs = assignElementRefs(root);
      expect(refs.size).toBe(2);
      expect(refs.get('e1')).toBe(btn);
      expect(refs.get('e2')).toBe(lnk);
    });

    it('only includes interactive elements', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('heading', 'Title', { level: 1 }),
          node('text', 'paragraph'),
          node('generic', '', { children: [node('text', 'inner')] }),
          node('navigation', '', { children: [] }),
        ],
      });

      const refs = assignElementRefs(root);
      expect(refs.size).toBe(0);
    });

    it('numbers sequentially in tree order', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('navigation', '', {
            children: [
              node('link', 'First', { url: '/1' }),
              node('link', 'Second', { url: '/2' }),
            ],
          }),
          node('main', '', {
            children: [
              node('textbox', 'Search'),
              node('button', 'Go'),
            ],
          }),
        ],
      });

      const refs = assignElementRefs(root);
      expect(refs.size).toBe(4);
      expect(refs.get('e1')!.name).toBe('First');
      expect(refs.get('e2')!.name).toBe('Second');
      expect(refs.get('e3')!.name).toBe('Search');
      expect(refs.get('e4')!.name).toBe('Go');
    });

    it('handles deeply nested interactive elements', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('group', '', {
            children: [
              node('group', '', {
                children: [
                  node('checkbox', 'Deep Check'),
                ],
              }),
            ],
          }),
        ],
      });

      const refs = assignElementRefs(root);
      expect(refs.size).toBe(1);
      expect(refs.get('e1')!.name).toBe('Deep Check');
    });
  });

  // ---------------------------------------------------------------------------
  // 7. isInteractiveRole
  // ---------------------------------------------------------------------------

  describe('isInteractiveRole', () => {
    it('returns true for all interactive roles', () => {
      const interactive = [
        'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox',
        'menuitem', 'tab', 'switch', 'slider', 'spinbutton', 'searchbox',
        'option', 'treeitem', 'menuitemcheckbox', 'menuitemradio',
      ];
      for (const role of interactive) {
        expect(isInteractiveRole(role)).toBe(true);
      }
    });

    it('returns false for non-interactive roles', () => {
      const nonInteractive = [
        'heading', 'text', 'generic', 'navigation', 'main', 'group',
        'none', 'presentation', 'WebArea', 'img', 'list', 'listitem',
      ];
      for (const role of nonInteractive) {
        expect(isInteractiveRole(role)).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles empty tree (no children)', () => {
      const root: AccessibilityNode = node('WebArea', 'Empty');
      const result = serializeAccessibilityTree(root);
      expect(result).toBe('- WebArea "Empty"');
    });

    it('handles node with no name (omits quotes)', () => {
      const root: AccessibilityNode = node('main', '');
      const result = serializeAccessibilityTree(root);
      expect(result).toBe('- main');
      expect(result).not.toContain('"');
    });

    it('handles node with value attribute', () => {
      const root: AccessibilityNode = node('slider', 'Volume', {
        value: '50',
        valuemin: 0,
        valuemax: 100,
      });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('value="50"');
      expect(result).toContain('ref=e1');
    });

    it('handles very deep nesting with maxDepth', () => {
      // 15 levels deep
      let current: AccessibilityNode = node('text', 'Bottom');
      for (let i = 14; i >= 0; i--) {
        current = node('group', `G${i}`, { children: [current] });
      }

      const result = serializeAccessibilityTree(current, { maxDepth: 3 });
      // Should stop at depth 3 — G0, G1, G2, G3 visible; deeper pruned
      expect(result).toContain('G0');
      expect(result).toContain('G1');
      expect(result).toContain('G2');
      expect(result).toContain('G3');
      expect(result).not.toContain('G4');
      expect(result).not.toContain('Bottom');
    });

    it('handles tree with only interactive elements', () => {
      const root: AccessibilityNode = node('group', '', {
        children: [
          node('button', 'A'),
          node('button', 'B'),
          node('button', 'C'),
        ],
      });

      const result = serializeAccessibilityTree(root);
      expect(result).toContain('ref=e1');
      expect(result).toContain('ref=e2');
      expect(result).toContain('ref=e3');
    });

    it('handles assignElementRefs on empty tree', () => {
      const root: AccessibilityNode = node('WebArea', 'Empty');
      const refs = assignElementRefs(root);
      expect(refs.size).toBe(0);
    });

    it('default options are applied', () => {
      // Just ensure no crash with no options
      const root: AccessibilityNode = node('WebArea', '', {
        children: [node('button', 'OK')],
      });
      const result = serializeAccessibilityTree(root);
      expect(result).toContain('button "OK"');
    });

    it('refs in serialize match refs from assignElementRefs', () => {
      const root: AccessibilityNode = node('WebArea', '', {
        children: [
          node('link', 'First', { url: '/1' }),
          node('heading', 'Title'),
          node('button', 'Submit'),
          node('textbox', 'Input'),
        ],
      });

      const refMap = assignElementRefs(root);
      const serialized = serializeAccessibilityTree(root);

      // Both should assign e1 to link, e2 to button, e3 to textbox
      expect(refMap.get('e1')!.name).toBe('First');
      expect(refMap.get('e2')!.name).toBe('Submit');
      expect(refMap.get('e3')!.name).toBe('Input');

      expect(serialized).toContain('link "First" [ref=e1');
      expect(serialized).toContain('button "Submit" [ref=e2');
      expect(serialized).toContain('textbox "Input" [ref=e3');
    });
  });
});
