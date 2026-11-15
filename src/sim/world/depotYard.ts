import { obbAxes, obbLocalToWorld } from '../math/geometry';
import { type Vec2, dot, sub } from '../math/vec2';
import { BUS_LENGTH } from './constants';
import type { Building } from './types';

/** Gap between the hall / stalls and the aisles' centre lines, m. */
const AISLE_GAP = 4;
const STALL_SPACING = 4;

export interface DepotStall {
  /** Bus centre when parked. */
  center: Vec2;
  /** Local x across the yard. */
  x: number;
}

/**
 * Bus depot yard: a row of drive-through stalls between a back aisle (along
 * the hall) and a front aisle (towards the street). Buses park nose towards
 * the street, enter a stall from the back aisle and leave it forwards.
 * Coordinates in the plot frame: local +z points at the street.
 */
export interface DepotYard {
  building: Building;
  stalls: DepotStall[];
  /** Heading of a parked bus (Three.js rotation.y). */
  yaw: number;
  zStall: number;
  zBack: number;
  zFront: number;
  /** |x| of the side lanes joining the two aisles. */
  xSide: number;
  toWorld(x: number, z: number): Vec2;
  toLocal(p: Vec2): { x: number; z: number };
}

export function depotYard(building: Building): DepotYard | null {
  const plot = building.plot;
  if (!plot) return null;
  const hallFront = -(plot.halfD - building.footprint.halfD) + building.footprint.halfD;
  const zBack = hallFront + AISLE_GAP;
  const zStall = zBack + AISLE_GAP + BUS_LENGTH / 2;
  const zFront = zStall + BUS_LENGTH / 2 + AISLE_GAP;
  if (zFront + 2 > plot.halfD) return null;
  const toWorld = (x: number, z: number) => obbLocalToWorld(plot, x, z);
  const [ax, az] = obbAxes(plot.rotation);
  const toLocal = (p: Vec2) => {
    const d = sub(p, plot.center);
    return { x: dot(d, ax), z: dot(d, az) };
  };
  const stalls: DepotStall[] = [];
  for (let x = -plot.halfW + 8; x <= plot.halfW - 8; x += STALL_SPACING) stalls.push({ center: toWorld(x, zStall), x });
  return { building, stalls, yaw: plot.rotation, zStall, zBack, zFront, xSide: plot.halfW - 3, toWorld, toLocal };
}
