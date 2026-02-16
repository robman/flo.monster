/**
 * Persistent offline banner at the very top of the shell.
 * Shows when navigator.onLine is false. White text on red (#BD0F40).
 */

export class OfflineBanner {
  private element: HTMLElement;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'offline-banner';
    this.element.textContent = "You're offline";
    this.element.style.display = 'none';

    // Insert as first child of parent (above everything)
    if (parent.firstChild) {
      parent.insertBefore(this.element, parent.firstChild);
    } else {
      parent.appendChild(this.element);
    }

    // Set initial state
    this.update();

    // Listen for connectivity changes
    window.addEventListener('online', () => this.update());
    window.addEventListener('offline', () => this.update());
  }

  private update(): void {
    const offline = !navigator.onLine;
    this.element.style.display = offline ? 'flex' : 'none';
    document.body.classList.toggle('has-offline-banner', offline);
  }

  getElement(): HTMLElement {
    return this.element;
  }

  destroy(): void {
    window.removeEventListener('online', () => this.update());
    window.removeEventListener('offline', () => this.update());
    document.body.classList.remove('has-offline-banner');
    this.element.remove();
  }
}
