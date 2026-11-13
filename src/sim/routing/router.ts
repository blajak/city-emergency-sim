import type { LaneGraph, Segment, SegmentId } from '../traffic/laneGraph';

/** A position on the drivable network. */
export interface RoutePoint {
  segment: SegmentId;
  s: number;
}

export interface Route {
  /** Segments from the start segment (inclusive) to the target lane (inclusive). */
  segments: SegmentId[];
  /** Free-flow travel time estimate, seconds. */
  time: number;
  distance: number;
}

/**
 * Fastest route between two points (Dijkstra over segments, weighted by
 * free-flow travel time). The graph is small (~300 segments), so a simple
 * O(n²) search is plenty.
 */
export function findRoute(graph: LaneGraph, from: RoutePoint, to: RoutePoint): Route | null {
  const start = graph.segments[from.segment];
  const travel = (seg: Segment, length: number) => length / seg.speedLimit;

  if (from.segment === to.segment && to.s >= from.s - 0.5) {
    const d = Math.max(0, to.s - from.s);
    return { segments: [from.segment], time: travel(start, d), distance: d };
  }

  // Cost to reach the END of each segment.
  const time = new Map<SegmentId, number>([[start.id, travel(start, start.length - from.s)]]);
  const dist = new Map<SegmentId, number>([[start.id, start.length - from.s]]);
  const previous = new Map<SegmentId, SegmentId>();
  const done = new Set<SegmentId>();
  let best: { time: number; distance: number; via: SegmentId } | null = null;

  for (;;) {
    let current: SegmentId | null = null;
    for (const [id, t] of time) {
      if (!done.has(id) && (current === null || t < time.get(current)!)) current = id;
    }
    if (current === null) break;
    const tCurrent = time.get(current)!;
    if (best && tCurrent >= best.time) break;
    done.add(current);

    for (const nextId of successors(graph.segments[current])) {
      const next = graph.segments[nextId];
      if (nextId === to.segment) {
        const tTarget = tCurrent + travel(next, to.s);
        if (!best || tTarget < best.time) best = { time: tTarget, distance: dist.get(current)! + to.s, via: current };
      }
      const t = tCurrent + travel(next, next.length);
      if (!done.has(nextId) && (!time.has(nextId) || t < time.get(nextId)!)) {
        time.set(nextId, t);
        dist.set(nextId, dist.get(current)! + next.length);
        previous.set(nextId, current);
      }
    }
  }

  if (!best) return null;
  const segments = [to.segment];
  for (let id: SegmentId | undefined = best.via; id !== undefined; id = previous.get(id)) {
    segments.unshift(id);
    if (id === start.id) break;
  }
  return { segments, time: best.time, distance: best.distance };
}

function successors(seg: Segment): SegmentId[] {
  return seg.kind === 'lane' ? seg.outConnectors : [seg.toLane];
}
