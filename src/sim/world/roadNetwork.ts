import { polygonCentroid, polylineLength, quadraticBezier } from '../math/geometry';
import type { Rng } from '../math/rng';
import { type Vec2, add, dot, lerp, normalize, rightOf, scale, sub, vec2 } from '../math/vec2';
import { STREET_CLEARANCE } from './constants';
import type { EdgeId, Park, RoadEdge, RoadNetwork, RoadNode, Side } from './types';

/**
 * The city is a jittered grid of intersections with a few irregularities:
 * two removed segments (one leaves room for a park), a handful of curved
 * streets and one diagonal street.
 *
 * Edge keys: `h:r:c` joins (r,c)–(r,c+1), `v:r:c` joins (r,c)–(r+1,c).
 */
const COLS = 5;
const ROWS = 4;
const SPACING_X = 96;
const SPACING_Z = 84;
const JITTER = 6;

const REMOVED_EDGES = new Set(['h:2:1', 'v:1:3']);

/** Bezier control-point offset; the road bends by roughly half of it. */
const CURVED_EDGES: Record<string, number> = {
  'v:0:1': 18,
  'h:0:3': -16,
  'v:2:3': 16,
  'h:3:2': -20,
};

/** Diagonal street cutting one block in half. */
const DIAGONAL: { from: [number, number]; to: [number, number] } = { from: [1, 2], to: [2, 3] };

/** The park fills the block that opens up after removing `h:2:1`. */
const PARK_CORNERS: [number, number][] = [
  [1, 1],
  [1, 2],
  [3, 2],
  [3, 1],
];

/** Street names for grid rows (east–west) and columns (north–south). */
const ROW_NAMES = ['Northgate Rd', 'Linden St', 'Market St', 'Riverside Rd'];
const COL_NAMES = ['West Ave', 'Chestnut Ave', 'Church St', 'Mill St', 'East Ave'];
const DIAGONAL_NAME = 'Old Town Way';

const FIRE_STATION_SITE = { key: 'h:2:3', side: -1 as Side };
const POLICE_STATION_SITE = { key: 'h:1:0', side: 1 as Side };

export interface StationSite {
  edgeId: EdgeId;
  side: Side;
}

export interface CityLayout {
  network: RoadNetwork;
  parks: Park[];
  stationSites: { fire: StationSite; police: StationSite };
}

export function generateRoadLayout(rng: Rng): CityLayout {
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const edgeByKey = new Map<string, EdgeId>();
  const nodeAt = (r: number, c: number) => nodes[r * COLS + c];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = (c - (COLS - 1) / 2) * SPACING_X + rng.range(-JITTER, JITTER);
      const z = (r - (ROWS - 1) / 2) * SPACING_Z + rng.range(-JITTER, JITTER);
      nodes.push({ id: nodes.length, pos: vec2(x, z), edges: [], signalized: false, clearance: 0 });
    }
  }

  const addEdge = (key: string, name: string, from: RoadNode, to: RoadNode, bend = 0) => {
    const points = bend === 0 ? [from.pos, to.pos] : bentLine(from.pos, to.pos, bend);
    const id = edges.length;
    edges.push({ id, name, from: from.id, to: to.id, points, length: polylineLength(points) });
    from.edges.push(id);
    to.edges.push(id);
    edgeByKey.set(key, id);
  };

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const h = `h:${r}:${c}`;
      if (c < COLS - 1 && !REMOVED_EDGES.has(h)) addEdge(h, ROW_NAMES[r], nodeAt(r, c), nodeAt(r, c + 1), CURVED_EDGES[h]);
      const v = `v:${r}:${c}`;
      if (r < ROWS - 1 && !REMOVED_EDGES.has(v)) addEdge(v, COL_NAMES[c], nodeAt(r, c), nodeAt(r + 1, c), CURVED_EDGES[v]);
    }
  }
  addEdge('diagonal', DIAGONAL_NAME, nodeAt(...DIAGONAL.from), nodeAt(...DIAGONAL.to));

  for (const node of nodes) {
    node.signalized = node.edges.length >= 3;
    node.clearance = nodeClearance(node, edges);
  }

  const parkPolygon = PARK_CORNERS.map(([r, c]) => nodeAt(r, c).pos);
  const site = ({ key, side }: { key: string; side: Side }): StationSite => {
    const edgeId = edgeByKey.get(key);
    if (edgeId === undefined) throw new Error(`Station site edge ${key} does not exist`);
    return { edgeId, side };
  };

  return {
    network: { nodes, edges },
    parks: [{ polygon: parkPolygon, pond: { center: polygonCentroid(parkPolygon), radius: 11 } }],
    stationSites: { fire: site(FIRE_STATION_SITE), police: site(POLICE_STATION_SITE) },
  };
}

/** Unit direction in which `edge` leaves `nodeId`. */
export function directionFromNode(edge: RoadEdge, nodeId: number): Vec2 {
  const pts = edge.points;
  return edge.from === nodeId
    ? normalize(sub(pts[1], pts[0]))
    : normalize(sub(pts[pts.length - 2], pts[pts.length - 1]));
}

/**
 * Two roads meeting at angle θ stay overlapping (including sidewalks) up to
 * STREET_CLEARANCE / tan(θ/2) from the node. Right angles give STREET_CLEARANCE.
 */
function nodeClearance(node: RoadNode, edges: readonly RoadEdge[]): number {
  const dirs = node.edges.map((id) => directionFromNode(edges[id], node.id));
  let clearance = STREET_CLEARANCE;
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot(dirs[i], dirs[j]))));
      if (angle < Math.PI / 2) clearance = Math.max(clearance, STREET_CLEARANCE / Math.tan(angle / 2));
    }
  }
  return clearance;
}

function bentLine(a: Vec2, b: Vec2, bend: number): Vec2[] {
  const control = add(lerp(a, b, 0.5), scale(rightOf(normalize(sub(b, a))), bend));
  return quadraticBezier(a, control, b, 16);
}
