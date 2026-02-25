export interface ZoomTransform {
  scale: number;
  panX: number;
  panY: number;
}

export class PinchZoomHandler {
  private container: HTMLElement;
  private target: HTMLElement;
  private _scale = 1;
  private _panX = 0;
  private _panY = 0;
  private minScale = 1;
  private maxScale = 5;

  // Pinch tracking
  private isPinching = false;
  private initialDistance = 0;
  private initialScale = 1;
  private initialMidX = 0; // relative to container
  private initialMidY = 0;
  private initialPanX = 0;
  private initialPanY = 0;

  private onChange?: (transform: ZoomTransform) => void;
  private handlers: { event: string; handler: EventListener }[] = [];

  constructor(container: HTMLElement, target: HTMLElement, onChange?: (transform: ZoomTransform) => void) {
    this.container = container;
    this.target = target;
    this.onChange = onChange;
    this.attachListeners();
  }

  private attachListeners(): void {
    // All listeners use CAPTURE phase so they intercept before InputOverlay or button handlers
    const add = (event: string, handler: EventListener, options?: AddEventListenerOptions) => {
      this.handlers.push({ event, handler });
      this.container.addEventListener(event, handler, { ...options, capture: true });
    };

    add('touchstart', this.onTouchStart as EventListener, { passive: false });
    add('touchmove', this.onTouchMove as EventListener, { passive: false });
    add('touchend', this.onTouchEnd as EventListener, { passive: false });
    add('touchcancel', this.onTouchEnd as EventListener, { passive: false });

    // iOS Safari: prevent native gesture zoom handling
    add('gesturestart', (e: Event) => e.preventDefault(), { passive: false });
    add('gesturechange', (e: Event) => e.preventDefault(), { passive: false });
    add('gestureend', (e: Event) => e.preventDefault(), { passive: false });
  }

  private onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length >= 2) {
      e.preventDefault();
      e.stopPropagation();
      this.startPinch(e);
    }
    // Single touch: don't interfere — let buttons, InputOverlay handle it
  };

  private onTouchMove = (e: TouchEvent): void => {
    if (!this.isPinching) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.touches.length >= 2) {
      this.updatePinch(e);
    }
  };

  private onTouchEnd = (e: TouchEvent): void => {
    if (!this.isPinching) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.touches.length < 2) {
      this.endPinch();
    }
  };

  private startPinch(e: TouchEvent): void {
    this.isPinching = true;
    const [t1, t2] = [e.touches[0], e.touches[1]];
    const rect = this.container.getBoundingClientRect();

    this.initialDistance = this.getDistance(t1, t2);
    this.initialScale = this._scale;
    this.initialMidX = (t1.clientX + t2.clientX) / 2 - rect.left;
    this.initialMidY = (t1.clientY + t2.clientY) / 2 - rect.top;
    this.initialPanX = this._panX;
    this.initialPanY = this._panY;
  }

  private updatePinch(e: TouchEvent): void {
    const [t1, t2] = [e.touches[0], e.touches[1]];
    const rect = this.container.getBoundingClientRect();

    const distance = this.getDistance(t1, t2);
    const midX = (t1.clientX + t2.clientX) / 2 - rect.left;
    const midY = (t1.clientY + t2.clientY) / 2 - rect.top;

    // New scale
    const scaleRatio = distance / this.initialDistance;
    this._scale = Math.min(this.maxScale, Math.max(this.minScale, this.initialScale * scaleRatio));

    // Pan: keep the content point under the initial pinch midpoint stable
    // contentMid = (initialMid - initialPan) / initialScale
    // newPan = currentMid - contentMid * newScale
    const contentMidX = (this.initialMidX - this.initialPanX) / this.initialScale;
    const contentMidY = (this.initialMidY - this.initialPanY) / this.initialScale;
    this._panX = midX - contentMidX * this._scale;
    this._panY = midY - contentMidY * this._scale;

    this.clampPan();
    this.applyTransform();
  }

  private endPinch(): void {
    this.isPinching = false;
    // Snap to 1x if close
    if (this._scale < 1.05) {
      this._scale = 1;
      this._panX = 0;
      this._panY = 0;
      this.applyTransform();
    }
  }

  private clampPan(): void {
    const rect = this.container.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    // Clamp so scaled content fills the container (no empty space):
    // panX <= 0 (content left edge at or left of container)
    // panX + w * scale >= w (content right edge at or right of container)
    // => panX >= w * (1 - scale)
    this._panX = Math.min(0, Math.max(w * (1 - this._scale), this._panX));
    this._panY = Math.min(0, Math.max(h * (1 - this._scale), this._panY));
  }

  private applyTransform(): void {
    this.target.style.transformOrigin = '0 0';
    this.target.style.transform = this._scale === 1
      ? ''
      : `translate(${this._panX}px, ${this._panY}px) scale(${this._scale})`;
    this.onChange?.({ scale: this._scale, panX: this._panX, panY: this._panY });
  }

  private getDistance(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTransform(): ZoomTransform {
    return { scale: this._scale, panX: this._panX, panY: this._panY };
  }

  resetZoom(): void {
    this._scale = 1;
    this._panX = 0;
    this._panY = 0;
    this.applyTransform();
  }

  destroy(): void {
    for (const { event, handler } of this.handlers) {
      this.container.removeEventListener(event, handler, { capture: true });
    }
    this.handlers = [];
    this.target.style.transform = '';
    this.target.style.transformOrigin = '';
  }
}
