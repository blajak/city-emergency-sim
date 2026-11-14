import { polygonCentroid, polylineLength, quadraticBezier } from '../math/geometry';
import type { Rng } from '../math/rng';
import { type Vec2, add, dot, lerp, normalize, rightOf, scale, sub, vec2 } from '../math/vec2';
import { STREET_CLEARANCE } from './constants';
import type { EdgeId, Park, RoadEdge, RoadNetwork, RoadNode, Side } from './types';

/**
 * The city is a jittered grid of intersections with a few irregularities:
 * two removed segments (one leaves room for a park), a handful of curved
 * streets and one diagonal street. Larger scales extend the grid and add
 * random curves, removed segments and parks outside the original area.
 *
 * Edge keys: `h:r:c` joins (r,c)–(r,c+1), `v:r:c` joins (r,c)–(r+1,c).
 */
const BASE_COLS = 5;
const BASE_ROWS = 4;
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

/** Street names for grid rows (east–west) and columns (north–south). The first ones are the v1 town. */
const ROW_NAMES = [
  'Northgate Rd', 'Linden St', 'Market St', 'Riverside Rd', 'Harbour St', 'Elm St', 'Station Rd',
  'Orchard Ln', 'Bridge St', 'Mill Rd', 'Castle St', 'Meadow Ln', 'King St', 'Garden St',
];
const COL_NAMES = [
  'West Ave', 'Chestnut Ave', 'Church St', 'Mill St', 'East Ave', 'Maple Ave', 'Oak St', 'Hill St',
  'Park Ave', 'Union St', 'Willow St', 'Cedar Ave', 'Forge St', 'Abbey St', 'Copper Ln', 'Lake Ave',
  'Spring St', 'Granary St',
];
const DIAGONAL_NAME = 'Old Town Way';

const FIRE_STATION_SITE = { key: 'h:2:3', side: -1 as Side };
const POLICE_STATION_SITE = { key: 'h:1:0', side: 1 as Side };

export interface StationSite {
  edgeId: EdgeId;
  side: Side;
}

/** A grid cell between four intersections. */
export interface Block {
  r: number;
  c: number;
  /** Corners in order NW, NE, SE, SW. */
  corners: [Vec2, Vec2, Vec2, Vec2];
  /** Bordering streets: undefined when the segment was removed. */
  sides: { north?: EdgeId; south?: EdgeId; west?: EdgeId; east?: EdgeId };
  /** All four sides exist and are straight: the block can host a large site. */
  regular: boolean;
  /** The railway runs through this block. */
  rail: boolean;
  park: boolean;
}

export interface CityLayout {
  network: RoadNetwork;
  parks: Park[];
  stationSites: { fire: StationSite; police: StationSite };
  blocks: Block[];
  /** Centre line of the railway corridor, west to east through the middle row of blocks. */
  railCorridor: Vec2[];
}

/** Row of blocks the railway runs through (between grid rows `r` and `r + 1`). */
export function railRow(rows: number): number {
  return Math.floor((rows - 1) / 2);
}

/** Extends the railway this far beyond the outermost streets (into the map margin). */
const RAIL_OVERHANG = 48;

/** Grid size for a scale factor: road count grows roughly linearly with `scale`. */
export function gridSize(scale: number): { cols: number; rows: number } {
  const k = Math.sqrt(Math.max(1, scale));
  return {
    cols: Math.min(COL_NAMES.length, Math.max(BASE_COLS, Math.round(4.5 * k))),
    rows: Math.min(ROW_NAMES.length, Math.max(BASE_ROWS, Math.round(3.5 * k))),
  };
}

export function generateRoadLayout(rng: Rng, sizeScale = 1): CityLayout {
  const { cols: COLS, rows: ROWS } = gridSize(sizeScale);
  const nodes: RoadNode[] = [];
  const edges: RoadEdge[] = [];
  const edgeByKey = new Map<string, EdgeId>();
  const nodeAt = (r: number, c: number) => nodes[r * COLS + c];
  const extras = COLS > BASE_COLS || ROWS > BASE_ROWS ? randomExtras(rng, COLS, ROWS, sizeScale, railRow(ROWS)) : null;
  const removed = new Set([...REMOVED_EDGES, ...(extras?.removed ?? [])]);
  const curved: Record<string, number> = { ...CURVED_EDGES, ...(extras?.curved ?? {}) };

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
      if (c < COLS - 1 && !removed.has(h)) addEdge(h, ROW_NAMES[r], nodeAt(r, c), nodeAt(r, c + 1), curved[h]);
      const v = `v:${r}:${c}`;
      if (r < ROWS - 1 && !removed.has(v)) addEdge(v, COL_NAMES[c], nodeAt(r, c), nodeAt(r + 1, c), curved[v]);
    }
  }
  addEdge('diagonal', DIAGONAL_NAME, nodeAt(...DIAGONAL.from), nodeAt(...DIAGONAL.to));

  for (const node of nodes) {
    node.signalized = node.edges.length >= 3;
    node.clearance = nodeClearance(node, edges);
  }

  const park = (corners: [number, number][]): Park => {
    const polygon = corners.map(([r, c]) => nodeAt(r, c).pos);
    return { polygon, pond: { center: polygonCentroid(polygon), radius: 11 } };
  };
  const extraParks = (extras?.parks ?? []).map(([r, c]) => park([[r, c], [r, c + 1], [r + 1, c + 1], [r + 1, c]]));
  const site = ({ key, side }: { key: string; side: Side }): StationSite => {
    const edgeId = edgeByKey.get(key);
    if (edgeId === undefined) throw new Error(`Station site edge ${key} does not exist`);
    return { edgeId, side };
  };

  // Blocks.
  const parkCells = new Set([
    ...[[1, 1], [2, 1]].map(([r, c]) => `${r}:${c}`), // the v1 park spans two cells
    ...(extras?.parks ?? []).map(([r, c]) => `${r}:${c}`),
  ]);
  const rr = railRow(ROWS);
  const blocks: Block[] = [];
  for (let r = 0; r < ROWS - 1; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const sides = {
        north: edgeByKey.get(`h:${r}:${c}`),
        south: edgeByKey.get(`h:${r + 1}:${c}`),
        west: edgeByKey.get(`v:${r}:${c}`),
        east: edgeByKey.get(`v:${r}:${c + 1}`),
      };
      const keys = [`h:${r}:${c}`, `h:${r + 1}:${c}`, `v:${r}:${c}`, `v:${r}:${c + 1}`];
      const diagonal = r === DIAGONAL.from[0] && c === DIAGONAL.from[1];
      blocks.push({
        r,
        c,
        corners: [nodeAt(r, c).pos, nodeAt(r, c + 1).pos, nodeAt(r + 1, c + 1).pos, nodeAt(r + 1, c).pos],
        sides,
        regular: !diagonal && keys.every((k) => edgeByKey.has(k) && !(k in curved)),
        rail: r === rr,
        park: parkCells.has(`${r}:${c}`),
      });
    }
  }

  // Railway: through the middle of the block row `rr`, crossing each north–south street once.
  const railCorridor: Vec2[] = [];
  for (let c = 0; c < COLS; c++) railCorridor.push(lerp(nodeAt(rr, c).pos, nodeAt(rr + 1, c).pos, 0.5));
  const first = railCorridor[0];
  const last = railCorridor[railCorridor.length - 1];
  railCorridor.unshift(add(first, scale(normalize(sub(first, railCorridor[1])), RAIL_OVERHANG)));
  railCorridor.push(add(last, scale(normalize(sub(last, railCorridor[railCorridor.length - 2])), RAIL_OVERHANG)));

  return {
    network: { nodes, edges },
    parks: [park(PARK_CORNERS), ...extraParks],
    stationSites: { fire: site(FIRE_STATION_SITE), police: site(POLICE_STATION_SITE) },
    blocks,
    railCorridor,
  };
}

/**
 * Variety for grids bigger than the v1 town, only outside its area so the
 * original streets keep their shape: some curved streets, a few removed
 * segments (never two at one intersection) and extra one-block parks.
 */
function randomExtras(rng: Rng, cols: number, rows: number, scale: number, railRowIndex: number) {
  const outside = (r: number, c: number) => r >= BASE_ROWS || c >= BASE_COLS;
  const interior = (r: number, c: number) => r > 0 && c > 0 && r < rows - 1 && c < cols - 1;
  const removed: string[] = [];
  const curved: Record<string, number> = {};
  const touched = new Set<string>();
  const node = (r: number, c: number) => `${r}:${c}`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (const [key, r2, c2] of [
        [`h:${r}:${c}`, r, c + 1],
        [`v:${r}:${c}`, r + 1, c],
      ] as const) {
        if (r2 >= rows || c2 >= cols || !outside(r, c) || !outside(r2, c2)) continue;
        if (interior(r, c) && interior(r2, c2) && !touched.has(node(r, c)) && !touched.has(node(r2, c2)) && rng.chance(0.05)) {
          removed.push(key);
          touched.add(node(r, c));
          touched.add(node(r2, c2));
        } else if (rng.chance(0.1)) {
          curved[key] = (rng.chance(0.5) ? 1 : -1) * rng.range(14, 20);
        }
      }
    }
  }

  // Parks: whole blocks with all four sides present and straight.
  const parks: [number, number][] = [];
  const wanted = Math.floor(scale / 2.5);
  for (let attempt = 0; attempt < 200 && parks.length < wanted; attempt++) {
    const r = rng.int(0, rows - 2);
    const c = rng.int(0, cols - 2);
    if (!outside(r, c) || r === railRowIndex) continue;
    if (parks.some(([pr, pc]) => Math.abs(pr - r) < 3 && Math.abs(pc - c) < 3)) continue;
    const sides = [`h:${r}:${c}`, `h:${r + 1}:${c}`, `v:${r}:${c}`, `v:${r}:${c + 1}`];
    if (sides.some((k) => removed.includes(k) || k in curved)) continue;
    parks.push([r, c]);
  }
  return { removed, curved, parks };
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
