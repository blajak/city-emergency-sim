import { CROSSWALK_LENGTH, STOP_LINE_GAP } from './constants';
import type { RoadNode } from './types';

/**
 * Distance from the node centre to where lanes end / start: the stop line at
 * signalised intersections, the edge of the junction area otherwise.
 */
export function approachDistance(node: RoadNode): number {
  return node.signalized ? node.clearance + CROSSWALK_LENGTH + STOP_LINE_GAP : node.clearance;
}
