/**
 * Small status component showing save state per agent.
 * Shows "Saved" (green), "Saving..." (amber), or "Unsaved" (amber dot).
 */

export type SaveState = 'clean' | 'dirty' | 'saving';

export class SaveIndicator {
  private element: HTMLElement;
  private state: SaveState = 'clean';

  constructor() {
    this.element = document.createElement('span');
    this.element.className = 'save-indicator';
    this.render();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  getState(): SaveState {
    return this.state;
  }

  setState(state: SaveState): void {
    if (this.state === state) return;
    this.state = state;
    this.render();
  }

  private render(): void {
    this.element.textContent = '';
    this.element.className = 'save-indicator';

    switch (this.state) {
      case 'clean': {
        this.element.classList.add('save-indicator--clean');
        this.element.title = 'All changes saved';
        // Checkmark
        this.element.textContent = '\u2713';
        break;
      }
      case 'dirty': {
        this.element.classList.add('save-indicator--dirty');
        this.element.title = 'Unsaved changes';
        // Filled circle (dot)
        this.element.textContent = '\u25CF';
        break;
      }
      case 'saving': {
        this.element.classList.add('save-indicator--saving');
        this.element.title = 'Saving...';
        this.element.textContent = '\u23F3';
        break;
      }
    }
  }

  dispose(): void {
    this.element.remove();
  }
}
