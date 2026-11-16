import type { Simulation } from '../sim/Simulation';
import { type Subject, describeSubject, subjectAlive } from './vehicleInfo';
import { placeCard } from './cardPlacement';

const REFRESH_INTERVAL_MS = 250;

export interface VehicleCardCallbacks {
  /** Start (true) or stop (false) following the subject with the camera. */
  onFollow(subject: Subject | null): void;
}

/** Floating card for any vehicle or train: who it is, where it is going, and a follow button. */
export class VehicleCard {
  private readonly el: HTMLElement;
  private subject: Subject | null = null;
  private following = false;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly callbacks: VehicleCardCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'station-card vehicle-card';
    this.el.hidden = true;
    container.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (button?.dataset.action === 'close') this.close();
      if (button?.dataset.action === 'follow') this.setFollowing(!this.following);
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  get current(): Subject | null {
    return this.subject;
  }

  open(subject: Subject, screen: { x: number; y: number }): void {
    if (this.subject) this.close();
    this.subject = subject;
    this.el.hidden = false;
    this.render(true);
    placeCard(this.el, screen);
  }

  close(): void {
    if (!this.subject) return;
    this.setFollowing(false);
    this.el.hidden = true;
    this.subject = null;
  }

  /** The camera stopped following on its own (the user panned away). */
  followStopped(): void {
    this.following = false;
    this.render(true);
  }

  private setFollowing(on: boolean): void {
    if (on === this.following) return;
    this.following = on;
    this.callbacks.onFollow(on ? this.subject : null);
    this.render(true);
  }

  render(force = false): void {
    const subject = this.subject;
    if (!subject || this.el.hidden) return;
    if (!subjectAlive(this.sim, subject)) return this.close();
    const now = performance.now();
    if (!force && now - this.lastRender < REFRESH_INTERVAL_MS) return;
    this.lastRender = now;
    const info = describeSubject(this.sim, subject);
    const swatch = `#${info.color.toString(16).padStart(6, '0')}`;
    this.el.innerHTML = `
      <header class="station-card-header">
        <span class="vehicle-swatch" style="background:${swatch}"></span>
        <div>
          <strong>${escape(info.title)}</strong>
          <div class="muted">${escape(info.kind)}</div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <p class="bus-status">${escape(info.status)}</p>
      ${
        info.rows.length
          ? `<dl class="vehicle-rows">${info.rows.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>`
          : ''
      }
      <button class="follow-button ${this.following ? 'active' : ''}" data-action="follow" aria-pressed="${this.following}">
        ${this.following ? 'Following · Esc to stop' : 'Follow'}
      </button>`;
  }
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
