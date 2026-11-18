import { cubicBezier, polylineDistance, polylineLength, samplePolyline } from '../math/geometry';
import { type Vec2, add, distance, normalize, rightOf, scale, sub } from '../math/vec2';
import { LANE_WIDTH } from '../world/constants';
import { approachDistance } from '../world/roadGeometry';
import type { EdgeId, NodeId, RoadNetwork } from '../world/types';

/**
 * Drivable topology derived from the road network:
 * - a **lane** per edge direction, between the two stop lines,
 * - a **connector** per allowed movement through an intersection
 *   (incoming lane → outgoing lane, no U-turns).
 * Vehicles always drive on exactly one segment (lane or connector).
 */

export type SegmentId = number;
export type Turn = 'straight' | 'left' | 'right';

/** Lane speed limit (45 km/h). */
export const LANE_SPEED_LIMIT = 12.5;
/** Speed limit in the stadium car park (about 20 km/h), m/s. */
export const CAR_PARK_SPEED_LIMIT = 6;
const STRAIGHT_SPEED_LIMIT = 10;
/**
 * Two connectors closer than this (centre line to centre line) could let
 * vehicles touch. Sized for the fire engine, whose long body cuts inside
 * tight turns.
 */
const CONFLICT_DISTANCE = 3.4;
/** Same, for movements where a bus or an articulated lorry is involved (they cut further inside). */
const LONG_CONFLICT_DISTANCE = 5.5;

interface SegmentBase {
  id: SegmentId;
  points: Vec2[];
  length: number;
  speedLimit: number;
}

export interface Lane extends SegmentBase {
  kind: 'lane';
  edgeId: EdgeId;
  /** true when driving from edge.from to edge.to. */
  forward: boolean;
  fromNode: NodeId;
  toNode: NodeId;
  outConnectors: SegmentId[];
  /** On the stadium car park's aisles (kerb spaces for fans). */
  carPark: boolean;
  /** On the private Dockside yard road (container lorries only). */
  yard: boolean;
}

export interface Connector extends SegmentBase {
  kind: 'connector';
  nodeId: NodeId;
  fromLane: SegmentId;
  toLane: SegmentId;
  turn: Turn;
  /** Connectors that may not be used at the same time as this one. */
  conflicts: SegmentId[];
  /** Extra connectors that conflict when one of the two vehicles is long (bus, lorry). */
  longConflicts: SegmentId[];
}

export type Segment = Lane | Connector;

export interface LaneGraph {
  segments: Segment[];
  lanes: Lane[];
  connectors: Connector[];
}

export function buildLaneGraph(network: RoadNetwork): LaneGraph {
  const segments: Segment[] = [];
  const lanes: Lane[] = [];
  const connectors: Connector[] = [];

  for (const edge of network.edges) {
    const start = approachDistance(network.nodes[edge.from]);
    const end = edge.length - approachDistance(network.nodes[edge.to]);
    // One-way roads (the yard road, the car park loop): a single lane on the centre line.
    const oneWay = edge.yard || edge.oneWay;
    for (const forward of oneWay ? [true] : [true, false]) {
      const lateral = oneWay ? 0 : (LANE_WIDTH / 2) * (forward ? 1 : -1);
      const count = Math.max(2, Math.ceil((end - start) / 2));
      const points: Vec2[] = [];
      for (let i = 0; i <= count; i++) {
        const { point, dir } = samplePolyline(edge.points, start + ((end - start) * i) / count);
        points.push(add(point, scale(rightOf(dir), lateral)));
      }
      if (!forward) points.reverse();
      const lane: Lane = {
        kind: 'lane',
        id: segments.length,
        edgeId: edge.id,
        forward,
        fromNode: forward ? edge.from : edge.to,
        toNode: forward ? edge.to : edge.from,
        points,
        length: polylineLength(points),
        speedLimit: edge.carPark ? CAR_PARK_SPEED_LIMIT : LANE_SPEED_LIMIT,
        outConnectors: [],
        yard: !!edge.yard,
        carPark: !!edge.carPark,
      };
      segments.push(lane);
      lanes.push(lane);
    }
  }

  for (const node of network.nodes) {
    const incoming = lanes.filter((l) => l.toNode === node.id);
    const outgoing = lanes.filter((l) => l.fromNode === node.id);
    const atNode: Connector[] = [];
    for (const from of incoming) {
      for (const to of outgoing) {
        if (from.edgeId === to.edgeId) continue; // no U-turns
        const connector = makeConnector(segments.length, node.id, from, to);
        // Between a street and the yard only by turning right, out of the car park too (nobody
        // waits across the street); into the car park also by turning left (the gate is mid-block,
        // with room to wait on either side). Inside the car park, only the turns the loop is drawn with.
        const intoCarPark = to.carPark && !from.carPark;
        if ((from.yard !== to.yard || from.carPark !== to.carPark) && connector.turn !== 'right' && !(intoCarPark && connector.turn === 'left')) continue;
        // (At the car park gate: in from the access road, out onto it; never round the loop again.)
        if (from.carPark && to.carPark && node.edges.length >= 3 && connector.turn !== 'right') continue;
        segments.push(connector);
        connectors.push(connector);
        atNode.push(connector);
        from.outConnectors.push(connector.id);
      }
    }
    for (const a of atNode) {
      for (const b of atNode) {
        if (a === b) continue;
        if (connectorsConflict(a, b)) a.conflicts.push(b.id);
        else if (a.fromLane !== b.fromLane && polylineDistance(a.points, b.points) < LONG_CONFLICT_DISTANCE) a.longConflicts.push(b.id);
      }
    }
  }

  return { segments, lanes, connectors };
}

function makeConnector(id: SegmentId, nodeId: NodeId, from: Lane, to: Lane): Connector {
  const p0 = from.points[from.points.length - 1];
  const d0 = normalize(sub(p0, from.points[from.points.length - 2]));
  const p3 = to.points[0];
  const d3 = normalize(sub(to.points[1], p3));

  const cross = d0.x * d3.z - d0.z * d3.x;
  const dotP = d0.x * d3.x + d0.z * d3.z;
  const angle = Math.atan2(cross, dotP);
  // +x east, +z south: a positive cross product is a right turn.
  const turn: Turn = Math.abs(angle) < Math.PI / 6 ? 'straight' : angle > 0 ? 'right' : 'left';

  const chord = distance(p0, p3);
  const k = chord * (turn === 'straight' ? 0.33 : 0.42);
  const points = cubicBezier(p0, add(p0, scale(d0, k)), sub(p3, scale(d3, k)), p3, 12);

  let speedLimit = STRAIGHT_SPEED_LIMIT;
  if (turn !== 'straight') {
    const radius = chord / (2 * Math.sin(Math.abs(angle) / 2));
    speedLimit = Math.min(9, Math.max(4, Math.sqrt(3 * radius)));
  }

  return {
    kind: 'connector',
    id,
    nodeId,
    fromLane: from.id,
    toLane: to.id,
    turn,
    points,
    length: polylineLength(points),
    speedLimit,
    conflicts: [],
    longConflicts: [],
  };
}

function connectorsConflict(a: Connector, b: Connector): boolean {
  if (a.fromLane === b.fromLane) return false; // same queue; car-following handles it
  if (a.toLane === b.toLane) return true; // merging into the same lane
  return polylineDistance(a.points, b.points) < CONFLICT_DISTANCE;
}
