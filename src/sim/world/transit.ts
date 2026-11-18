import { distanceToPolyline, samplePolyline } from '../math/geometry';
import { type Vec2, distance, dot, scale } from '../math/vec2';
import { MinHeap } from '../routing/minHeap';
import { buildingLabel } from './address';
import { BUS_LENGTH, CROSSWALK_LENGTH } from './constants';
import { districtAt } from './districts';
import type { RailPlan } from './rail';
import { approachDistance } from './roadGeometry';
import { type CityLayout, directionFromNode, railRow } from './roadNetwork';
import type {
  Building,
  BuildingKind,
  BusLine,
  BusStop,
  BusStopCall,
  District,
  EdgeId,
  NodeId,
  RoadNetwork,
  RouteStep,
  Side,
  TransitPlan,
} from './types';

/**
 * Bus network: three lines with fixed routes across the city.
 * - Line 1 runs west → east along the railway street, past both stations.
 * - Line 2 runs north → south through the old town (town hall).
 * - Line 3 runs from the north-west to the industrial south-east, past the
 *   hospital and the mall.
 * Each line is a closed loop: outbound, a turning loop around a block at the
 * far terminus, back on the same streets, and a turning loop at home.
 * Stops come roughly every 300 m; they get a lay-by where the kerb is free
 * (not in the narrow old-town streets), otherwise buses stop in the lane.
 */

const STOP_SPACING = 300;
const MIN_STOP_SPACING = 170;
/** Length of a stopping place (bay or kerb marking). */
export const BUS_STOP_LENGTH = 16;
/** Penalty for turning at a junction, metres: lines prefer straight streets. */
const TURN_PENALTY = 60;
/** Stops keep this far from the tracks (level crossings). */
const RAIL_CLEARANCE = 30;
/** In-lane stops leave this much lane free before the stop line, so traffic can overtake. */
const LANE_STOP_END_ROOM = 27;
/** ...and this much behind the bus for a car waiting to overtake. */
const LANE_STOP_START_ROOM = 14;
/** Stops on the same kerb closer than this are shared between lines. */
const SHARE_DISTANCE = 50;
/** Landmarks within this distance name the stop. */
const LANDMARK_RANGE = 60;

const LINE_COLORS = [0xd8342c, 0x1e6fd0, 0x2e9e4f];
const LANDMARKS: BuildingKind[] = [
  'train_station', 'hospital', 'town_hall', 'mall', 'stadium', 'school', 'sports_hall', 'pool', 'power_plant',
  'bus_depot', 'freight_terminal', 'fire_station', 'police_station', 'supermarket',
];

export function planTransit(
  layout: CityLayout,
  districts: readonly District[],
  buildings: readonly Building[],
  rail: RailPlan,
): TransitPlan {
  const { network, nodeAt } = layout;
  const { cols, rows } = layout.grid;
  const placer = new StopPlacer(network, districts, buildings, rail);
  const nearestNode = (b: Building | undefined): NodeId | null => {
    if (!b) return null;
    const edge = network.edges[b.address.edgeId];
    return b.address.s < edge.length / 2 ? edge.from : edge.to;
  };
  const find = (kind: BuildingKind) => buildings.find((b) => b.kind === kind);

  const rr = railRow(rows);
  const mid = Math.floor((cols - 1) / 2);
  const inset = Math.round((cols - 1) * 0.2);
  const lineWaypoints: NodeId[][] = [
    [nodeAt(rr, 0).id, nodeAt(rr, cols - 1).id],
    [nodeAt(0, mid).id, nearestNode(find('town_hall')), nodeAt(rows - 1, mid).id].filter((n): n is NodeId => n !== null),
    (() => {
      const start = nodeAt(0, inset);
      const end = nodeAt(rows - 1, cols - 1 - inset);
      const via = [find('hospital'), find('mall')]
        .filter((b): b is Building => b !== undefined)
        .sort((a, b) => distance(a.footprint.center, start.pos) - distance(b.footprint.center, start.pos))
        .map((b) => nearestNode(b)!);
      return [start.id, ...via, end.id];
    })(),
  ];

  const lines: BusLine[] = [];
  lineWaypoints.forEach((waypoints, i) => {
    const line = planLine(network, placer, waypoints, i);
    if (line) lines.push(line);
  });
  return { depot: find('bus_depot')?.id ?? null, stops: placer.stops, lines };
}

function planLine(network: RoadNetwork, placer: StopPlacer, waypoints: NodeId[], index: number): BusLine | null {
  // Outbound through the waypoints, never turning back at one of them.
  const outbound: RouteStep[] = [];
  let at = waypoints[0];
  for (const target of waypoints.slice(1)) {
    if (target === at) continue;
    const via = outbound.length ? outbound[outbound.length - 1].edgeId : null;
    const part = findRoute(network, at, via, (node) => node === target);
    if (!part) return null;
    outbound.push(...part);
    at = target;
  }
  if (outbound.length < 2) return null;
  const home = waypoints[0];
  const far = at;
  const back = [...outbound].reverse().map((s) => ({ edgeId: s.edgeId, forward: !s.forward }));
  const firstEdge = outbound[0].edgeId;
  const lastEdge = outbound[outbound.length - 1].edgeId;
  // Turning loops: come back to the terminus node from another street.
  const farLoop = findRoute(network, far, lastEdge, (node, via) => node === far && via !== lastEdge);
  const homeLoop = findRoute(network, home, firstEdge, (node, via) => node === home && via !== firstEdge);
  if (!farLoop || !homeLoop) return null;

  const route = [...outbound, ...farLoop, ...back, ...homeLoop];
  const rollback = placer.checkpoint();
  const backStart = outbound.length + farLoop.length;
  const outCalls = placer.place(route, 0, outbound.length, { first: true, last: true, lead: 0 });
  const backCalls = placer.place(route, backStart, backStart + back.length, { first: false, last: true, lead: STOP_SPACING / 2 });
  if (outCalls.length < 2 || backCalls.length < 1) {
    rollback();
    return null;
  }
  return {
    id: index,
    name: String(index + 1),
    color: LINE_COLORS[index % LINE_COLORS.length],
    route,
    calls: [...outCalls, ...backCalls],
    turnCall: outCalls.length - 1,
  };
}

// ---------------------------------------------------------------------------
// Routing over the street network (for planning only; buses drive lanes)
// ---------------------------------------------------------------------------

/**
 * Shortest path by length plus a turn penalty, without U-turns. `via` is the
 * edge the search arrives on at `start` (null at the very beginning).
 * The goal is tested only after at least one step.
 */
function findRoute(
  network: RoadNetwork,
  start: NodeId,
  via: EdgeId | null,
  isGoal: (node: NodeId, via: EdgeId) => boolean,
): RouteStep[] | null {
  interface State {
    node: NodeId;
    via: EdgeId | null;
    cost: number;
    prev: State | null;
  }
  const key = (node: NodeId, edge: EdgeId | null) => `${node}:${edge}`;
  const best = new Map<string, number>([[key(start, via), 0]]);
  const heap = new MinHeap<State>();
  heap.push({ node: start, via, cost: 0, prev: null }, 0);
  while (heap.size > 0) {
    const state = heap.pop()!;
    if (state.cost > (best.get(key(state.node, state.via)) ?? Infinity)) continue;
    if (state.prev && state.via !== null && isGoal(state.node, state.via)) return unwindRoute(network, state);
    const node = network.nodes[state.node];
    const arriving = state.via !== null ? scale(directionFromNode(network.edges[state.via], state.node), -1) : null;
    for (const edgeId of node.edges) {
      if (edgeId === state.via) continue; // no U-turns
      const edge = network.edges[edgeId];
      if (edge.yard) continue; // container lorries only
      const turn = arriving && dot(arriving, directionFromNode(edge, node.id)) < Math.cos(Math.PI / 6) ? TURN_PENALTY : 0;
      const next = edge.from === node.id ? edge.to : edge.from;
      const cost = state.cost + edge.length + turn;
      const k = key(next, edgeId);
      if (cost >= (best.get(k) ?? Infinity)) continue;
      best.set(k, cost);
      heap.push({ node: next, via: edgeId, cost, prev: state }, cost);
    }
  }
  return null;

  function unwindRoute(net: RoadNetwork, end: State): RouteStep[] {
    const steps: RouteStep[] = [];
    for (let s: State | null = end; s && s.prev; s = s.prev) {
      const edge = net.edges[s.via!];
      steps.unshift({ edgeId: edge.id, forward: edge.to === s.node });
    }
    return steps;
  }
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

interface Window {
  min: number;
  max: number;
}

class StopPlacer {
  readonly stops: BusStop[] = [];
  /** Kerb stretches that must stay free (delivery bays, emergency stations), per `edge:side`. */
  private readonly kerbs = new Map<string, { s: number; half: number; hard: boolean }[]>();

  constructor(
    private readonly network: RoadNetwork,
    private readonly districts: readonly District[],
    private readonly buildings: readonly Building[],
    private readonly rail: RailPlan,
  ) {
    for (const b of buildings) {
      if (b.bay) this.reserve(b.bay.edgeId, b.bay.side, b.bay.s, b.bay.length / 2, false);
      if (b.kind === 'fire_station' || b.kind === 'police_station') {
        this.reserve(b.address.edgeId, b.address.side, b.address.s, b.footprint.halfW + 14, true);
      }
    }
  }

  private reserve(edgeId: EdgeId, side: Side, s: number, half: number, hard: boolean): void {
    const k = `${edgeId}:${side}`;
    this.kerbs.set(k, [...(this.kerbs.get(k) ?? []), { s, half, hard }]);
  }

  /**
   * Stops along `route[from..to)`, about every STOP_SPACING metres. `first` /
   * `last` force a stop on the first / last street (termini); `lead` is the
   * distance already travelled since the previous stop at the start.
   */
  place(route: RouteStep[], from: number, to: number, options: { first: boolean; last: boolean; lead: number }): BusStopCall[] {
    const calls: BusStopCall[] = [];
    let travelled = 0;
    let lastStop = -options.lead;
    for (let i = from; i < to; i++) {
      const step = route[i];
      const edge = this.network.edges[step.edgeId];
      // A terminus that does not fit on its street moves to the next one.
      const first = options.first && calls.length === 0;
      const forced = first || (options.last && i === to - 1);
      const target = lastStop + STOP_SPACING;
      const windows = this.windows(step);
      const reach = Math.max(windows.bay?.max ?? -Infinity, windows.lane?.max ?? -Infinity);
      if (reach > -Infinity && (forced || travelled + reach >= target)) {
        const stop = this.stopOn(step, windows, first ? null : target - travelled, forced);
        if (stop && calls[calls.length - 1]?.stop !== stop.stop.id && (forced || travelled + stop.t - lastStop >= MIN_STOP_SPACING)) {
          calls.push({ stop: this.commit(stop.stop).id, step: i });
          lastStop = travelled + stop.t;
        }
      }
      travelled += edge.length;
    }
    return calls;
  }

  /**
   * Ranges of positions (distance in the direction of travel) where a lay-by
   * fits, and where an in-lane stop leaves room to overtake the bus.
   */
  private windows(step: RouteStep): { bay: Window | null; lane: Window | null } {
    const edge = this.network.edges[step.edgeId];
    const start = this.network.nodes[step.forward ? edge.from : edge.to];
    const end = this.network.nodes[step.forward ? edge.to : edge.from];
    const margin = BUS_STOP_LENGTH / 2 + CROSSWALK_LENGTH + 4;
    const bay = { min: start.clearance + margin, max: edge.length - end.clearance - margin };
    const lane = {
      min: Math.max(bay.min, approachDistance(start) + LANE_STOP_START_ROOM + BUS_LENGTH / 2),
      max: Math.min(bay.max, edge.length - approachDistance(end) - LANE_STOP_END_ROOM - BUS_LENGTH / 2),
    };
    return { bay: bay.min <= bay.max ? bay : null, lane: lane.min <= lane.max ? lane : null };
  }

  /**
   * A stop near distance `wanted` along the step (null: the middle): an
   * existing stop on this kerb, a lay-by where allowed, else an in-lane stop.
   */
  private stopOn(
    step: RouteStep,
    windows: { bay: Window | null; lane: Window | null },
    wanted: number | null,
    terminus: boolean,
  ): { stop: BusStop; t: number } | null {
    const edge = this.network.edges[step.edgeId];
    const toS = (t: number) => (step.forward ? t : edge.length - t);
    const pick = (w: Window) => (wanted === null ? (w.min + w.max) / 2 : clamp(wanted, w.min, w.max));
    for (const kind of ['bay', 'lane'] as const) {
      const w = windows[kind];
      if (!w) continue;
      for (const t of [pick(w), w.min, (w.min + w.max) / 2, w.max]) {
        const found = this.tryAt(kind, step, t, toS(t), terminus);
        if (found) return found;
      }
    }
    return null;
  }

  private tryAt(kind: 'bay' | 'lane', step: RouteStep, t: number, s: number, terminus: boolean): { stop: BusStop; t: number } | null {
    const edge = this.network.edges[step.edgeId];
    const side: Side = step.forward ? 1 : -1;
    {
      const shared = this.stops.find((x) => x.edgeId === edge.id && x.side === side && Math.abs(x.s - s) < SHARE_DISTANCE);
      if (shared) return { stop: shared, t: step.forward ? shared.s : edge.length - shared.s };
      const point = samplePolyline(edge.points, s).point;
      if (this.rail.tracks.some((track) => distanceToPolyline(point, track.points) < RAIL_CLEARANCE)) return null;
      const kerb = this.kerbs.get(`${edge.id}:${side}`) ?? [];
      const overlaps = kerb.filter((k) => Math.abs(k.s - s) < k.half + BUS_STOP_LENGTH / 2 + 2);
      if (overlaps.some((k) => k.hard)) return null;
      if (kind === 'bay') {
        // Lay-bys need a free kerb; the old town's streets are too narrow for them.
        const oldTown = this.districts[districtAt(this.districts, point)].kind === 'old_town';
        if (overlaps.length > 0 || (oldTown && !terminus)) return null;
      }
      const stop: BusStop = { id: -1, name: this.name(edge.id, s, point), edgeId: edge.id, side, s, length: BUS_STOP_LENGTH, bay: kind === 'bay' };
      return { stop, t };
    }
  }

  /** Undo point: a line that turns out unusable leaves no stops behind. */
  checkpoint(): () => void {
    const count = this.stops.length;
    const kerbs = new Map([...this.kerbs].map(([k, v]) => [k, [...v]]));
    return () => {
      this.stops.length = count;
      this.kerbs.clear();
      for (const [k, v] of kerbs) this.kerbs.set(k, v);
    };
  }

  private commit(stop: BusStop): BusStop {
    if (stop.id >= 0) return stop;
    const committed = { ...stop, id: this.stops.length };
    this.stops.push(committed);
    this.reserve(committed.edgeId, committed.side, committed.s, BUS_STOP_LENGTH / 2, false);
    return committed;
  }

  /** A nearby landmark, otherwise "Street / Cross Street". */
  private name(edgeId: EdgeId, s: number, point: Vec2): string {
    let landmark: Building | null = null;
    let bestDistance = LANDMARK_RANGE;
    for (const b of this.buildings) {
      if (!LANDMARKS.includes(b.kind)) continue;
      const d = distance(b.footprint.center, point) - Math.max(b.footprint.halfW, b.footprint.halfD);
      if (d < bestDistance) {
        bestDistance = d;
        landmark = b;
      }
    }
    if (landmark) return buildingLabel(landmark);
    const edge = this.network.edges[edgeId];
    const node = this.network.nodes[s < edge.length / 2 ? edge.from : edge.to];
    const cross = node.edges.map((id) => this.network.edges[id].name).find((n) => n !== edge.name);
    return cross ? `${edge.name} / ${cross}` : edge.name;
  }
}

function clamp(x: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, x));
}
