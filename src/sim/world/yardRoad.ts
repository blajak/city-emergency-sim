import { intersectPolylines, samplePolyline } from '../math/geometry';
import { add, dot, normalize, rightOf, scale, sub } from '../math/vec2';
import { STREET_CLEARANCE } from './constants';
import type { CityLayout } from './roadNetwork';
import { connectNodes, splitEdge } from './edgeSplit';
import type { RailPlan } from './rail';
import type { EdgeId, RoadNode } from './types';

/**
 * Private road through the Dockside Freight Terminal for the container lorries (v3 F2b).
 *
 * It runs parallel to the freight track on the stack side, `YARD_ROAD_OFFSET` from the
 * track, from a T-junction on the block's south street (lorries come in) to one on its
 * north street (they go out). The street edges are split at the T nodes, which have no
 * traffic lights. The lane graph allows only a right turn in and a right turn out, and only
 * container lorries may route over it.
 */

/** Distance of the yard road from the freight track: the level crossing on the north street lies wholly beyond the T-junction. */
export const YARD_ROAD_OFFSET = 15;
/** Shortest street lane left between a T-junction and the next junction, m. */
const MIN_STREET_LANE = 5;

export interface YardRoad {
  edgeId: EdgeId;
  /** T-junctions where lorries enter (south street) and leave (north street). */
  entry: number;
  exit: number;
}

/** Adds the yard road to the network (before buildings are placed); null when the terminal has no room for it. */
export function addYardRoad(layout: CityLayout, rail: RailPlan): YardRoad | null {
  const network = layout.network;
  const site = rail.sites.find((s) => s.kind === 'freight_terminal');
  const freight = rail.tracks.find((t) => t.kind === 'freight');
  const { north, south, east } = site?.block.sides ?? {};
  if (!site || !freight || north === undefined || south === undefined || east === undefined) return null;

  // The last stretch of the freight line runs straight down the middle of the block.
  const pts = freight.points;
  const end = pts[pts.length - 1];
  const along = normalize(sub(end, pts[pts.length - 2]));
  let across = rightOf(along);
  const frontMid = samplePolyline(network.edges[east].points, network.edges[east].length / 2).point;
  if (dot(sub(frontMid, end), across) > 0) across = scale(across, -1); // away from the front street
  const centre = add(end, scale(across, YARD_ROAD_OFFSET));
  const line = [add(centre, scale(along, -300)), add(centre, scale(along, 300))];

  const hits = [south, north].map((id) => intersectPolylines(network.edges[id].points, line)[0]);
  if (hits.some((h) => !h)) return null;
  const roomy = [south, north].every((id, k) => {
    const e = network.edges[id];
    const s = hits[k].sa;
    const lane = (to: RoadNode) => STREET_CLEARANCE + to.clearance;
    return s - lane(network.nodes[e.from]) > MIN_STREET_LANE && e.length - s - lane(network.nodes[e.to]) > MIN_STREET_LANE;
  });
  if (!roomy) return null;

  const entry = splitEdge(layout, south, hits[0].sa).node;
  const exit = splitEdge(layout, north, hits[1].sa).node;
  const edge = connectNodes(layout, entry, exit, { name: 'Dockside Yard', yard: true });
  return { edgeId: edge.id, entry, exit };
}
