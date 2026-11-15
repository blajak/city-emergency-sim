import { type OBB, obbOverlap } from '../math/geometry';
import { SpatialGrid, around } from '../math/spatialGrid';
import { type Body, type Vehicle, vehicleBodies } from '../traffic/vehicle';

/** Footprint of a rigid body, shrunk a little so touching bumpers don't count. */
export function bodyBox(b: Body, shrink = 0.2): OBB {
  return { center: { x: b.pose.x, z: b.pose.z }, halfW: b.width / 2 - shrink, halfD: b.length / 2 - shrink, rotation: b.pose.yaw };
}

/** True when any part of `a` overlaps any part of `b` (tractor and trailer are separate parts). */
export function vehiclesOverlap(a: Vehicle, b: Vehicle, shrink = 0.2): boolean {
  for (const x of vehicleBodies(a)) {
    for (const y of vehicleBodies(b)) if (obbOverlap(bodyBox(x, shrink), bodyBox(y, shrink))) return true;
  }
  return false;
}

/** First overlapping pair among many vehicles (grid-accelerated), as "role id / role id", or null. */
export function findOverlap(vehicles: readonly Vehicle[], shrink = 0.2): string | null {
  const grid = new SpatialGrid<Vehicle>(12);
  for (const v of vehicles) {
    // Broad box around the front body big enough to hold a trailer too.
    const box = around(v.pose, v.length);
    for (const other of grid.query(box)) {
      if (vehiclesOverlap(v, other, shrink)) return `${v.role} ${v.id} / ${other.role} ${other.id}`;
    }
    grid.insert(v, box);
  }
  return null;
}
