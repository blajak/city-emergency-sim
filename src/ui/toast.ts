const VISIBLE_MS = 2600;

/** Short message at the bottom of the screen. */
export class Toast {
  private readonly el: HTMLElement;
  private timer: number | undefined;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'toast';
    this.el.setAttribute('role', 'status');
    container.appendChild(this.el);
  }

  show(message: string, tone: 'info' | 'error' = 'info'): void {
    this.el.textContent = message;
    this.el.dataset.tone = tone;
    this.el.classList.add('visible');
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.el.classList.remove('visible'), VISIBLE_MS);
  }
}
