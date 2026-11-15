import { Dispatcher } from './dispatch/dispatcher';
import type { IncidentType, ReportResult } from './dispatch/types';
import { createRng } from './math/rng';
import { RailSystem } from './rail/railSystem';
import { SignalSystem } from './signals/signalSystem';
import { buildLaneGraph } from './traffic/laneGraph';
import { TrafficSystem } from './traffic/trafficSystem';
import { BusSystem } from './transit/busSystem';
import type { BuildingId, City } from './world/types';

/** Fixed simulation step (20 ticks per second of sim time). */
export const SIM_DT = 1 / 20;
/** Upper bound on catch-up steps per frame, so a slow frame can't spiral. */
const MAX_STEPS_PER_FRAME = 10;

export type TimeScale = 0 | 1 | 2;

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
    this.dispatcher = new Dispatcher(city, this.traffic, rng);
    for (let i = 0; i < (options.fireUnits ?? 1); i++) this.dispatcher.addUnit('fire');
    for (let i = 0; i < (options.policeUnits ?? 1); i++) this.dispatcher.addUnit('police');
    // Buses before civilians, so cars are not spawned on top of them.
    this.buses = new BusSystem(city, this.traffic, rng);
    this.traffic.spawnCivilians(options.civilianCount ?? 20);
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
    const events = this.traffic.step(SIM_DT);
    this.time += SIM_DT;
    this.dispatcher.update(this.time, SIM_DT, events);
    this.buses.update(this.time, events);
  }
}
