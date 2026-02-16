import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSkinId, getSkinBaseUrl, loadOuterSkin } from './loader.js';

describe('OuterSkinLoader', () => {
  describe('getSkinId', () => {
    const originalLocation = window.location;

    beforeEach(() => {
      // Mock window.location
      delete (window as any).location;
    });

    afterEach(() => {
      (window as any).location = originalLocation;
    });

    it('returns skin from URL param override', () => {
      (window as any).location = {
        hostname: 'localhost',
        search: '?skin=custom-skin',
      };
      expect(getSkinId()).toBe('custom-skin');
    });

    it('maps flo.monster to flo-monster skin', () => {
      (window as any).location = {
        hostname: 'flo.monster',
        search: '',
      };
      expect(getSkinId()).toBe('flo-monster');
    });

    it('maps www.flo.monster to flo-monster skin', () => {
      (window as any).location = {
        hostname: 'www.flo.monster',
        search: '',
      };
      expect(getSkinId()).toBe('flo-monster');
    });

    it('maps t.flo.monster to flo-monster skin', () => {
      (window as any).location = {
        hostname: 't.flo.monster',
        search: '',
      };
      expect(getSkinId()).toBe('flo-monster');
    });

    it('returns default skin for localhost', () => {
      (window as any).location = {
        hostname: 'localhost',
        search: '',
      };
      expect(getSkinId()).toBe('installer');
    });

    it('returns default skin for unknown domains', () => {
      (window as any).location = {
        hostname: 'some-other-domain.com',
        search: '',
      };
      expect(getSkinId()).toBe('installer');
    });

    it('rejects skin IDs with path traversal', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (window as any).location = {
        hostname: 'localhost',
        search: '?skin=../../etc/passwd',
      };
      expect(getSkinId()).toBe('installer');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid skin ID'));
      warnSpy.mockRestore();
    });

    it('rejects skin IDs with slashes', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (window as any).location = {
        hostname: 'localhost',
        search: '?skin=path/to/skin',
      };
      expect(getSkinId()).toBe('installer');
      warnSpy.mockRestore();
    });

    it('rejects skin IDs with special characters', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (window as any).location = {
        hostname: 'localhost',
        search: '?skin=<script>alert(1)</script>',
      };
      expect(getSkinId()).toBe('installer');
      warnSpy.mockRestore();
    });

    it('allows valid skin IDs with hyphens and underscores', () => {
      (window as any).location = {
        hostname: 'localhost',
        search: '?skin=my-custom_skin123',
      };
      expect(getSkinId()).toBe('my-custom_skin123');
    });
  });

  describe('getSkinBaseUrl', () => {
    it('returns correct base URL for skin', () => {
      expect(getSkinBaseUrl('flo-monster')).toBe('/skins/flo-monster');
      expect(getSkinBaseUrl('custom-skin')).toBe('/skins/custom-skin');
    });
  });

  describe('loadOuterSkin', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('loads manifest, content, and styles', async () => {
      const mockManifest = {
        id: 'test-skin',
        name: 'Test Skin',
        version: '1.0.0',
        contentUrl: 'content.html',
        stylesUrl: 'styles.css',
      };

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockManifest) })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<div>Content</div>') })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('.test { color: red; }') });

      vi.stubGlobal('fetch', mockFetch);

      const result = await loadOuterSkin('test-skin');

      expect(result.manifest).toEqual(mockManifest);
      expect(result.content).toBe('<div>Content</div>');
      expect(result.styles).toBe('.test { color: red; }');
      expect(result.script).toBeUndefined();
    });

    it('loads optional script when defined', async () => {
      const mockManifest = {
        id: 'test-skin',
        name: 'Test Skin',
        version: '1.0.0',
        contentUrl: 'content.html',
        stylesUrl: 'styles.css',
        scriptUrl: 'script.js',
      };

      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(mockManifest) })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<div>Content</div>') })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('.test {}') })
        .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('console.log("hi");') });

      vi.stubGlobal('fetch', mockFetch);

      const result = await loadOuterSkin('test-skin');

      expect(result.script).toBe('console.log("hi");');
    });

    it('throws on manifest load failure', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 404 });

      vi.stubGlobal('fetch', mockFetch);

      await expect(loadOuterSkin('nonexistent')).rejects.toThrow('Failed to load skin manifest: 404');
    });
  });
});
