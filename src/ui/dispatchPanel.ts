import type { Incident, IncidentType, Unit } from '../sim/dispatch/types';
import type { Simulation, TimeScale } from '../sim/Simulation';
import { formatAddress } from '../sim/world/address';
import { ICONS } from './icons';
import { INCIDENT_NAME, INCIDENT_STATUS, UNIT_STATUS } from './labels';

/** How many resolved incidents stay visible in the list. */
const RESOLVED_SHOWN = 4;
const REFRESH_INTERVAL_MS = 200;

export interface DispatchPanelCallbacks {
  onToolChange(tool: IncidentType | null): void;
}

/** Right-hand dispatcher panel: time controls, report tools, incidents, units. */
export class DispatchPanel {
  private readonly root: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly incidentsEl: HTMLElement;
  private readonly unitsEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private tool: IncidentType | null = null;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly callbacks: DispatchPanelCallbacks,
  ) {
    this.root = document.createElement('aside');
    this.root.className = 'panel';
    this.root.innerHTML = `
      <header class="panel-header">
        <div>
          <h2>Dispatch</h2>
          <p class="panel-sub">City Emergency Sim</p>
        </div>
        <span class="clock" data-ref="clock">00:00</span>
      </header>
      <div class="segmented" role="group" aria-label="Simulation speed">
        <button data-speed="0" title="Pause (Space)">${ICONS.pause}<span>Pause</span></button>
        <button data-speed="1" title="Normal speed (1)">1×</button>
        <button data-speed="2" title="Double speed (2)">2×</button>
      </div>
      <section class="panel-section">
        <h3>Report incident</h3>
        <div class="tools">
          <button class="tool tool-fire" data-tool="fire" title="Report a fire (F)">${ICONS.fire}<span>Fire</span></button>
          <button class="tool tool-crime" data-tool="crime" title="Report a crime (C)">${ICONS.crime}<span>Crime</span></button>
        </div>
        <p class="hint" data-ref="hint" hidden></p>
      </section>
      <section class="panel-section">
        <h3>Incidents <span class="count" data-ref="summary"></span></h3>
        <ul class="list" data-ref="incidents"></ul>
      </section>
      <section class="panel-section">
        <h3>Units <span class="count">click a station to add or remove</span></h3>
        <ul class="list" data-ref="units"></ul>
      </section>
    `;
    container.appendChild(this.root);
    const ref = (name: string) => this.root.querySelector<HTMLElement>(`[data-ref="${name}"]`)!;
    this.clock = ref('clock');
    this.incidentsEl = ref('incidents');
    this.unitsEl = ref('units');
    this.hintEl = ref('hint');
    this.summaryEl = ref('summary');

    this.root.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest('button');
      if (!target || target.disabled) return;
      if (target.dataset.speed !== undefined) this.setSpeed(Number(target.dataset.speed) as TimeScale);
      if (target.dataset.tool) this.setTool(this.tool === target.dataset.tool ? null : (target.dataset.tool as IncidentType));
    });
    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case 'escape':
          this.setTool(null);
          break;
        case 'f':
          this.setTool(this.tool === 'fire' ? null : 'fire');
          break;
        case 'c':
          this.setTool(this.tool === 'crime' ? null : 'crime');
          break;
        case '1':
          this.setSpeed(1);
          break;
        case '2':
          this.setSpeed(2);
          break;
        case ' ':
          // A focused button handles Space itself.
          if (e.target instanceof HTMLButtonElement) return;
          e.preventDefault();
          this.setSpeed(this.sim.timeScale === 0 ? 1 : 0);
          break;
      }
    });
    this.setSpeed(sim.timeScale);
    this.render(true);
  }

  setTool(tool: IncidentType | null): void {
    this.tool = tool;
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    this.hintEl.hidden = tool === null;
    if (tool) this.hintEl.textContent = `Click a building to report a ${INCIDENT_NAME[tool].toLowerCase()}. Esc to cancel.`;
    this.callbacks.onToolChange(tool);
  }

  private setSpeed(scale: TimeScale): void {
    this.sim.timeScale = scale;
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.speed) === scale);
    });
  }

  /** Call every frame; re-renders lists a few times per second. */
  render(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastRender < REFRESH_INTERVAL_MS) return;
    this.lastRender = now;
    const { dispatcher } = this.sim;

    this.clock.textContent = formatDuration(this.sim.time);

    const active = dispatcher.incidents.filter((i) => i.status !== 'resolved').sort((a, b) => b.reportedAt - a.reportedAt);
    const resolved = dispatcher.incidents
      .filter((i) => i.status === 'resolved')
      .sort((a, b) => b.resolvedAt! - a.resolvedAt!)
      .slice(0, RESOLVED_SHOWN);
    const queued = active.filter((i) => i.status === 'queued').length;
    this.summaryEl.textContent = active.length
      ? `${active.length} active${queued ? ` · ${queued} queued` : ''}`
      : '';
    this.incidentsEl.innerHTML =
      [...active, ...resolved].map((i) => this.incidentItem(i)).join('') ||
      `<li class="empty">No incidents. Pick a tool above and click a building.</li>`;
    this.unitsEl.innerHTML = dispatcher.units.map((u) => this.unitItem(u)).join('');
  }

  private incidentItem(incident: Incident): string {
    const building = this.sim.city.buildings[incident.buildingId];
    const status = INCIDENT_STATUS[incident.status];
    const unit = this.sim.dispatcher.unit(incident.unitId);
    const end = incident.resolvedAt ?? this.sim.time;
    let detail: string;
    if (incident.status === 'queued') detail = 'Waiting for a free unit';
    else if (incident.status === 'reported') detail = 'Dispatcher processing call';
    else detail = unit ? unit.name : '—';
    const progress =
      incident.status === 'on_scene'
        ? `<div class="progress"><div style="width:${Math.min(100, (incident.workDone / incident.duration) * 100).toFixed(1)}%"></div></div>`
        : '';
    return `
      <li class="item incident-${incident.type} ${incident.status === 'resolved' ? 'is-done' : ''}">
        <span class="item-icon">${ICONS[incident.type]}</span>
        <div class="item-body">
          <div class="item-row">
            <strong>${INCIDENT_NAME[incident.type]} · ${formatAddress(this.sim.city, building)}</strong>
          </div>
          <div class="item-row muted">
            <span>${detail}</span>
            <span class="tabular">${formatDuration(end - incident.reportedAt)}</span>
          </div>
          ${progress}
        </div>
        <span class="chip tone-${status.tone}">${status.label}</span>
      </li>`;
  }

  private unitItem(unit: Unit): string {
    const status = UNIT_STATUS[unit.status];
    const incident = this.sim.dispatcher.incidents.find((i) => i.id === unit.incidentId);
    const where = incident ? formatAddress(this.sim.city, this.sim.city.buildings[incident.buildingId]) : '';
    return `
      <li class="item unit-${unit.type}">
        <span class="item-icon">${unit.type === 'fire' ? ICONS.engine : ICONS.car}</span>
        <div class="item-body">
          <div class="item-row"><strong>${unit.name}</strong></div>
          ${where ? `<div class="item-row muted"><span>${where}</span></div>` : ''}
        </div>
        <span class="chip tone-${status.tone}">${status.label}</span>
      </li>`;
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
