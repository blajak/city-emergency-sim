/**
 * Intelligent Driver Model (Treiber et al.) — smooth, collision-free
 * car-following with one formula for free driving, following and stopping.
 */
export interface DriverParams {
  /** Multiplier on the segment speed limit (some drivers are faster). */
  speedFactor: number;
  /** Desired time gap to the leader, s. */
  timeHeadway: number;
  /** Bumper-to-bumper gap when stopped, m. */
  minGap: number;
  maxAccel: number;
  comfortDecel: number;
}

export const DEFAULT_DRIVER: DriverParams = {
  speedFactor: 1,
  timeHeadway: 1.2,
  minGap: 2,
  maxAccel: 1.8,
  comfortDecel: 3,
};

/** Free-road term: 1 - (v / v0)^4. */
export function idmFreeTerm(v: number, desiredSpeed: number): number {
  return 1 - Math.pow(v / Math.max(desiredSpeed, 0.1), 4);
}

/**
 * Interaction term (s* / gap)^2 for an obstacle `gap` metres ahead moving at
 * `leaderSpeed`. The final acceleration is maxAccel * (free - max(interaction)).
 */
export function idmInteractionTerm(v: number, leaderSpeed: number, gap: number, p: DriverParams): number {
  const dv = v - leaderSpeed;
  const desiredGap = p.minGap + Math.max(0, v * p.timeHeadway + (v * dv) / (2 * Math.sqrt(p.maxAccel * p.comfortDecel)));
  return Math.pow(desiredGap / Math.max(gap, 0.05), 2);
}
