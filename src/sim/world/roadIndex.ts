import { distanceToSegment } from '../math/geometry';
import { SpatialGrid, around, pointsBox } from '../math/spatialGrid';
import type { Vec2 } from '../math/vec2';
import type { RoadNetwork } from './types';

const CELL_SIZE = 24;

/** Spatial index over road centre-line segments for fast "is this near a road?" checks. */
export class RoadIndex {
  private readonly grid = new SpatialGrid<[Vec2, Vec2]>(CELL_SIZE);

  constructor(network: RoadNetwork) {
    for (const edge of network.edges) {
      for (let i = 0; i < edge.points.length - 1; i++) {
        const segment: [Vec2, Vec2] = [edge.points[i], edge.points[i + 1]];
        this.grid.insert(segment, pointsBox(segment));
      }
    }
  }

  /** True when `p` is closer than `distance` to any road centre line. */
  isNear(p: Vec2, distance: number): boolean {
    for (const [a, b] of this.grid.query(around(p, distance))) {
      if (distanceToSegment(p, a, b) < distance) return true;
    }
    return false;
  }
}
