import { type OBB, obbAxes, projectOnPolyline, samplePolyline } from '../math/geometry';
import { type Vec2, add, dot, rightOf, scale } from '../math/vec2';
import { STREET_CLEARANCE } from './constants';
import { connectNodes, splitEdge } from './edgeSplit';
import { approachDistance } from './roadGeometry';
import type { CityLayout } from './roadNetwork';
import type { Building, EdgeId, RoadEdge, RoadNode } from './types';

/**
 * Stadium car park (v3 feature 2), as the user drew it: one gate in the middle of the street
 * the car park shares with the stadium, a short two-way access road to the front row, and a
 * one-way loop round a grass island (in on the right, round anticlockwise, out on the
 * right). Cars park along the loop's outer kerb (on the right of the driving direction), not
 * on the bends. The loop is two edges, gate → back middle → gate, so no car can go round and
 * round; only right turns lead between the car park and the street.
 */

/** Width of the parking strip along the outer kerb, and the grass between it and the plot edge, m. */
export const PARKING_STRIP = 2.8;
export const PLOT_MARGIN = 1;
/** Lane half width (one-way loop lane on its centre line). */
const LANE_HALF = 2;
/** Loop centre line inset from the plot edge. */
export const LOOP_INSET = PLOT_MARGIN + PARKING_STRIP + LANE_HALF;
/** Radius of the loop's rounded corners, m. */
export const CORNER_RADIUS = 5;
/** Junction size at the gate and at the back of the loop (tight, slow car park turns), m. */
const GATE_CLEARANCE = 4.5;
/**
 * The loop's front row stands this much further from the street than its other sides, so
 * the access road holds two or three cars waiting to leave (with a 7 m road, the tail of a
 * car queuing there hung back over the gate onto the loop).
 */
const GATE_SETBACK = 6;
const BACK_CLEARANCE = 0.5;
/** Shortest street lane left either side of the gate's T-junction, m. */
const MIN_STREET_LANE = 5;
/** Smallest plot the loop fits in (half extents), m. */
const MIN_HALF = 22;

/** The loop in world coordinates for a car park plot whose local +z faces the gate street. */
export interface LoopLayout {
  /** Gate: middle of the front row, where the access road meets the loop. */
  gate: Vec2;
  /** Into the car park from the street (local −z) and along the front row towards the first bend (the entry side). */
  inward: Vec2;
  along: Vec2;
  /** Half extents of the loop centre line's rectangle, before rounding the corners. */
  halfWidth: number;
  halfDepth: number;
  /** Rectangle centre. */
  centre: Vec2;
}

export function loopLayout(plot: OBB): LoopLayout | null {
  if (plot.halfW < MIN_HALF || plot.halfD < MIN_HALF) return null;
  const [ax, az] = obbAxes(plot.rotation);
  const inward = scale(az, -1);
  const along = rightOf(inward); // turning right after coming in
  const halfWidth = plot.halfW - LOOP_INSET;
  const halfDepth = plot.halfD - LOOP_INSET - GATE_SETBACK / 2;
  const centre = add(plot.center, scale(inward, GATE_SETBACK / 2));
  // (Guard against a mirrored frame: `along` must be ±local x.)
  if (Math.abs(dot(along, ax)) < 0.99) return null;
  return { gate: add(centre, scale(az, halfDepth)), inward, along, halfWidth, halfDepth, centre };
}

/**
 * The two halves of the loop as polylines with rounded corners: gate → entry-side bends →
 * back middle, and back middle → other bends → gate.
 */
export function loopHalves(l: LoopLayout): [Vec2[], Vec2[]] {
  const at = (x: number, z: number) => add(l.centre, add(scale(l.along, x), scale(l.inward, -z)));
  const W = l.halfWidth;
  const D = l.halfDepth;
  const r = Math.min(CORNER_RADIUS, W - 1, D - 1);
  // Quarter circle round (cx, cz) from `from` to `from + 90°` (angles in the local x/z plane).
  const corner = (cx: number, cz: number, from: number): Vec2[] => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = from + (i / 6) * (Math.PI / 2);
      pts.push(at(cx + Math.cos(t) * r, cz + Math.sin(t) * r));
    }
    return pts;
  };
  // Local frame here: x along `along`, z towards the street (front row at z = +D).
  // Each bend is walked from the larger angle to the smaller one (clockwise in x/z = the loop's way round).
  const first = [at(0, D), ...corner(W - r, D - r, 0).reverse(), ...corner(W - r, -D + r, -Math.PI / 2).reverse(), at(0, -D)];
  const second = [at(0, -D), ...corner(-W + r, -D + r, -Math.PI).reverse(), ...corner(-W + r, D - r, Math.PI / 2).reverse(), at(0, D)];
  return [first, second];
}

/** Pavement between the loop lane's inner edge and the stadium on the island, m. */
const ISLAND_PAVEMENT = 2;
/** Smallest stadium (half extents) on the island, m: with two tiers of stands the pitch is still ~20 m. */
export const MIN_STADIUM_HALF = 20;

/** The stadium's footprint on the island inside the loop, or null when the island is too small. */
export function stadiumIsland(l: LoopLayout, plot: OBB): OBB | null {
  const halfW = l.halfWidth - LANE_HALF - ISLAND_PAVEMENT;
  const halfD = l.halfDepth - LANE_HALF - ISLAND_PAVEMENT;
  if (halfW < MIN_STADIUM_HALF || halfD < MIN_STADIUM_HALF) return null;
  return { center: l.centre, halfW, halfD, rotation: plot.rotation };
}

/** Where the gate meets the street, or null when the street lanes either side would be too short. */
export function planGate(layout: CityLayout, nearId: EdgeId, plot: OBB): number | null {
  const { edges, nodes } = layout.network;
  const near = edges[nearId];
  const s = projectOnPolyline(near.points, plot.center);
  const lane = (to: RoadNode, d: number) => d - approachDistance(to) - STREET_CLEARANCE;
  if (lane(nodes[near.from], s) < MIN_STREET_LANE || lane(nodes[near.to], near.length - s) < MIN_STREET_LANE) return null;
  return s;
}

/** Splits the street at the gate and adds the access road and the two loop halves. Returns the new edges. */
export function buildLoop(layout: CityLayout, nearId: EdgeId, gateS: number, loop: LoopLayout, buildings: Building[]): RoadEdge[] {
  const { nodes } = layout.network;
  const t = splitEdge(layout, nearId, gateS, buildings).node;
  const node = (pos: Vec2): number => {
    const n: RoadNode = { id: nodes.length, pos, edges: [], signalized: false, clearance: 0 };
    nodes.push(n);
    return n.id;
  };
  const [first, second] = loopHalves(loop);
  const gate = node(first[0]);
  const back = node(first[first.length - 1]);
  const props = { name: 'Stadium Car Park', carPark: true } as const;
  const access = connectNodes(layout, t, gate, props);
  const half1 = connectNodes(layout, gate, back, { ...props, oneWay: true });
  const half2 = connectNodes(layout, back, gate, { ...props, oneWay: true });
  half1.points = first;
  half2.points = second;
  for (const e of [half1, half2]) e.length = polyLength(e.points);
  // (connectNodes measured straight lines; the access road is straight.)
  nodes[gate].clearance = GATE_CLEARANCE;
  nodes[back].clearance = BACK_CLEARANCE;
  return [access, half1, half2];
}

function polyLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return total;
}

/** Length of one kerb parking space, m (fits a 5.2 m van with room to pull in and out). */
export const SPACE_LENGTH = 6.5;
/** Spaces start this far past the start of a loop half (clear of the gate), m. */
const SPACES_FROM = 3;
/** No space within this many metres of a bend (both ends of a space on a straight). */
const BEND_CLEARANCE = 0.5;

/**
 * Kerb spaces along a one-way loop half, as distances along its centre line where a parked
 * car's front bumper is, only where the whole space lies on a straight. `start` / `end`: how
 * far in from the edge's ends the lane runs (junction clearances).
 */
export function loopSpaceFronts(points: readonly Vec2[], start: number, end: number): number[] {
  const total = polyLength(points);
  const straight = (s0: number, s1: number) => {
    const a = samplePolyline(points, s0).dir;
    const b = samplePolyline(points, s1).dir;
    const c = samplePolyline(points, (s0 + s1) / 2).dir;
    return dot(a, b) > 0.999 && dot(a, c) > 0.999;
  };
  const out: number[] = [];
  let front = start + SPACES_FROM + SPACE_LENGTH;
  while (front <= total - end - 1) {
    if (straight(front - SPACE_LENGTH - BEND_CLEARANCE, front + BEND_CLEARANCE)) {
      out.push(front);
      front += SPACE_LENGTH;
    } else front += 0.5;
  }
  return out;
}
