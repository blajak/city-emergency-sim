import { Dispatcher } from './dispatch/dispatcher';
import type { IncidentType, ReportResult } from './dispatch/types';
import { createRng } from './math/rng';
import { RailSystem } from './rail/railSystem';
import { SignalSystem } from './signals/signalSystem';
import { buildLaneGraph } from './traffic/laneGraph';
import { TrafficSystem } from './traffic/trafficSystem';
import { BusSystem } from './transit/busSystem';
import { LogisticsSystem } from './logistics/logisticsSystem';
import { PowerSystem } from './power/powerSystem';
import { ContainerSystem } from './freight/containerSystem';
import type { BuildingId, City } from './world/types';

/** Fixed simulation step (20 ticks per second of sim time). */
export const SIM_DT = 1 / 20;
/** Upper bound on catch-up steps per frame, so a slow frame can't spiral. */
const MAX_STEPS_PER_FRAME = 10;

export type TimeScale = 0 | 1 | 2;

export interface CityPulse {
  deliveries: number;
  binsEmptied: number;
  trainArrivals: number;
  /** Share of passenger train arrivals less than 30 s late, or null before the first one. */
  trainsOnTime: number | null;
  /** Districts without power right now. */
  blackouts: number;
  incidentsResolved: number;
  /** Mean seconds from call to arrival on scene, or null before the first arrival. */
  averageResponse: number | null;
  /**
   * Containers brought to Dockside by rail, sent out of the city by long-distance trains, and
   * container lorry trips into town; null in towns without a freight line.
   */
  containers: { arrived: number; shipped: number; lorryTrips: number } | null;
}

export interface SimulationOptions {
  civilianCount?: number;
  fireUnits?: number;
  policeUnits?: number;
}

/**
 * Owns all simulation state and advances it in fixed steps, independent of
 * the render frame rate. Rendering interpolates using the returned alpha.
 */
export class Simulation {
  readonly signals: SignalSystem;
  readonly rail: RailSystem;
  readonly traffic: TrafficSystem;
  readonly dispatcher: Dispatcher;
  readonly buses: BusSystem;
  readonly logistics: LogisticsSystem;
  readonly power: PowerSystem;
  readonly containers: ContainerSystem;
  time = 0;
  timeScale: TimeScale = 1;
  /** Smoothed wall-clock cost of one simulation step, ms (for the debug overlay). */
  stepMs = 0;
  private accumulator = 0;

  constructor(
    readonly city: City,
    options: SimulationOptions = {},
  ) {
    const rng = createRng(city.seed ^ 0x9e3779b9);
    const graph = buildLaneGraph(city.roads);
    this.signals = new SignalSystem(graph, city.roads, rng);
    this.rail = new RailSystem(city, graph);
    this.traffic = new TrafficSystem(graph, rng, this.signals, this.rail);
    this.rail.attachTraffic(this.traffic.vehicles);
    this.containers = new ContainerSystem(city, this.rail, graph);
    this.dispatcher = new Dispatcher(city, this.traffic, rng);
    for (let i = 0; i < (options.fireUnits ?? 1); i++) this.dispatcher.addUnit('fire');
    for (let i = 0; i < (options.policeUnits ?? 1); i++) this.dispatcher.addUnit('police');
    // Buses and lorries before civilians, so cars are not spawned on top of them.
    this.buses = new BusSystem(city, this.traffic, rng);
    this.logistics = new LogisticsSystem(city, this.traffic, rng, this.containers);
    this.power = new PowerSystem(city, this.traffic, this.signals, rng);
    this.traffic.spawnCivilians(options.civilianCount ?? 20);
  }

  /** "City pulse": running totals and the current state of the city's services. */
  pulse(): CityPulse {
    const resolved = this.dispatcher.incidents.filter((i) => i.status === 'resolved');
    const reached = this.dispatcher.incidents.filter((i) => i.arrivedAt !== null);
    const { arrivals, onTime } = this.rail.stats;
    return {
      deliveries: this.logistics.stats.deliveries,
      binsEmptied: this.logistics.stats.binsEmptied,
      trainArrivals: arrivals,
      trainsOnTime: arrivals > 0 ? onTime / arrivals : null,
      blackouts: this.power.districts.filter((d) => !d.on).length,
      incidentsResolved: resolved.length,
      averageResponse: reached.length > 0 ? reached.reduce((s, i) => s + i.arrivedAt! - i.reportedAt, 0) / reached.length : null,
      containers:
        this.containers.yards.length > 0
          ? { arrived: this.containers.stats.delivered, shipped: this.containers.stats.shipped, lorryTrips: this.logistics.stats.containerTrips }
          : null,
    };
  }

  reportIncident(type: IncidentType, buildingId: BuildingId): ReportResult {
    return this.dispatcher.report(type, buildingId);
  }

  /**
   * Advances by real elapsed seconds (scaled by `timeScale`).
   * Returns the interpolation factor between the previous and current tick.
   */
  advance(realDt: number): number {
    this.accumulator += realDt * this.timeScale;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    return this.accumulator / SIM_DT;
  }

  step(): void {
    const started = performance.now();
    this.stepInner();
    this.stepMs += (performance.now() - started - this.stepMs) * 0.05;
  }

  private stepInner(): void {
    this.signals.step(SIM_DT);
    this.rail.step(SIM_DT);
    this.containers.step(SIM_DT);
    const events = this.traffic.step(SIM_DT);
    this.time += SIM_DT;
    this.dispatcher.update(this.time, SIM_DT, events);
    this.buses.update(this.time, events);
    this.logistics.update(this.time, events);
    this.power.update(this.time, events, this.dispatcher.incidents);
  }
}
