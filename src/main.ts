import './style.css';
import { createCityView } from './render/cityView';
import { IncidentsView } from './render/incidentsView';
import { DistrictLabelsView } from './render/labelsView';
import { RailView } from './render/railView';
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
import { StationCard } from './ui/stationCard';
import { Toast } from './ui/toast';

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

const hud = requireElement('hud');
const toast = new Toast(hud);
const stationCard = new StationCard(hud, sim, (message, tone) => toast.show(message, tone));
const busCard = new BusCard(hud, sim);
const interaction = new BuildingInteraction(ctx.renderer.domElement, ctx.camera, sim, {
  onReport(type, building) {
    const result = sim.reportIncident(type, building.id);
    if (result.ok) {
      toast.show(`${type === 'fire' ? 'Fire' : 'Crime'} reported at ${formatAddress(city, building)}`);
      panel.setTool(null);
    }
  },
  onRejected: (message) => toast.show(message, 'error'),
  onStation: (building, screen) => {
    busCard.close();
    stationCard.open(building, screen);
  },
  onBus: (bus, screen) => {
    stationCard.close();
    busCard.openBus(bus, screen);
  },
  onStop: (stop, screen) => {
    stationCard.close();
    busCard.openStop(stop, screen);
  },
  onEmptyClick: () => {
    stationCard.close();
    busCard.close();
  },
});
const panel = new DispatchPanel(hud, sim, {
  onToolChange: (tool) => {
    interaction.setTool(tool);
    if (tool) {
      stationCard.close();
      busCard.close();
    }
  },
});

/** Keep the city centred in the part of the screen the panel doesn't cover. */
function updateViewInsets(): void {
  const panelEl = hud.querySelector<HTMLElement>('.panel');
  if (!panelEl) return;
  const narrow = window.innerWidth <= 760;
  ctx.setViewInsets(narrow ? 0 : panelEl.offsetWidth + 16, narrow ? panelEl.offsetHeight + 12 : 0);
}
updateViewInsets();
window.addEventListener('resize', updateViewInsets);

ctx.scene.add(createCityView(city), vehiclesView.group, signalsView.group, incidentsView.group, labelsView.group, railView.group, interaction.highlight.object);

const debug = params.has('debug') ? new DebugOverlay(hud, sim, ctx.renderer) : null;

function frame(dt: number): void {
  debug?.update(dt * 1000);
  const alpha = sim.advance(dt);
  vehiclesView.update([...sim.traffic.vehicles, ...sim.buses.yard], alpha, sim.time);
  signalsView.update();
  railView.update(alpha, sim.time);
  incidentsView.update(sim.dispatcher, sim.time);
  labelsView.update(ctx.camera, ctx.controls.target);
  panel.render();
  stationCard.render();
  busCard.render();
}
ctx.start(frame);

if (import.meta.env.DEV) {
  // Handy for poking at the scene from the browser console.
  Object.assign(window, { __sim: { city, sim, ctx, frame } });
}
