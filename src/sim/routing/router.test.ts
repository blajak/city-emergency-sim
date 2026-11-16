import { describe, expect, it } from 'vitest';
import { createRng } from '../math/rng';
import { type LaneGraph, type Segment, buildLaneGraph } from '../traffic/laneGraph';
import { generateCity } from '../world/cityGenerator';
import { type RoutePoint, Router } from './router';

/** Plain Dijkstra over segment ends, used as the reference answer. */
function referenceTime(graph: LaneGraph, from: RoutePoint, to: RoutePoint): number {
  const start = graph.segments[from.segment];
  const travel = (seg: Segment, len: number) => len / seg.speedLimit;
  if (from.segment === to.segment && to.s >= from.s - 0.5) return travel(start, Math.max(0, to.s - from.s));
  const dist = new Map<number, number>([[start.id, travel(start, start.length - from.s)]]);
  const done = new Set<number>();
  let best = Infinity;
  for (;;) {
    let cur = -1;
    for (const [id, t] of dist) if (!done.has(id) && (cur < 0 || t < dist.get(cur)!)) cur = id;
    if (cur < 0) break;
    done.add(cur);
    const seg = graph.segments[cur];
    for (const n of seg.kind === 'lane' ? seg.outConnectors : [seg.toLane]) {
      const next = graph.segments[n];
      if (n === to.segment) best = Math.min(best, dist.get(cur)! + travel(next, to.s));
      const t = dist.get(cur)! + travel(next, next.length);
      if (!done.has(n) && t < (dist.get(n) ?? Infinity)) dist.set(n, t);
    }
  }
  return best;
}

describe('Router', () => {
  for (const scale of [1, 5]) {
    it(`matches Dijkstra on random queries (scale ${scale})`, () => {
      const graph = buildLaneGraph(generateCity(1337, { scale }).roads);
      const router = new Router(graph);
      const rng = createRng(11);
      for (let i = 0; i < 60; i++) {
        const a = rng.pick(graph.lanes);
        const b = rng.pick(graph.lanes);
        const from = { segment: a.id, s: rng.range(0, a.length) };
        const to = { segment: b.id, s: rng.range(0, b.length) };
        const route = router.find(from, to)!;
        expect(route).not.toBeNull();
        expect(route.time).toBeCloseTo(referenceTime(graph, from, to), 6);
        // The route is a connected chain from start to target.
        expect(route.segments[0]).toBe(a.id);
        expect(route.segments.at(-1)).toBe(b.id);
        for (let k = 0; k < route.segments.length - 1; k++) {
          const seg = graph.segments[route.segments[k]];
          const next = route.segments[k + 1];
          expect(seg.kind === 'lane' ? seg.outConnectors.includes(next) : seg.toLane === next).toBe(true);
        }
        // Cached answer is identical.
        expect(router.find(from, to)).toEqual(route);
      }
    });
  }

  it('timed search matches the plain one without delays and routes around a delayed lane', () => {
    const graph = buildLaneGraph(generateCity(1337, { scale: 5 }).roads);
    const router = new Router(graph);
    const rng = createRng(5);
    let detours = 0;
    for (let i = 0; i < 40; i++) {
      const a = rng.pick(graph.lanes);
      const b = rng.pick(graph.lanes);
      const from = { segment: a.id, s: rng.range(0, a.length) };
      const to = { segment: b.id, s: rng.range(0, b.length) };
      const plain = router.find(from, to)!;
      const timed = router.findTimed(from, to, () => 0)!;
      expect(timed.time).toBeCloseTo(plain.time, 6);
      expect(timed.wait).toBe(0);
      expect(router.timeAlong(from, plain.segments.slice(1), to, () => 0).time).toBeCloseTo(plain.time, 6);

      // Block a lane in the middle of the plain route for 10 minutes.
      const middle = plain.segments.slice(1, -1).filter((id) => graph.segments[id].kind === 'lane');
      if (middle.length === 0) continue;
      const blocked = middle[Math.floor(middle.length / 2)];
      const delay = (id: number, entry: number) => (id === blocked ? Math.max(0, 600 - entry) : 0);
      const around = router.findTimed(from, to, delay)!;
      const along = router.timeAlong(from, plain.segments.slice(1), to, delay);
      expect(along.wait).toBeGreaterThan(500);
      // Never worse than waiting on the old route; a detour when one exists.
      expect(around.time).toBeLessThanOrEqual(along.time + 1e-6);
      if (!around.segments.includes(blocked)) {
        detours++;
        expect(around.wait).toBe(0);
        expect(around.time).toBeGreaterThanOrEqual(plain.time - 1e-6);
      }
    }
    expect(detours).toBeGreaterThan(10);
  });
});
