/**
 * Toast notification system.
 * Fixed container at bottom of viewport, centered. Max 3 visible, auto-fade.
 */

export type ToastType = 'info' | 'warning' | 'error';

export interface ToastOptions {
  message: string;
  duration?: number;    // ms, default 4000
  type?: ToastType;     // default 'info'
  dismissable?: boolean; // default true
}

let instance: ToastManager | null = null;

export class ToastManager {
  private container: HTMLElement;
  private toasts: HTMLElement[] = [];
  private maxToasts = 3;

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  }

  show(options: ToastOptions): HTMLElement {
    const { message, duration = 4000, type = 'info', dismissable = true } = options;

    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;

    const text = document.createElement('span');
    text.className = 'toast__text';
    text.textContent = message;
    toast.appendChild(text);

    if (dismissable) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'toast__close';
      closeBtn.textContent = '\u00d7';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.addEventListener('click', () => this.remove(toast));
      toast.appendChild(closeBtn);
    }

    // Remove oldest if at max
    while (this.toasts.length >= this.maxToasts) {
      this.remove(this.toasts[0]);
    }

    this.toasts.push(toast);
    this.container.appendChild(toast);

    // Trigger entrance animation
    requestAnimationFrame(() => toast.classList.add('toast--visible'));

    // Auto-remove after duration
    if (duration > 0) {
      setTimeout(() => this.remove(toast), duration);
    }

    return toast;
  }

  remove(toast: HTMLElement): void {
    const idx = this.toasts.indexOf(toast);
    if (idx === -1) return;
    this.toasts.splice(idx, 1);
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback if transition doesn't fire
    setTimeout(() => toast.remove(), 400);
  }

  clear(): void {
    for (const toast of [...this.toasts]) {
      this.remove(toast);
    }
  }

  destroy(): void {
    this.clear();
    this.container.remove();
    if (instance === this) instance = null;
  }
}

/** Get or create the singleton ToastManager */
export function getToastManager(): ToastManager {
  if (!instance) {
    instance = new ToastManager();
  }
  return instance;
}

/** Convenience: show a toast immediately */
export function showToast(options: ToastOptions): HTMLElement {
  return getToastManager().show(options);
}
