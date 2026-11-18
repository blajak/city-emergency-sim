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

/**
 * Expected extra seconds spent on a segment (e.g. waiting at a level crossing)
 * when driving it from `fromS` to `toS`, entering at `entryTime` seconds from now.
 */
export type SegmentDelay = (segment: SegmentId, entryTime: number, fromS: number, toS: number) => number;

/** A timed route also reports how much of its time is spent waiting. */
export interface TimedRoute extends Route {
  wait: number;
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
  /** Yard road lanes and the connectors into them (container lorries only). */
  private readonly yard = new Set<SegmentId>();

  constructor(private readonly graph: LaneGraph) {
    this.maxSpeed = Math.max(...graph.segments.map((s) => s.speedLimit));
    for (const seg of graph.segments) {
      const lane = seg.kind === 'lane' ? seg : graph.segments[seg.toLane];
      if (lane.kind === 'lane' && lane.yard) this.yard.add(seg.id);
    }
  }

  /** Forget cached paths (call when roads open or close). */
  clearCache(): void {
    this.cache.clear();
  }

  /** `yard`: the route may use the private Dockside yard road. */
  find(from: RoutePoint, to: RoutePoint, yard = false): Route | null {
    const start = this.graph.segments[from.segment];
    const target = this.graph.segments[to.segment];
    const travel = (seg: Segment, length: number) => length / seg.speedLimit;

    if (from.segment === to.segment && to.s >= from.s - 0.5) {
      const d = Math.max(0, to.s - from.s);
      return { segments: [from.segment], time: travel(start, d), distance: d };
    }

    const key = `${from.segment}>${to.segment}${yard ? 'y' : ''}`;
    let path = this.cache.get(key);
    if (path === undefined) {
      path = this.search(start, target, yard);
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

  /**
   * Fastest route when segments can cost extra time that depends on when they
   * are reached (level crossings about to close). Not cached. `startTime` is
   * how many seconds from now the vehicle is at `from`.
   */
  findTimed(from: RoutePoint, to: RoutePoint, delay: SegmentDelay, startTime = 0): TimedRoute | null {
    const start = this.graph.segments[from.segment];
    const target = this.graph.segments[to.segment];

    if (from.segment === to.segment && to.s >= from.s - 0.5) {
      const d = Math.max(0, to.s - from.s);
      const wait = delay(from.segment, startTime, from.s, to.s);
      return { segments: [from.segment], time: d / start.speedLimit + wait, distance: d, wait };
    }

    const goal = target.points[0];
    const heuristic = (seg: Segment) => distance(seg.points[seg.points.length - 1], goal) / this.maxSpeed;
    // Elapsed time (from `startTime`) at the END of a segment, and waits included in it.
    const headWait = delay(start.id, startTime, from.s, start.length);
    const cost = new Map<SegmentId, number>([[start.id, (start.length - from.s) / start.speedLimit + headWait]]);
    const waits = new Map<SegmentId, number>([[start.id, headWait]]);
    const previous = new Map<SegmentId, SegmentId>();
    const closed = new Set<SegmentId>();
    const open = new MinHeap<SegmentId>();
    open.push(start.id, cost.get(start.id)! + heuristic(start));
    let best = Infinity;
    let bestLast: SegmentId | null = null;
    let bestWait = 0;

    while (open.size > 0) {
      const id = open.pop()!;
      if (closed.has(id)) continue;
      closed.add(id);
      const base = cost.get(id)!;
      if (base + heuristic(this.graph.segments[id]) >= best) break;

      for (const nextId of successors(this.graph.segments[id])) {
        if (this.yard.has(nextId)) continue; // responders never cut through the yard
        const next = this.graph.segments[nextId];
        if (nextId === target.id) {
          const w = delay(nextId, startTime + base, 0, to.s);
          const total = base + to.s / next.speedLimit + w;
          if (total < best) {
            best = total;
            bestLast = id;
            bestWait = waits.get(id)! + w;
          }
          continue;
        }
        const w = delay(nextId, startTime + base, 0, next.length);
        const c = base + next.length / next.speedLimit + w;
        if (closed.has(nextId) || c >= (cost.get(nextId) ?? Infinity)) continue;
        cost.set(nextId, c);
        waits.set(nextId, waits.get(id)! + w);
        previous.set(nextId, id);
        open.push(nextId, c + heuristic(next));
      }
    }
    if (bestLast === null) return null;

    const middle: SegmentId[] = [];
    let dist = start.length - from.s + to.s;
    for (let id: SegmentId | undefined = bestLast; id !== undefined && id !== start.id; id = previous.get(id)) {
      middle.unshift(id);
      dist += this.graph.segments[id].length;
    }
    return { segments: [from.segment, ...middle, to.segment], time: best, distance: dist, wait: bestWait };
  }

  /**
   * Time and waits along a given route: `from`, then `plan` (the segments after
   * it, ending with `to.segment`), with the same delays as `findTimed`.
   */
  timeAlong(from: RoutePoint, plan: readonly SegmentId[], to: RoutePoint, delay: SegmentDelay, startTime = 0): { time: number; wait: number } {
    const path = [from.segment, ...plan];
    let time = 0;
    let wait = 0;
    path.forEach((id, i) => {
      const seg = this.graph.segments[id];
      const fromS = i === 0 ? from.s : 0;
      const toS = i === path.length - 1 ? to.s : seg.length;
      const w = delay(id, startTime + time, fromS, toS);
      time += Math.max(0, toS - fromS) / seg.speedLimit + w;
      wait += w;
    });
    return { time, wait };
  }

  /** A* from the end of `start` to the beginning of `target`. */
  private search(start: Segment, target: Segment, yard: boolean): CachedPath | null {
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
        if (!yard && this.yard.has(nextId)) continue;
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
