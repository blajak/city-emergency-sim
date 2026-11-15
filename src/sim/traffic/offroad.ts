import { samplePolyline } from '../math/geometry';
import { type Vec2, add, distance, normalize, scale, sub } from '../math/vec2';
import type { Pose } from './vehicle';

/**
 * A vehicle driving off the road network (a yard or driveway) along a fixed
 * polyline. Its front bumper follows the path and the rear follows behind on
 * the same path, so it turns like a real vehicle.
 */
export interface OffroadMove {
  path: Vec2[];
  pathLength: number;
  /** Front bumper position along the path. */
  s: number;
  v: number;
  /** The vehicle waits with its front bumper here while `hold` is set. */
  holdAt: number;
}

export function startOffroad(path: Vec2[], bodyLength: number, holdIndex = -1): OffroadMove {
  const lengths = path.slice(1).map((p, i) => distance(path[i], p));
  const sum = (to: number) => lengths.slice(0, to).reduce((a, b) => a + b, 0);
  // The front starts at the second point: the body lies along the first segment.
  return { path, pathLength: sum(lengths.length), s: Math.min(lengths[0] ?? 0, bodyLength), v: 0, holdAt: holdIndex >= 0 ? sum(holdIndex) : Infinity };
}

/** Advances the move; returns true when the end of the path is reached. */
export function stepOffroad(move: OffroadMove, dt: number, hold: boolean, speed = 3, accel = 1): boolean {
  const limit = Math.min(move.pathLength, hold ? move.holdAt : Infinity) - move.s;
  move.v = Math.min(speed, move.v + accel * dt, Math.sqrt(2 * accel * Math.max(0, limit)));
  move.s += Math.min(move.v * dt, Math.max(0, limit));
  return move.s >= move.pathLength - 0.05;
}

/** Pose (body centre and heading) for a vehicle of `bodyLength` whose front is at `s` along `path`. */
export function offroadPose(path: Vec2[], s: number, bodyLength: number): Pose {
  const front = samplePolyline(path, s).point;
  const rearS = s - bodyLength;
  const rear = rearS >= 0 ? samplePolyline(path, rearS).point : add(path[0], scale(normalize(sub(path[0], path[1])), -rearS));
  return { x: (front.x + rear.x) / 2, z: (front.z + rear.z) / 2, yaw: Math.atan2(front.x - rear.x, front.z - rear.z) };
}
