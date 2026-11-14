import { distance } from '../math/vec2';
import type { LaneGraph, Segment, SegmentId } from '../traffic/laneGraph';
import { MinHeap } from './minHeap';

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

interface CachedPath {
  /** Segments strictly between the start and the target segment. */
  middle: SegmentId[];
  time: number;
  distance: number;
}

/**
 * Fastest routes over the lane graph (A* weighted by free-flow travel time,
 * with a straight-line heuristic). The best path between two segments does
 * not depend on the positions within them, so paths are cached per
 * (start segment, target segment) pair.
 */
export class Router {
  private readonly cache = new Map<string, CachedPath | null>();
  private readonly maxSpeed: number;

  constructor(private readonly graph: LaneGraph) {
    this.maxSpeed = Math.max(...graph.segments.map((s) => s.speedLimit));
  }

  /** Forget cached paths (call when roads open or close). */
  clearCache(): void {
    this.cache.clear();
  }

  find(from: RoutePoint, to: RoutePoint): Route | null {
    const start = this.graph.segments[from.segment];
    const target = this.graph.segments[to.segment];
    const travel = (seg: Segment, length: number) => length / seg.speedLimit;

    if (from.segment === to.segment && to.s >= from.s - 0.5) {
      const d = Math.max(0, to.s - from.s);
      return { segments: [from.segment], time: travel(start, d), distance: d };
    }

    const key = `${from.segment}>${to.segment}`;
    let path = this.cache.get(key);
    if (path === undefined) {
      path = this.search(start, target);
      this.cache.set(key, path);
    }
    if (!path) return null;

    const head = start.length - from.s;
    return {
      segments: [from.segment, ...path.middle, to.segment],
      time: travel(start, head) + path.time + travel(target, to.s),
      distance: head + path.distance + to.s,
    };
  }

  /** A* from the end of `start` to the beginning of `target`. */
  private search(start: Segment, target: Segment): CachedPath | null {
    const goal = target.points[0];
    const heuristic = (seg: Segment) => distance(seg.points[seg.points.length - 1], goal) / this.maxSpeed;

    // Cost to reach the END of a segment (excluding the start segment itself).
    const cost = new Map<SegmentId, number>([[start.id, 0]]);
    const previous = new Map<SegmentId, SegmentId>();
    const closed = new Set<SegmentId>();
    const open = new MinHeap<SegmentId>();
    open.push(start.id, heuristic(start));

    while (open.size > 0) {
      const id = open.pop()!;
      if (closed.has(id)) continue;
      closed.add(id);
      const seg = this.graph.segments[id];
      const base = cost.get(id)!;

      for (const nextId of successors(seg)) {
        if (nextId === target.id) return this.unwind(start.id, id, previous, base);
        const next = this.graph.segments[nextId];
        const c = base + next.length / next.speedLimit;
        if (closed.has(nextId) || c >= (cost.get(nextId) ?? Infinity)) continue;
        cost.set(nextId, c);
        previous.set(nextId, id);
        open.push(nextId, c + heuristic(next));
      }
    }
    return null;
  }

  /**
   * Reaching the target is detected when it is a successor of `last`; with a
   * consistent heuristic the first such `last` popped is on an optimal path.
   */
  private unwind(startId: SegmentId, last: SegmentId, previous: Map<SegmentId, SegmentId>, time: number): CachedPath {
    const middle: SegmentId[] = [];
    let dist = 0;
    for (let id: SegmentId | undefined = last; id !== undefined && id !== startId; id = previous.get(id)) {
      middle.unshift(id);
      dist += this.graph.segments[id].length;
    }
    return { middle, time, distance: dist };
  }
}

function successors(seg: Segment): SegmentId[] {
  return seg.kind === 'lane' ? seg.outConnectors : [seg.toLane];
}
