import { describe, it, expect } from 'vitest';
import {
  generateBootstrapScript,
  generateIframeSrcdoc,
  injectBootstrap,
} from './iframe-template.js';

describe('iframe-template', () => {
  describe('generateBootstrapScript', () => {
    it('returns a script tag with bootstrap code', () => {
      const script = generateBootstrapScript('test-agent-1');
      expect(script).toContain('<script data-flo-bootstrap>');
      expect(script).toContain('</script>');
      expect(script).toContain('(function()');
      expect(script).toContain('test-agent-1');
    });

    it('properly JSON-escapes the agentId', () => {
      const script = generateBootstrapScript('agent-with-"quotes"');
      expect(script).toContain('agent-with-\\"quotes\\"');
    });

    it('includes worker management code', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain('var workers = {}');
      expect(script).toContain('setupWorkerHandler');
    });

    it('includes flo API', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain('window.flo');
      expect(script).toContain('flo.notify');
      expect(script).toContain('flo.ask');
    });

    it('includes postMessage ready notification', () => {
      const script = generateBootstrapScript('my-agent');
      expect(script).toContain("relayToShell({ type: 'ready' })");
    });

    it('includes activateScripts function for innerHTML script execution', () => {
      const script = generateBootstrapScript('test');
      // Verify the activateScripts helper exists
      expect(script).toContain('function activateScripts(container)');
      // Verify it clones script tags
      expect(script).toContain("document.createElement('script')");
      expect(script).toContain('replaceChild(newScript, oldScript)');
    });

    it('activateScripts handles container itself being a script element', () => {
      const script = generateBootstrapScript('test');
      // Verify the activateScripts function checks if container is a script tag
      expect(script).toContain("container.tagName === 'SCRIPT'");
      // Verify it clones the container script itself (not just children)
      expect(script).toContain('container.parentNode.replaceChild(newScript, container)');
    });

    it('calls activateScripts after innerHTML in dom modify', () => {
      const script = generateBootstrapScript('test');
      // Verify activateScripts is called after innerHTML assignment
      expect(script).toContain('el.innerHTML = command.innerHTML');
      expect(script).toContain('activateScripts(el)');
    });

    it('calls activateScripts after insertAdjacentHTML in dom create', () => {
      const script = generateBootstrapScript('test');
      // Verify activateScripts is called after create action
      expect(script).toContain('insertAdjacentHTML');
      expect(script).toContain('activateScripts(container)');
    });

    it('activateScripts skips the bootstrap script to prevent reinitializing workers', () => {
      const script = generateBootstrapScript('test');
      // Verify activateScripts checks for data-flo-bootstrap attribute
      expect(script).toContain("if (oldScript.hasAttribute('data-flo-bootstrap')) return");
      expect(script).toContain("if (container.hasAttribute('data-flo-bootstrap')) return");
    });

    it('has re-initialization guard for restored DOM state compatibility', () => {
      const script = generateBootstrapScript('test');
      // Verify the script checks for existing flo._initialized before running
      // This handles cases where old bootstrap scripts (without data-flo-bootstrap)
      // are re-executed from restored DOM state
      expect(script).toContain('if (window.flo && window.flo._initialized) return');
      expect(script).toContain('_initialized: true');
    });

    it('callTool supports options parameter with timeout', () => {
      const script = generateBootstrapScript('test');
      // Verify callTool accepts three parameters: name, input, options
      expect(script).toContain('callTool: function(name, input, options)');
      // Verify timeout extraction from options
      expect(script).toContain('(options && options.timeout) || 30000');
    });

    it('flo.notify includes viewState in postMessage to worker', () => {
      const script = generateBootstrapScript('test');
      // Verify notify sends viewState along with event and data
      expect(script).toContain("type: 'agent_notify'");
      expect(script).toContain('viewState: currentViewState');
    });

    it('flo.ask includes viewState in postMessage to worker', () => {
      const script = generateBootstrapScript('test');
      // Verify ask sends viewState along with id, event, and data
      expect(script).toContain("type: 'agent_ask'");
      // Both notify and ask include viewState — verify the ask message includes it
      // The ask postMessage block contains type, id, event, data, and viewState
      const askSection = script.slice(script.indexOf('ask: function(event, data, targetWorkerId)'));
      expect(askSection).toContain('viewState: currentViewState');
    });

    it('tracks currentViewState variable initialized to max', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain("var currentViewState = 'max'");
    });

    it('updates currentViewState on set_view_state message from shell', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain("case 'set_view_state':");
      expect(script).toContain('currentViewState = data.state');
    });

    it('removePlaceholder removes default head style to avoid selector conflicts', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain("document.querySelector('style[data-flo-default]')");
      expect(script).toContain('defaultStyle.remove()');
    });

    it('includes link interception click handler', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain("document.addEventListener('click', function(e)");
      expect(script).toContain("el.tagName !== 'A'");
      expect(script).toContain("e.preventDefault()");
      expect(script).toContain("javascript:");
    });

    it('includes window.open override that blocks javascript: URLs', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain('var _origOpen = window.open');
      expect(script).toContain("window.open = function(url, target, features)");
      expect(script).toContain("startsWith('javascript:')");
      expect(script).toContain('noopener');
    });

    it('link interception allows hash links for in-page navigation', () => {
      const script = generateBootstrapScript('test');
      // Verify hash links are allowed through
      expect(script).toContain("rawHref.charAt(0) === '#'");
    });

    it('link interception allows data: and blob: URLs', () => {
      const script = generateBootstrapScript('test');
      expect(script).toContain("trimmed.startsWith('data:')");
      expect(script).toContain("trimmed.startsWith('blob:')");
    });
  });

  describe('generateIframeSrcdoc', () => {
    it('generates valid HTML document', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'Test Agent');
      expect(srcdoc).toContain('<!DOCTYPE html>');
      expect(srcdoc).toContain('<html>');
      expect(srcdoc).toContain('</html>');
      expect(srcdoc).toContain('<head>');
      expect(srcdoc).toContain('</head>');
      expect(srcdoc).toContain('<body>');
      expect(srcdoc).toContain('</body>');
    });

    it('includes placeholder content in body', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'Test Agent');
      expect(srcdoc).toContain('class="agent-placeholder"');
      expect(srcdoc).toContain('Test Agent');
    });

    it('escapes agent name for HTML', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'Test <script>alert(1)</script>');
      expect(srcdoc).not.toContain('<script>alert(1)</script>');
      expect(srcdoc).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('includes bootstrap script', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'Test');
      expect(srcdoc).toContain('<script data-flo-bootstrap>');
      expect(srcdoc).toContain('agent-1');
      expect(srcdoc).toContain('window.flo');
    });

    it('includes placeholder content', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'My Agent');
      expect(srcdoc).toContain('My Agent');
      expect(srcdoc).toContain('Awaiting instructions');
    });

    it('marks default head style with data-flo-default attribute', () => {
      const srcdoc = generateIframeSrcdoc('agent-1', 'Test');
      expect(srcdoc).toContain('<style data-flo-default>');
    });
  });

  describe('injectBootstrap', () => {
    it('replaces FLO_BOOTSTRAP placeholder when present', () => {
      const html = `<!DOCTYPE html>
<html>
<body>
<div id="app">Custom Template</div>
<!-- FLO_BOOTSTRAP -->
</body>
</html>`;

      const result = injectBootstrap(html, 'agent-1');
      expect(result).not.toContain('<!-- FLO_BOOTSTRAP -->');
      expect(result).toContain('<script data-flo-bootstrap>');
      expect(result).toContain('agent-1');
      expect(result).toContain('window.flo');
    });

    it('injects before first <script> when placeholder is after scripts', () => {
      const html = `<!DOCTYPE html>
<html>
<body>
<div id="app">Custom Template</div>
<script>
var state = flo.state.get('items');
</script>
<!-- FLO_BOOTSTRAP -->
</body>
</html>`;

      const result = injectBootstrap(html, 'agent-1b');
      expect(result).toContain('<script data-flo-bootstrap>');
      expect(result).not.toContain('<!-- FLO_BOOTSTRAP -->');
      // Bootstrap should be before the template's script
      const bootstrapIndex = result.indexOf('<script data-flo-bootstrap>');
      const templateScriptIndex = result.indexOf('var state = flo.state');
      expect(bootstrapIndex).toBeLessThan(templateScriptIndex);
      // Only one bootstrap script
      const scriptCount = (result.match(/<script data-flo-bootstrap>/g) || []).length;
      expect(scriptCount).toBe(1);
    });

    it('injects before first <script> when no placeholder', () => {
      const html = `<!DOCTYPE html>
<html>
<body>
<div id="app">Custom Template</div>
<script>
var state = flo.state.get('items');
</script>
</body>
</html>`;

      const result = injectBootstrap(html, 'agent-2');
      expect(result).toContain('<script data-flo-bootstrap>');
      expect(result).toContain('agent-2');
      // Bootstrap should be before the template's script
      const bootstrapIndex = result.indexOf('<script data-flo-bootstrap>');
      const templateScriptIndex = result.indexOf('var state = flo.state');
      expect(bootstrapIndex).toBeLessThan(templateScriptIndex);
    });

    it('injects before </body> when no placeholder and no scripts', () => {
      const html = `<!DOCTYPE html>
<html>
<body>
<div id="app">Custom Template</div>
</body>
</html>`;

      const result = injectBootstrap(html, 'agent-2b');
      expect(result).toContain('<script data-flo-bootstrap>');
      expect(result).toContain('agent-2b');
      // Script should be before </body>
      const scriptIndex = result.indexOf('<script data-flo-bootstrap>');
      const bodyCloseIndex = result.indexOf('</body>');
      expect(scriptIndex).toBeLessThan(bodyCloseIndex);
    });

    it('appends to end if no </body> tag', () => {
      const html = '<div id="app">Partial HTML</div>';

      const result = injectBootstrap(html, 'agent-3');
      expect(result).toContain('agent-3');
      expect(result.startsWith('<div id="app">')).toBe(true);
      expect(result).toContain('<script data-flo-bootstrap>');
    });

    it('preserves existing content', () => {
      const html = `<!DOCTYPE html>
<html>
<head><title>Custom Template</title></head>
<body>
<div id="custom-content">Hello World</div>
<!-- FLO_BOOTSTRAP -->
</body>
</html>`;

      const result = injectBootstrap(html, 'agent-4');
      expect(result).toContain('<title>Custom Template</title>');
      expect(result).toContain('<div id="custom-content">Hello World</div>');
    });

    it('only replaces first placeholder occurrence', () => {
      const html = `<body>
<!-- FLO_BOOTSTRAP -->
<div>content</div>
<!-- FLO_BOOTSTRAP -->
</body>`;

      const result = injectBootstrap(html, 'agent-5');
      // Count bootstrap script tags
      const scriptCount = (result.match(/<script data-flo-bootstrap>/g) || []).length;
      expect(scriptCount).toBe(1);
    });

    it('works with complex template HTML', () => {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Custom Agent App</title>
  <style>
    body { font-family: sans-serif; }
    #agent-viewport { min-height: 100vh; }
  </style>
</head>
<body>
  <header>
    <h1>My Custom Agent</h1>
  </header>
  <main id="agent-viewport">
    <p>Loading...</p>
  </main>
  <footer>
    <p>Powered by flo.monster</p>
  </footer>
</body>
</html>`;

      const result = injectBootstrap(html, 'custom-agent');

      // Verify all original content preserved
      expect(result).toContain('<title>Custom Agent App</title>');
      expect(result).toContain('<h1>My Custom Agent</h1>');
      expect(result).toContain('<p>Loading...</p>');
      expect(result).toContain('<p>Powered by flo.monster</p>');

      // Verify bootstrap injected
      expect(result).toContain('custom-agent');
      expect(result).toContain('window.flo');

      // Verify script is before </body>
      const scriptIndex = result.indexOf('<script data-flo-bootstrap>');
      const bodyCloseIndex = result.indexOf('</body>');
      expect(scriptIndex).toBeLessThan(bodyCloseIndex);
    });
  });
});
