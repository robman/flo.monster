/**
 * Shell-side canvas component that renders headless browser viewport frames.
 *
 * Receives binary frames (9-byte header + JPEG data), decodes them,
 * and renders to a <canvas> element. The canvas lives in the shell
 * (not the agent iframe) so there's no postMessage latency.
 */

import { decodeFrameHeader, FRAME_HEADER_SIZE } from '@flo-monster/core/utils/viewport-frame';

export class ViewportCanvas {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private resizeObserver: ResizeObserver | null = null;
  private lastFrameNum = 0;
  private lastBitmap: ImageBitmap | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewport-canvas';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.objectFit = 'contain';
    this.canvas.style.background = '#000';

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.ctx = ctx;

    container.appendChild(this.canvas);

    // Set initial canvas dimensions immediately (before ResizeObserver fires)
    this.resize();

    // Auto-resize canvas to match container (re-draws last frame after resize)
    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
      this.redrawLastFrame();
    });
    this.resizeObserver.observe(container);
  }

  /**
   * Handle an incoming binary viewport frame.
   * Decodes the header, extracts JPEG data, renders to canvas.
   */
  handleFrame(data: ArrayBuffer): void {
    try {
      const header = decodeFrameHeader(data);

      // Drop out-of-order frames
      if (header.frameNum <= this.lastFrameNum) return;
      this.lastFrameNum = header.frameNum;

      // Extract JPEG data
      const jpegData = new Uint8Array(data, header.dataOffset);

      // Create blob and render via createImageBitmap (non-blocking decode)
      const blob = new Blob([jpegData], { type: 'image/jpeg' });

      createImageBitmap(blob).then((bitmap) => {
        // Store last bitmap for redraw on resize
        if (this.lastBitmap) this.lastBitmap.close();
        this.lastBitmap = bitmap;

        this.drawBitmap(bitmap);
      }).catch(() => {
        // Failed to decode — skip frame
      });
    } catch {
      // Malformed frame — ignore
    }
  }

  /**
   * Draw a bitmap to the canvas, scaled to fit with aspect ratio preserved.
   */
  private drawBitmap(bitmap: ImageBitmap): void {
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    if (canvasWidth === 0 || canvasHeight === 0) return;

    const scale = Math.min(
      canvasWidth / bitmap.width,
      canvasHeight / bitmap.height,
    );

    const drawWidth = bitmap.width * scale;
    const drawHeight = bitmap.height * scale;
    const offsetX = (canvasWidth - drawWidth) / 2;
    const offsetY = (canvasHeight - drawHeight) / 2;

    // Clear and draw
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    this.ctx.drawImage(bitmap, offsetX, offsetY, drawWidth, drawHeight);
  }

  /**
   * Redraw the last received frame (after canvas resize clears it).
   */
  private redrawLastFrame(): void {
    if (this.lastBitmap) {
      this.drawBitmap(this.lastBitmap);
    }
  }

  /**
   * Resize the canvas to match its container.
   * Note: setting canvas.width/height clears the canvas content.
   */
  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (rect) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
    }
  }

  /**
   * Get the underlying canvas element (for applying CSS transforms like pinch-zoom).
   */
  getElement(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Clean up the canvas and resize observer.
   */
  destroy(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.lastBitmap) {
      this.lastBitmap.close();
      this.lastBitmap = null;
    }
    this.canvas.remove();
  }
}
