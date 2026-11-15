import { projectOnPolyline, samplePolyline } from '../math/geometry';
import type { RoutePoint } from '../routing/router';
import type { Lane, LaneGraph } from '../traffic/laneGraph';
import type { Building, EdgeId, RoadNetwork, Side } from '../world/types';

/** Keep parked vehicles away from the stop line / signal pole at the lane end. */
const LANE_END_MARGIN = 6;

/** The lane running along the building's side of the street. */
export function frontageLane(graph: LaneGraph, building: Building): Lane {
  const { edgeId, side } = building.address;
  // Right-hand traffic: the forward lane runs along the right (+1) side.
  const lane = graph.lanes.find((l) => l.edgeId === edgeId && l.forward === (side === 1));
  if (!lane) throw new Error(`No lane for building ${building.id}`);
  return lane;
}

/**
 * Curb stop in front of a building. `along` shifts the stop along the lane;
 * the returned `s` is where the front bumper ends up.
 */
export function curbStop(
  graph: LaneGraph,
  network: RoadNetwork,
  building: Building,
  vehicleLength: number,
  along = 0,
): RoutePoint {
  const lane = frontageLane(graph, building);
  const edge = network.edges[building.address.edgeId];
  const anchor = samplePolyline(edge.points, building.address.s).point;
  const s = projectOnPolyline(lane.points, anchor) + vehicleLength / 2 + along;
  return { segment: lane.id, s: clampToLane(lane, s, vehicleLength) };
}

export function clampToLane(lane: Lane, s: number, vehicleLength: number): number {
  return Math.min(lane.length - LANE_END_MARGIN, Math.max(vehicleLength + 1, s));
}

/** Stop at a kerb position (`s` along the edge centre line marks the middle of the vehicle). */
export function kerbPoint(
  graph: LaneGraph,
  network: RoadNetwork,
  edgeId: EdgeId,
  side: Side,
  s: number,
  vehicleLength: number,
): RoutePoint {
  const lane = graph.lanes.find((l) => l.edgeId === edgeId && l.forward === (side === 1));
  if (!lane) throw new Error(`No lane on edge ${edgeId}`);
  const anchor = samplePolyline(network.edges[edgeId].points, s).point;
  const front = projectOnPolyline(lane.points, anchor) + vehicleLength / 2;
  return { segment: lane.id, s: clampToLane(lane, front, vehicleLength) };
}
