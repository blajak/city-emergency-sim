import type { Simulation } from '../sim/Simulation';
import type { Bus, BusStatus } from '../sim/transit/busSystem';
import type { BusLine, BusStop } from '../sim/world/types';
import { placeCard } from './cardPlacement';

const REFRESH_INTERVAL_MS = 250;

const STATUS: Record<BusStatus, string> = {
  to_line: 'Heading to the start of the line',
  driving: 'Driving to',
  at_stop: 'At stop',
  layover: 'Waiting at the terminus',
  to_depot: 'Returning to the depot',
};

type Target = { kind: 'bus'; bus: Bus } | { kind: 'stop'; stop: BusStop };

/** Floating card for a bus (line, status, next stops) or a stop (lines, next buses). */
export class BusCard {
  private readonly el: HTMLElement;
  private target: Target | null = null;
  private following = false;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    /** Start (bus) or stop (null) following a bus with the camera. */
    private readonly onFollow: (bus: Bus | null) => void = () => {},
  ) {
    this.el = document.createElement('div');
    this.el.className = 'station-card bus-card';
    this.el.hidden = true;
    container.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (button?.dataset.action === 'close') this.close();
      if (button?.dataset.action === 'follow') this.setFollowing(!this.following);
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  /** The camera stopped following on its own (the user panned away). */
  followStopped(): void {
    this.following = false;
    this.render(true);
  }

  private setFollowing(on: boolean): void {
    if (on === this.following) return;
    this.following = on;
    this.onFollow(on && this.target?.kind === 'bus' ? this.target.bus : null);
    this.render(true);
  }

  openBus(bus: Bus, screen: { x: number; y: number }): void {
    this.open({ kind: 'bus', bus }, screen);
  }

  openStop(stop: BusStop, screen: { x: number; y: number }): void {
    this.open({ kind: 'stop', stop }, screen);
  }

  close(): void {
    this.setFollowing(false);
    this.el.hidden = true;
    this.target = null;
  }

  private open(target: Target, screen: { x: number; y: number }): void {
    this.setFollowing(false);
    this.target = target;
    this.el.hidden = false;
    this.render(true);
    placeCard(this.el, screen);
  }

  render(force = false): void {
    if (!this.target || this.el.hidden) return;
    const now = performance.now();
    if (!force && now - this.lastRender < REFRESH_INTERVAL_MS) return;
    this.lastRender = now;
    if (this.target.kind === 'bus') {
      // The bus may have gone back into the depot.
      if (!this.sim.buses.buses.includes(this.target.bus)) return this.close();
      this.el.innerHTML = this.busHtml(this.target.bus);
    } else {
      this.el.innerHTML = this.stopHtml(this.target.stop);
    }
  }

  private busHtml(bus: Bus): string {
    const { buses } = this.sim;
    const stop = buses.currentStop(bus);
    let status = STATUS[bus.status];
    if (bus.status === 'driving' || bus.status === 'at_stop') status += ` ${escape(stop.name)}`;
    if (bus.status === 'layover') {
      status += ` ${escape(stop.name)} · leaves ${formatEta(bus.departAt - this.sim.time)}`;
    }
    const next = buses.upcoming(bus, 4);
    const terminus = buses.stop(bus.line.calls[bus.line.turnCall].stop);
    const home = buses.stop(bus.line.calls[0].stop);
    return `
      <header class="station-card-header">
        ${badge(bus.line)}
        <div>
          <strong>${bus.name} · Line ${bus.line.name}</strong>
          <div class="muted">${escape(home.name)} ↔ ${escape(terminus.name)}</div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <p class="bus-status">${status}</p>
      ${
        next.length
          ? `<ul class="list">${next
              .map((n) => `<li class="station-unit"><span>${escape(n.stop.name)}</span><span class="muted">${formatEta(n.eta)}</span></li>`)
              .join('')}</ul>`
          : ''
      }
      <button class="follow-button ${this.following ? 'active' : ''}" data-action="follow" aria-pressed="${this.following}">
        ${this.following ? 'Following · Esc to stop' : 'Follow'}
      </button>`;
  }

  private stopHtml(stop: BusStop): string {
    const { buses } = this.sim;
    const lines = buses.linesAt(stop.id);
    const arrivals = buses.arrivals(stop.id).slice(0, 5);
    return `
      <header class="station-card-header">
        <span class="line-badge stop-badge">H</span>
        <div>
          <strong>${escape(stop.name)}</strong>
          <div class="muted">${stop.bay ? 'Bus bay' : 'Stop in the lane'} · lines ${lines.map((l) => l.name).join(', ')}</div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <ul class="list">${
        arrivals.length
          ? arrivals
              .map((a) => `<li class="station-unit">${badge(a.line)}<span>${a.bus.name}</span><span class="muted">${a.eta === 0 ? 'at the stop' : formatEta(a.eta)}</span></li>`)
              .join('')
          : '<li class="muted">No buses in service</li>'
      }</ul>`;
  }
}

function badge(line: BusLine): string {
  return `<span class="line-badge" style="background:#${line.color.toString(16).padStart(6, '0')}">${line.name}</span>`;
}

function formatEta(seconds: number): string {
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  return `in ${minutes} min`;
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
