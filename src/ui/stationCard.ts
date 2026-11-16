import { MAX_UNITS_PER_STATION } from '../sim/dispatch/dispatcher';
import type { Unit, UnitType } from '../sim/dispatch/types';
import type { Simulation } from '../sim/Simulation';
import type { Building } from '../sim/world/types';
import { ICONS } from './icons';
import { UNIT_STATUS } from './labels';
import { placeCard } from './cardPlacement';

const REFRESH_INTERVAL_MS = 250;
const NOUN: Record<UnitType, string> = { fire: 'engine', police: 'patrol car' };

/** Floating card for a station: lists its units and adds / removes them. */
export class StationCard {
  private readonly el: HTMLElement;
  private type: UnitType | null = null;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly onMessage: (message: string, tone?: 'info' | 'error') => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'station-card';
    this.el.hidden = true;
    container.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || button.disabled || !this.type) return;
      const action = button.dataset.action;
      if (action === 'close') this.close();
      if (action === 'add') {
        const unit = this.sim.dispatcher.addUnit(this.type);
        if (unit) this.onMessage(`${unit.name} added`);
      }
      if (action === 'remove') {
        const unit = this.sim.dispatcher.unit(Number(button.dataset.unit));
        if (unit && this.sim.dispatcher.removeUnit(unit.id)) this.onMessage(`${unit.name} removed`);
      }
      this.render(true);
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(station: Building, screen: { x: number; y: number }): void {
    this.type = station.kind === 'fire_station' ? 'fire' : 'police';
    this.el.hidden = false;
    this.render(true);
    // Keep the card inside the map area (left of the panel on desktop).
    placeCard(this.el, screen);
  }

  close(): void {
    this.el.hidden = true;
    this.type = null;
  }

  render(force = false): void {
    if (!this.type || this.el.hidden) return;
    const now = performance.now();
    if (!force && now - this.lastRender < REFRESH_INTERVAL_MS) return;
    this.lastRender = now;

    const { dispatcher } = this.sim;
    const type = this.type;
    const units = dispatcher.unitsOfType(type);
    const full = units.length >= MAX_UNITS_PER_STATION;
    const title = type === 'fire' ? 'Fire Station' : 'Police Station';
    const note =
      type === 'police'
        ? 'One car always patrols. A car at the station takes over when the patroller is dispatched.'
        : 'Engines return here after every call.';

    this.el.innerHTML = `
      <header class="station-card-header unit-${type}">
        <span class="item-icon">${type === 'fire' ? ICONS.engine : ICONS.car}</span>
        <div>
          <strong>${title}</strong>
          <div class="muted">${units.length} / ${MAX_UNITS_PER_STATION} ${NOUN[type]}s</div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <ul class="list">${units.map((u) => this.unitRow(u)).join('')}</ul>
      <button class="add-unit" data-action="add" ${full ? 'disabled' : ''}>
        ${full ? `Station is full (max ${MAX_UNITS_PER_STATION})` : `+ Add ${NOUN[type]}`}
      </button>
      <p class="muted station-note">${note}</p>
    `;
  }

  private unitRow(unit: Unit): string {
    const status = UNIT_STATUS[unit.status];
    const blocker = this.sim.dispatcher.removalBlocker(unit);
    return `
      <li class="station-unit">
        <span>${unit.name}</span>
        <span class="chip tone-${status.tone}">${status.label}</span>
        <button class="icon-button" data-action="remove" data-unit="${unit.id}"
          ${blocker ? `disabled title="${blocker}"` : 'title="Remove unit"'} aria-label="Remove ${unit.name}">−</button>
      </li>`;
  }
}
