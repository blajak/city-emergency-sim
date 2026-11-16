import type { Simulation } from '../sim/Simulation';
import type { DistrictPower } from '../sim/power/powerSystem';
import { CREW_STATUS } from './labels';
import { placeCard } from './cardPlacement';

const REFRESH_INTERVAL_MS = 250;


const DISPATCH_ERRORS: Record<string, string> = {
  busy: 'All crews are busy.',
  fire: 'The crew can start once the fire at the plant is out.',
  no_crew: 'There is no utility crew.',
  assigned: 'A crew is already on it.',
  powered: 'This district has power.',
};

/** Floating card for the power plant: districts with their power, switches and the utility crews. */
export class PowerCard {
  private readonly el: HTMLElement;
  private lastRender = 0;

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly onMessage: (message: string, tone?: 'info' | 'error') => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'station-card power-card';
    this.el.hidden = true;
    container.appendChild(this.el);

    this.el.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest('button');
      if (!button || button.disabled) return;
      const { action } = button.dataset;
      const district = Number(button.dataset.district);
      const name = this.sim.city.districts[district]?.name;
      const { power } = this.sim;
      if (action === 'close') this.close();
      if (action === 'off') {
        power.switchOff(district);
        this.onMessage(`Power cut in ${name}`);
      }
      if (action === 'on') {
        if (power.switchOn(district)) this.onMessage(`Power back in ${name}`);
        else this.onMessage(DISPATCH_ERRORS.fire, 'error');
      }
      if (action === 'crew') {
        const result = power.dispatchCrew(district);
        if (result.ok) this.onMessage(`${result.crew.name} sent to ${name}`);
        else this.onMessage(DISPATCH_ERRORS[result.reason], 'error');
      }
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
    const { power } = this.sim;
    const off = power.districts.filter((d) => !d.on).length;
    this.el.innerHTML = `
      <header class="station-card-header">
        <span class="line-badge power-badge">⚡</span>
        <div>
          <strong>Power Plant</strong>
          <div class="muted">${off ? `${off} district${off > 1 ? 's' : ''} without power` : 'All districts have power'}</div>
        </div>
        <button class="icon-button" data-action="close" aria-label="Close">×</button>
      </header>
      <ul class="list">${power.districts.map((d) => this.districtRow(d)).join('')}</ul>
      <h4 class="card-subhead">Utility crews</h4>
      <ul class="list">${
        power.crews.length
          ? power.crews
              .map((c) => {
                const where = c.district !== null ? ` · ${this.sim.city.districts[c.district].name}` : '';
                return `<li class="station-unit"><span>${c.name}</span><span class="muted">${CREW_STATUS[c.status]}${where}</span></li>`;
              })
              .join('')
          : '<li class="muted">No crews</li>'
      }</ul>`;
  }

  private districtRow(d: DistrictPower): string {
    const name = this.sim.city.districts[d.district].name;
    let chip: string;
    if (d.on) chip = '<span class="chip tone-done">On</span>';
    else if (d.crew) chip = `<span class="chip tone-info">${d.crew.status === 'repairing' ? 'Repairing' : 'Crew on the way'}</span>`;
    else chip = `<span class="chip tone-active">${d.cause === 'fire' ? 'Off · fire' : 'Off'}</span>`;
    const buttons = d.on
      ? `<button class="small-button" data-action="off" data-district="${d.district}" title="Cut the power">Switch off</button>`
      : `<button class="small-button" data-action="on" data-district="${d.district}" title="Switch the power back on">On</button>
         <button class="small-button" data-action="crew" data-district="${d.district}" ${d.crew ? 'disabled' : ''} title="Send a utility crew to repair">Send crew</button>`;
    return `<li class="power-row"><span class="power-name">${name}</span>${chip}<span class="power-actions">${buttons}</span></li>`;
  }
}
