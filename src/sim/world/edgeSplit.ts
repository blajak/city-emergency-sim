import { polylineLength, samplePolyline } from '../math/geometry';
import type { Vec2 } from '../math/vec2';
import type { CityLayout } from './roadNetwork';
import { nodeClearance } from './roadNetwork';
import type { Building, EdgeId, RoadEdge, RoadNode } from './types';

/**
 * Adding private or side roads to the street grid after it is laid out: split a street at
 * a new (unsignalised) T-junction node, then connect two such nodes with a new edge.
 * Used by the Dockside yard road and the stadium car park aisles.
 */

/**
 * Splits an edge at `s` with a new unsignalised node; the first part keeps the id. Addresses
 * of `buildings` already placed beyond `s` move to the second part. Returns the new node
 * and the second part's id.
 */
export function splitEdge(layout: CityLayout, edgeId: EdgeId, s: number, buildings: Building[] = []): { node: number; rest: EdgeId } {
  const { nodes, edges } = layout.network;
  const edge = edges[edgeId];
  const point = samplePolyline(edge.points, s).point;
  const first: Vec2[] = [edge.points[0]];
  const second: Vec2[] = [point];
  let acc = 0;
  for (let i = 1; i < edge.points.length; i++) {
    acc += Math.hypot(edge.points[i].x - edge.points[i - 1].x, edge.points[i].z - edge.points[i - 1].z);
    if (acc < s - 1e-6) first.push(edge.points[i]);
    else if (acc > s + 1e-6) second.push(edge.points[i]);
  }
  first.push(point);
  if (second.length === 1) second.push(edge.points[edge.points.length - 1]);

  const node: RoadNode = { id: nodes.length, pos: point, edges: [], signalized: false, clearance: 0 };
  nodes.push(node);
  const rest: RoadEdge = { id: edges.length, name: edge.name, from: node.id, to: edge.to, points: second, length: polylineLength(second) };
  edges.push(rest);
  const far = nodes[edge.to];
  far.edges = far.edges.map((id) => (id === edgeId ? rest.id : id));
  edge.to = node.id;
  const cut = polylineLength(first);
  edge.points = first;
  edge.length = cut;
  node.edges.push(edgeId, rest.id);
  // Blocks bordered by this street keep the longer part as that side.
  if (rest.length > edge.length) {
    for (const block of layout.blocks) {
      for (const side of ['north', 'south', 'east', 'west'] as const) if (block.sides[side] === edgeId) block.sides[side] = rest.id;
    }
  }
  for (const b of buildings) {
    if (b.address.edgeId === edgeId && b.address.s > cut) b.address = { ...b.address, edgeId: rest.id, s: b.address.s - cut };
  }
  return { node: node.id, rest: rest.id };
}

/** Connects two nodes with a straight new edge and updates their clearances. */
export function connectNodes(layout: CityLayout, from: number, to: number, props: Pick<RoadEdge, 'name' | 'yard' | 'carPark' | 'oneWay'>): RoadEdge {
  const { nodes, edges } = layout.network;
  const a = nodes[from];
  const b = nodes[to];
  const edge: RoadEdge = { id: edges.length, from, to, points: [a.pos, b.pos], length: polylineLength([a.pos, b.pos]), ...props };
  edges.push(edge);
  a.edges.push(edge.id);
  b.edges.push(edge.id);
  for (const node of [a, b]) node.clearance = nodeClearance(node, edges);
  return edge;
}
