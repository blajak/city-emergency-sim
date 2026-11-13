import { Dispatcher } from './dispatch/dispatcher';
import type { IncidentType, ReportResult } from './dispatch/types';
import { createRng } from './math/rng';
import { SignalSystem } from './signals/signalSystem';
import { buildLaneGraph } from './traffic/laneGraph';
import { TrafficSystem } from './traffic/trafficSystem';
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
  readonly traffic: TrafficSystem;
  readonly dispatcher: Dispatcher;
  time = 0;
  timeScale: TimeScale = 1;
  private accumulator = 0;

  constructor(
    readonly city: City,
    options: SimulationOptions = {},
  ) {
    const rng = createRng(city.seed ^ 0x9e3779b9);
    const graph = buildLaneGraph(city.roads);
    this.signals = new SignalSystem(graph, city.roads, rng);
    this.traffic = new TrafficSystem(graph, rng, this.signals);
    this.dispatcher = new Dispatcher(city, this.traffic, rng);
    for (let i = 0; i < (options.fireUnits ?? 1); i++) this.dispatcher.addUnit('fire');
    for (let i = 0; i < (options.policeUnits ?? 1); i++) this.dispatcher.addUnit('police');
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
    this.signals.step(SIM_DT);
    const events = this.traffic.step(SIM_DT);
    this.time += SIM_DT;
    this.dispatcher.update(this.time, SIM_DT, events);
  }
}
