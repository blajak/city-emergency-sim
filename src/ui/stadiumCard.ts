import type { Unit, UnitType } from '../sim/dispatch/types';
import { ARRIVAL_TIME, type MatchEvent, type MatchSystem } from '../sim/events/matchSystem';
import type { Simulation } from '../sim/Simulation';
import { placeCard } from './cardPlacement';
import { ICONS } from './icons';

const REFRESH_INTERVAL_MS = 250;
const DUTY_NAME: Record<UnitType, string> = { fire: 'Fire engine', police: 'Police car', ambulance: 'Ambulance' };

/** m:ss */
function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** Toast text for a match event (null: no toast). */
export function matchMessage(event: MatchEvent): string | null {
  switch (event.kind) {
    case 'announced':
      return `Match announced: kick-off in ${clock(ARRIVAL_TIME)}, ${event.fans} fans on their way`;
    case 'kick_off':
      return 'Kick-off at the stadium';
    case 'goal':
      return `Goal for ${event.side === 'home' ? 'Home' : 'Away'}! (${event.minute}')`;
    case 'final_whistle':
      return `Final whistle: Home ${event.home} : ${event.away} Away. Fans are leaving`;
    case 'car_park_empty':
      return 'Stadium car park empty; units back on call';
  }
}

/** Floating card for the stadium: the match (phase, countdown, score, fans, units on duty) and "Organise a match". */
export class StadiumCard {
  private readonly el: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly organiseButton: HTMLButtonElement;
  private readonly noteEl: HTMLElement;
  private lastRender = 0;
  private lastBody = '';

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly onMessage: (message: string, tone?: 'info' | 'error') => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'station-card stadium-card';
    this.el.hidden = true;
    // The buttons stay the same elements (only the text round them is redrawn), so a click
    // is never lost to a refresh between pressing and releasing.
    this.el.innerHTML = `
      <header class="station-card-header">
        <span class="line-badge stadium-badge">⚽</span>
        <div>
          <strong>Stadium</strong>
          <div class="muted" data-ref="status"></div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <div data-ref="body"></div>
      <button class="add-unit" data-action="organise"></button>
      <p class="muted station-note" data-ref="note"></p>`;
    const ref = <T extends HTMLElement>(name: string) => this.el.querySelector<T>(`[data-ref="${name}"], [data-action="${name}"]`)!;
    this.statusEl = ref('status');
    this.bodyEl = ref('body');
    this.organiseButton = ref<HTMLButtonElement>('organise');
    this.noteEl = ref('note');
    container.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || button.disabled) return;
      if (button.dataset.action === 'close') this.close();
      if (button.dataset.action === 'organise' && !this.sim.match.organise()) this.onMessage('A match is already on.', 'error');
      this.render(true);
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  open(screen: { x: number; y: number }): void {
    this.el.hidden = false;
    this.render(true);
    placeCard(this.el, screen);
  }

  close(): void {
    this.el.hidden = true;
  }

  render(force = false): void {
    if (this.el.hidden) return;
    const now = performance.now();
    if (!force && now - this.lastRender < REFRESH_INTERVAL_MS) return;
    this.lastRender = now;
    const m = this.sim.match;
    const on = m.phase !== 'idle';
    const score =
      on || m.stats.matches > 0
        ? `<div class="match-score"><span>Home</span><strong>${m.score.home} : ${m.score.away}</strong><span>Away</span></div>
           ${on ? '' : '<div class="muted match-score-note">Last result</div>'}`
        : '';
    setText(this.statusEl, this.status(m));
    const body = score + (on ? this.details(m) : '');
    if (body !== this.lastBody) this.bodyEl.innerHTML = this.lastBody = body;
    this.organiseButton.disabled = !m.canOrganise();
    setText(this.organiseButton, on ? 'Match in progress' : '⚽ Organise a match');
    setText(
      this.noteEl,
      on
        ? 'Units on match duty take no other calls until the car park is empty.'
        : `Fans drive in over 3 minutes and park in the ${m.spaces.length} spaces round the stadium; a police car and an ambulance stand by. After the 2-minute match everyone leaves at once.`,
    );
  }

  private status(m: MatchSystem): string {
    const time = this.sim.time;
    switch (m.phase) {
      case 'idle':
        return 'No match on';
      case 'arriving':
        return `Fans arriving · kick-off in ${clock(m.kickOff - time)}`;
      case 'playing':
        return `Playing · ${m.minute()}' · ${clock(m.whistle - time)} left`;
      case 'leaving':
        return 'Full time · fans leaving';
    }
  }

  private details(m: MatchSystem): string {
    const parked = m.parked();
    const coming = m.fans.filter((f) => f.status === 'waiting' || f.status === 'driving_in').length;
    const leaving = m.fans.filter((f) => f.status === 'leaving').length;
    const fans =
      m.phase === 'leaving'
        ? `${parked} still parked · ${leaving} driving home`
        : `${parked} / ${m.spaces.length} spaces taken · ${coming} on the way`;
    const units = [
      ...m.duty.map((u) => this.dutyRow(u)),
      ...m.waitingForUnits().map(
        (type) => `<li class="station-unit"><span>${DUTY_NAME[type]}</span><span class="chip tone-warn">Waiting for a free unit</span></li>`,
      ),
    ];
    return `
      <h4 class="card-subhead">Fans</h4>
      <div class="match-fans">${fans}</div>
      <h4 class="card-subhead">On duty</h4>
      <ul class="list">${units.join('') || '<li class="muted">No units</li>'}</ul>`;
  }

  private dutyRow(unit: Unit): string {
    const there = unit.vehicle.maneuver === 'parked';
    const icon = unit.type === 'ambulance' ? ICONS.ambulance : ICONS.car;
    return `<li class="station-unit unit-${unit.type}"><span class="duty-name">${icon} ${unit.name}</span>
      <span class="chip ${there ? 'tone-done' : 'tone-info'}">${there ? 'Standing by' : 'Driving there'}</span></li>`;
  }
}
