import { describe, expect, it } from 'vitest';
import { distanceToPolyline, obbAxes, obbLocalToWorld, pointInObb } from '../math/geometry';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { MIN_STADIUM_HALF } from './carPark';
import { generateCity } from './cityGenerator';

const SEEDS = [1337, 7, 42, 99, 5];

describe('stadium car park', () => {
  it('has no car park without a stadium (small towns)', () => {
    const city = generateCity(1337, { scale: 1 });
    expect(city.buildings.some((b) => b.kind === 'stadium')).toBe(false);
    expect(city.buildings.some((b) => b.kind === 'car_park')).toBe(false);
    expect(city.roads.edges.some((e) => e.carPark)).toBe(false);
  });

  it('puts the stadium on the island of a car park with one gate and a one-way loop', () => {
    const summary: string[] = [];
    for (const scale of [4, 10]) {
      for (const seed of SEEDS) {
        const city = generateCity(seed, { scale });
        const label = `seed ${seed} scale ${scale}`;
        const stadium = city.buildings.find((b) => b.kind === 'stadium')!;
        const park = city.buildings.find((b) => b.kind === 'car_park');
        expect(park, label).toBeDefined();
        // The stadium stands inside the car park plot, at least 2 m from the loop's centre line + lane.
        const s = stadium.footprint;
        expect(Math.min(s.halfW, s.halfD), label).toBeGreaterThanOrEqual(MIN_STADIUM_HALF);
        for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          expect(pointInObb(obbLocalToWorld(s, x * s.halfW, z * s.halfD), park!.plot!, 0.01), label).toBe(true);
        }
        const edges = city.roads.edges.filter((e) => e.carPark);
        const access = edges.filter((e) => !e.oneWay);
        const loop = edges.filter((e) => e.oneWay);
        expect(access, label).toHaveLength(1);
        expect(loop, label).toHaveLength(2);
        // The gate: one unsignalised T-junction on the street.
        const t = city.roads.nodes[access[0].from];
        expect(t.signalized, label).toBe(false);
        expect(t.edges.filter((id) => !city.roads.edges[id].carPark), label).toHaveLength(2);
        // The loop lies inside the plot, and no other building stands on it.
        for (const e of loop) {
          for (const p of e.points) {
            expect(pointInObb(p, park!.plot!, 0.01), label).toBe(true);
            // Distance from the stadium's box (2 m lane half + 2 m pavement, a bit less at the rounded corners).
            const [ax, az] = obbAxes(s.rotation);
            const d = { x: p.x - s.center.x, z: p.z - s.center.z };
            const out = Math.hypot(Math.max(0, Math.abs(d.x * ax.x + d.z * ax.z) - s.halfW), Math.max(0, Math.abs(d.x * az.x + d.z * az.z) - s.halfD));
            expect(out, `${label} loop clear of the stadium`).toBeGreaterThan(3.5);
          }
          for (const b of city.buildings) {
            if (b === park) continue;
            expect(distanceToPolyline(b.footprint.center, e.points) > Math.min(b.footprint.halfW, b.footprint.halfD), `${label} ${b.kind}`).toBe(true);
          }
        }
        for (const b of city.buildings) {
          const e = city.roads.edges[b.address.edgeId];
          expect(b.address.s, `${label} ${b.kind}`).toBeGreaterThanOrEqual(0);
          expect(b.address.s, `${label} ${b.kind}`).toBeLessThanOrEqual(e.length + 0.01);
        }
        const sim = new Simulation(city, { civilianCount: 0 });
        summary.push(`${label}: stadium ${(s.halfW * 2).toFixed(0)}×${(s.halfD * 2).toFixed(0)} m, ${sim.match.spaces.length} fan spaces`);
        expect(sim.match.spaces.length, label).toBeGreaterThanOrEqual(16);
        // One space each for the police car and the ambulance, the ones nearest the exit.
        expect([...sim.match.dutySpaces.keys()].sort(), label).toEqual(['ambulance', 'police']);
        for (const d of sim.match.dutySpaces.values()) expect(sim.match.spaces.some((p) => p.segment === d.segment && Math.abs(p.s - d.s) < 1), label).toBe(false);
      }
    }
    console.log(summary.join('\n'));
  });

  it('lets cars in and out only by turning right, round the loop once, and is no short cut', () => {
    for (const seed of SEEDS) {
      const sim = new Simulation(generateCity(seed, { scale: 10 }), { civilianCount: 0 });
      const { graph, router } = sim.traffic;
      const parkLanes = graph.lanes.filter((l) => l.carPark);
      expect(parkLanes).toHaveLength(4); // access road both ways + two loop halves
      for (const c of graph.connectors) {
        const from = graph.segments[c.fromLane] as (typeof parkLanes)[number];
        const to = graph.segments[c.toLane] as (typeof parkLanes)[number];
        if (from.carPark && !to.carPark) expect(c.turn, `seed ${seed} out of the car park`).toBe('right');
        if (to.carPark && !from.carPark) expect(c.turn, `seed ${seed} into the car park`).not.toBe('straight');
        // Never from the second loop half straight into the first again.
        const oneWay = (l: typeof from) => sim.city.roads.edges[l.edgeId].oneWay;
        if (from.carPark && to.carPark && oneWay(from) && oneWay(to)) expect(sim.city.roads.nodes[c.nodeId].edges).toHaveLength(2);
      }
      for (const space of sim.match.spaces) {
        const street = graph.lanes.find((l) => !l.carPark && !l.yard && l.length > 60)!;
        expect(router.find({ segment: street.id, s: 5 }, space), `seed ${seed} in`).not.toBeNull();
        expect(router.find(space, { segment: street.id, s: 30 }), `seed ${seed} out`).not.toBeNull();
      }
      // Routes between streets never go through the car park.
      const streets = graph.lanes.filter((l) => !l.carPark && !l.yard);
      for (let k = 0; k < 200; k++) {
        const a = streets[(k * 7919) % streets.length];
        const b = streets[(k * 104729 + 13) % streets.length];
        const route = router.find({ segment: a.id, s: 1 }, { segment: b.id, s: 1 });
        for (const id of route?.segments ?? []) {
          const seg = graph.segments[id];
          const lane = seg.kind === 'lane' ? seg : (graph.segments[seg.toLane] as typeof seg & { carPark: boolean });
          expect((lane as { carPark: boolean }).carPark, `seed ${seed}`).toBe(false);
        }
      }
    }
  });

  it('keeps wandering traffic out of the car park, collision-free', () => {
    const sim = new Simulation(generateCity(1337, { scale: 10 }), { civilianCount: 200 });
    const g = sim.traffic.graph;
    for (let i = 0; i < 20 * 240; i++) {
      sim.step();
      if (i % 20 === 0) {
        const hit = findOverlap(sim.traffic.vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(1)} ${hit}`);
        for (const v of sim.traffic.vehicles) {
          const seg = g.segments[v.segment];
          if (seg.kind === 'lane') expect(seg.carPark, `${v.role}${v.id}`).toBe(false);
        }
      }
    }
  }, 120_000);
});
