import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MOBILE_BREAKPOINT, isMobileViewport, onViewportChange } from './mobile-utils.js';

describe('mobile-utils', () => {
  describe('MOBILE_BREAKPOINT', () => {
    it('should be 768', () => {
      expect(MOBILE_BREAKPOINT).toBe(768);
    });
  });

  describe('isMobileViewport', () => {
    it('should return boolean', () => {
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
      const result = isMobileViewport();
      expect(typeof result).toBe('boolean');
      vi.unstubAllGlobals();
    });

    it('should use matchMedia with correct query', () => {
      const mockMatchMedia = vi.fn().mockReturnValue({ matches: true });
      vi.stubGlobal('matchMedia', mockMatchMedia);

      isMobileViewport();

      expect(mockMatchMedia).toHaveBeenCalledWith('(max-width: 767px)');

      vi.unstubAllGlobals();
    });

    it('should return true when matchMedia matches', () => {
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));

      expect(isMobileViewport()).toBe(true);

      vi.unstubAllGlobals();
    });

    it('should return false when matchMedia does not match', () => {
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));

      expect(isMobileViewport()).toBe(false);

      vi.unstubAllGlobals();
    });
  });

  describe('onViewportChange', () => {
    let mockMediaQuery: {
      matches: boolean;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockMediaQuery = {
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mockMediaQuery));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should return a cleanup function', () => {
      const cleanup = onViewportChange(() => {});
      expect(typeof cleanup).toBe('function');
    });

    it('should register change listener', () => {
      onViewportChange(() => {});

      expect(mockMediaQuery.addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });

    it('should call callback when media query changes', () => {
      const callback = vi.fn();
      onViewportChange(callback);

      // Get the handler that was registered
      const handler = mockMediaQuery.addEventListener.mock.calls[0][1];

      // Simulate change event
      handler({ matches: true });
      expect(callback).toHaveBeenCalledWith(true);

      handler({ matches: false });
      expect(callback).toHaveBeenCalledWith(false);
    });

    it('should remove listener on cleanup', () => {
      const cleanup = onViewportChange(() => {});

      cleanup();

      expect(mockMediaQuery.removeEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });

    it('should use correct media query', () => {
      onViewportChange(() => {});

      expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
    });
  });
});
