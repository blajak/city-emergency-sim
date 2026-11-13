import type { Rng } from '../math/rng';
import { type Vec2, dot, normalize, sub } from '../math/vec2';
import type { Lane, LaneGraph, SegmentId } from '../traffic/laneGraph';
import type { NodeId, RoadNetwork } from '../world/types';

export type LightState = 'green' | 'yellow' | 'red';

export interface SignalTiming {
  green: number;
  yellow: number;
  /** All approaches red between phases, so the junction can clear. */
  allRed: number;
}

export const DEFAULT_TIMING: SignalTiming = { green: 12, yellow: 3, allRed: 1.5 };

/** Approaches at least this far from parallel (≈140°) count as opposite. */
const OPPOSITE_DOT = -0.77;

type Stage = 'green' | 'yellow' | 'allRed';

export interface SignalController {
  nodeId: NodeId;
  /** Each phase lists the approach lanes that get green together. */
  phases: SegmentId[][];
  phaseIndex: number;
  stage: Stage;
  /** Seconds left in the current stage. */
  remaining: number;
}

/** What vehicles need to know: the light facing a lane (null = no signal). */
export interface SignalLookup {
  lightFor(laneId: SegmentId): LightState | null;
}

export const NO_SIGNALS: SignalLookup = { lightFor: () => null };

/** Fixed-time traffic lights, one controller per signalised intersection. */
export class SignalSystem implements SignalLookup {
  readonly controllers: SignalController[] = [];
  private readonly byLane = new Map<SegmentId, { controller: SignalController; phase: number }>();

  constructor(
    graph: LaneGraph,
    network: RoadNetwork,
    rng: Rng,
    readonly timing: SignalTiming = DEFAULT_TIMING,
  ) {
    for (const node of network.nodes) {
      if (!node.signalized) continue;
      const approaches = graph.lanes.filter((l) => l.toNode === node.id);
      const phases = groupIntoPhases(approaches);
      // Random start so the city's lights are not all in sync.
      const controller: SignalController = {
        nodeId: node.id,
        phases,
        phaseIndex: rng.int(0, phases.length - 1),
        stage: 'green',
        remaining: rng.range(1, timing.green),
      };
      this.controllers.push(controller);
      phases.forEach((lanes, phase) => lanes.forEach((id) => this.byLane.set(id, { controller, phase })));
    }
  }

  step(dt: number): void {
    for (const c of this.controllers) {
      c.remaining -= dt;
      while (c.remaining <= 0) this.advanceStage(c);
    }
  }

  lightFor(laneId: SegmentId): LightState | null {
    const entry = this.byLane.get(laneId);
    if (!entry) return null;
    const { controller, phase } = entry;
    if (phase !== controller.phaseIndex || controller.stage === 'allRed') return 'red';
    return controller.stage;
  }

  private advanceStage(c: SignalController): void {
    switch (c.stage) {
      case 'green':
        c.stage = 'yellow';
        c.remaining += this.timing.yellow;
        break;
      case 'yellow':
        c.stage = 'allRed';
        c.remaining += this.timing.allRed;
        break;
      case 'allRed':
        c.stage = 'green';
        c.phaseIndex = (c.phaseIndex + 1) % c.phases.length;
        c.remaining += this.timing.green;
        break;
    }
  }
}

/**
 * Pairs approaches coming from opposite directions into one phase (classic
 * two-phase crossroads); anything left over gets a phase of its own.
 */
export function groupIntoPhases(approaches: readonly Lane[]): SegmentId[][] {
  const remaining = approaches.map((lane) => ({ id: lane.id, dir: arrivalDirection(lane) }));
  const phases: SegmentId[][] = [];
  while (remaining.length) {
    const a = remaining.shift()!;
    let bestIndex = -1;
    let bestDot = OPPOSITE_DOT;
    remaining.forEach((b, i) => {
      const d = dot(a.dir, b.dir);
      if (d < bestDot) {
        bestDot = d;
        bestIndex = i;
      }
    });
    if (bestIndex >= 0) phases.push([a.id, remaining.splice(bestIndex, 1)[0].id]);
    else phases.push([a.id]);
  }
  return phases;
}

function arrivalDirection(lane: Lane): Vec2 {
  const pts = lane.points;
  return normalize(sub(pts[pts.length - 1], pts[pts.length - 2]));
}
