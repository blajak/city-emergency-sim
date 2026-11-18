import './style.css';
import { createCityView } from './render/cityView';
import { IncidentsView } from './render/incidentsView';
import { DistrictLabelsView } from './render/labelsView';
import { RailView } from './render/railView';
import { FreightView } from './render/freightView';
import { createSceneContext } from './render/sceneContext';
import { SignalsView } from './render/signalsView';
import { VehiclesView } from './render/vehiclesView';
import { Simulation } from './sim/Simulation';
import { formatAddress } from './sim/world/address';
import { generateCity } from './sim/world/cityGenerator';
import { DebugOverlay } from './ui/debugOverlay';
import { DispatchPanel } from './ui/dispatchPanel';
import { BuildingInteraction } from './ui/interaction';
import { BusCard } from './ui/busCard';
import { PowerCard } from './ui/powerCard';
import { StadiumCard, matchMessage } from './ui/stadiumCard';
import { StationCard } from './ui/stationCard';
import { Toast } from './ui/toast';
import { INCIDENT_NAME, PRIORITY_LABEL } from './ui/labels';
import { VehicleCard } from './ui/vehicleCard';
import { type Subject, subjectAlive, subjectPosition } from './ui/vehicleInfo';

const DEFAULT_SEED = 1337;

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
}

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || DEFAULT_SEED;
const DEFAULT_SCALE = 10;
const scale = Math.min(10, Math.max(1, Number(params.get('scale')) || DEFAULT_SCALE));
const city = generateCity(seed, { scale });
const sim = new Simulation(city, { civilianCount: Number(params.get('cars')) || Math.round(20 * scale) });

const ctx = createSceneContext(requireElement('app'), city.bounds);
const vehiclesView = new VehiclesView();
const signalsView = new SignalsView(sim.signals, sim.traffic.graph);
const incidentsView = new IncidentsView(city);
const labelsView = new DistrictLabelsView(city.districts);
const railView = new RailView(city, sim.rail);
const freightView = new FreightView(sim.containers);

const hud = requireElement('hud');
const toast = new Toast(hud);
const stationCard = new StationCard(hud, sim, (message, tone) => toast.show(message, tone));
/** Camera follows a subject until the card is closed or the user pans away. */
function follow(subject: Subject | null, stopped: () => void): void {
  if (!subject) return ctx.follow(null);
  ctx.follow(() => (subjectAlive(sim, subject) ? subjectPosition(sim, subject) : null), stopped);
}
const busCard = new BusCard(hud, sim, (bus) => follow(bus && { kind: 'bus', bus }, () => busCard.followStopped()));
const vehicleCard = new VehicleCard(hud, sim, { onFollow: (subject) => follow(subject, () => vehicleCard.followStopped()) });
const powerCard = new PowerCard(hud, sim, (message, tone) => toast.show(message, tone));
const stadiumCard = new StadiumCard(hud, sim, (message, tone) => toast.show(message, tone));
sim.dispatcher.onDiverted = (unit, from, to) => {
  const address = (buildingId: number) => formatAddress(city, city.buildings[buildingId]);
  toast.show(`${unit.name} diverted to ${address(to.buildingId)} (${PRIORITY_LABEL[to.priority]?.toLowerCase()} priority); ${address(from.buildingId)} queued`);
};
const closeCards = () => {
  stationCard.close();
  busCard.close();
  vehicleCard.close();
  powerCard.close();
  stadiumCard.close();
};
const interaction = new BuildingInteraction(ctx.renderer.domElement, ctx.camera, sim, {
  onReport(type, building) {
    const result = sim.reportIncident(type, building.id);
    if (result.ok) {
      const priority = PRIORITY_LABEL[result.incident.priority];
      toast.show(`${priority ? `${priority} priority: ` : ''}${INCIDENT_NAME[type]} reported at ${formatAddress(city, building)}`);
      panel.setTool(null);
    }
  },
  onRejected: (message) => toast.show(message, 'error'),
  onStation: (building, screen) => {
    closeCards();
    stationCard.open(building, screen);
  },
  onBus: (bus, screen) => {
    closeCards();
    busCard.openBus(bus, screen);
  },
  onStop: (stop, screen) => {
    closeCards();
    busCard.openStop(stop, screen);
  },
  onVehicle: (subject, screen) => {
    closeCards();
    vehicleCard.open(subject, screen);
  },
  onPowerPlant: (screen) => {
    closeCards();
    powerCard.open(screen);
  },
  onStadium: (screen) => {
    closeCards();
    stadiumCard.open(screen);
  },
  onEmptyClick: closeCards,
});
const panel = new DispatchPanel(hud, sim, {
  onToolChange: (tool) => {
    interaction.setTool(tool);
    if (tool) closeCards();
  },
  onNightChange: (value) => {
    night = value;
    applyLighting();
  },
});

/** Day / night and per-district power: sky, windows, lamps, headlights. */
let night = false;
let powerVersion = -1;
function applyLighting(): void {
  powerVersion = sim.power.version;
  const powered = sim.power.districts.map((d) => d.on);
  ctx.setNight(night);
  cityView.setLighting(night, powered);
  vehiclesView.setNight(night);
  labelsView.setPower(powered);
}

/** Keep the city centred in the part of the screen the panel doesn't cover. */
function updateViewInsets(): void {
  const panelEl = hud.querySelector<HTMLElement>('.panel');
  if (!panelEl) return;
  const narrow = window.innerWidth <= 760;
  ctx.setViewInsets(narrow ? 0 : panelEl.offsetWidth + 16, narrow ? panelEl.offsetHeight + 12 : 0);
}
updateViewInsets();
window.addEventListener('resize', updateViewInsets);

const cityView = createCityView(city);
applyLighting();
ctx.scene.add(cityView.group, vehiclesView.group, signalsView.group, incidentsView.group, labelsView.group, railView.group, freightView.group, interaction.highlight.object);

const debug = params.has('debug') ? new DebugOverlay(hud, sim, ctx.renderer) : null;

function frame(dt: number): void {
  debug?.update(dt * 1000);
  const alpha = sim.advance(dt);
  if (sim.power.version !== powerVersion) applyLighting();
  vehiclesView.update([...sim.traffic.vehicles, ...sim.buses.yard, ...sim.power.drivewayVans], alpha, sim.time);
  signalsView.update();
  railView.update(alpha, sim.time);
  freightView.update(alpha);
  incidentsView.update(sim.dispatcher, sim.time);
  labelsView.update(ctx.camera, ctx.controls.target);
  panel.render();
  stationCard.render();
  busCard.render();
  vehicleCard.render();
  powerCard.render();
  stadiumCard.render();
  for (const event of sim.match.drainEvents()) {
    const message = matchMessage(event);
    if (message) toast.show(message);
  }
}
ctx.start(frame);

if (import.meta.env.DEV) {
  // Handy for poking at the scene from the browser console.
  Object.assign(window, { __sim: { city, sim, ctx, frame } });
}
