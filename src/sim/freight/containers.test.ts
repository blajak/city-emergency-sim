import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';

describe('containers and gantry cranes', () => {
  it('has no yards in a small town without a freight line', () => {
    const sim = new Simulation(generateCity(1337, { scale: 1 }), { civilianCount: 0 });
    expect(sim.containers.yards).toHaveLength(0);
    expect(sim.rail.departureHold).toBeNull();
  });

  it('swaps containers between the trains, keeps every container, and holds trains until the crane is done', () => {
    const sim = new Simulation(generateCity(1337, { scale: 10 }), { civilianCount: 60 });
    const cs = sim.containers;
    expect(cs.yards.map((y) => y.kind)).toEqual(['hub', 'dockside']);

    const moveTimes: number[] = [];
    const started = new Map<string, number>();
    const departures: { full: boolean; forCity: number; city: number }[] = [];
    const standing = new Set<number>();
    for (let i = 0; i < 20 * 60 * 20; i++) {
      sim.step();
      for (const yard of cs.yards) {
        const task = yard.crane.task;
        if (task && !started.has(yard.kind)) started.set(yard.kind, sim.time);
        if (!task && started.has(yard.kind)) {
          moveTimes.push(sim.time - started.get(yard.kind)!);
          started.delete(yard.kind);
        }
        // A wagon the crane works on belongs to a train standing at this yard.
        for (const spot of task ? [task.from, task.to] : []) {
          if (spot.kind !== 'wagon') continue;
          expect(spot.train.v).toBe(0);
          expect(spot.train.stoppedAt).toBe(yard.name);
        }
      }
      for (const t of sim.rail.trains.filter((x) => x.kind === 'longhaul')) {
        if (t.stoppedAt) standing.add(t.id);
        else if (standing.delete(t.id)) {
          const load = cs.loadOf(t)!.filter((_, k) => t.cars[k].model === 'container_wagon');
          departures.push({ full: load.every((c) => c !== null), forCity: load.filter((c) => c?.forCity).length, city: load.filter((c) => c?.outbound).length });
        }
      }
      if (i % 200 === 0) expect(cs.all().length + cs.stats.left).toBe(cs.stats.created);
    }
    // Three long-distance trains (60 s, 540 s, 1020 s): each left the hub with its city-bound
    // containers off and the first ones full again with city containers.
    expect(departures.length).toBe(3);
    for (const d of departures) expect(d.forCity).toBe(0);
    expect(departures[0]).toEqual({ full: true, forCity: 0, city: 2 });
    // Outside containers reach Dockside on the shuttle.
    expect(cs.stats.delivered).toBeGreaterThanOrEqual(4);
    // 20–30 s per move on average, none absurdly long.
    const mean = moveTimes.reduce((a, b) => a + b, 0) / moveTimes.length;
    expect(moveTimes.length).toBeGreaterThan(20);
    expect(mean).toBeGreaterThan(18);
    expect(mean).toBeLessThan(32);
    expect(Math.max(...moveTimes)).toBeLessThan(50);
  }, 180_000);

  it('gives Dockside a one-way yard road with a right turn in and a right turn out, clear of the level crossing', () => {
    for (const seed of [1337, 7, 42, 99, 5, 11, 2024]) {
      const city = generateCity(seed, { scale: 10 });
      const yard = city.rail.yardRoad;
      expect(yard, `seed ${seed}`).not.toBeNull();
      expect(city.roads.nodes[yard!.entry].signalized).toBe(false);
      expect(city.roads.nodes[yard!.exit].signalized).toBe(false);
      const sim = new Simulation(city, { civilianCount: 0 });
      const g = sim.traffic.graph;
      const lanes = g.lanes.filter((l) => l.yard);
      expect(lanes).toHaveLength(1);
      const into = g.connectors.filter((c) => c.toLane === lanes[0].id);
      const out = g.connectors.filter((c) => c.fromLane === lanes[0].id);
      expect(into.map((c) => c.turn)).toEqual(['right']);
      expect(out.map((c) => c.turn)).toEqual(['right']);
      // The lorry turns out towards the freight track: the crossing lies on the street lane beyond the T.
      expect(sim.rail.crossingsOn(out[0].toLane).length).toBe(1);
      // Two lorry spots with room to leave behind the front one.
      expect(sim.containers.lorrySpots).toHaveLength(2);
      expect(lanes[0].length - sim.containers.lorrySpots[0].s).toBeGreaterThan(24);
    }
  });

  it('runs two container lorries between the Dockside crane and the city, and nobody else uses the yard road', () => {
    const sim = new Simulation(generateCity(1337, { scale: 10 }), { civilianCount: 150 });
    const cs = sim.containers;
    const g = sim.traffic.graph;
    const lorries = sim.logistics.fleet.filter((l) => l.kind === 'container');
    expect(lorries).toHaveLength(2);
    const onYard = (segment: number) => {
      const s = g.segments[segment];
      return s.kind === 'lane' ? s.yard : (g.segments[s.toLane] as { yard: boolean }).yard;
    };
    const trips = new Map<number, number>();
    const prev = new Map<number, string>();
    for (let i = 0; i < 20 * 60 * 15; i++) {
      sim.step();
      for (const v of sim.traffic.vehicles) if (onYard(v.segment)) expect(v.yardAccess, `${v.role} on the yard road`).toBe(true);
      for (const l of lorries) {
        // Out with a container from outside, back with it for shipping.
        if (l.status === 'delivering') expect(l.lorry!.container?.outbound).toBe(false);
        if (prev.get(l.id) === 'unloading' && l.status === 'to_yard') {
          trips.set(l.id, (trips.get(l.id) ?? 0) + 1);
          expect(l.lorry!.container?.outbound).toBe(true);
        }
        prev.set(l.id, l.status);
      }
      if (i % 20 === 0) {
        expect(cs.all().length + cs.stats.left).toBe(cs.stats.created);
        const hit = findOverlap(sim.traffic.vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(1)} ${hit}`);
      }
    }
    for (const l of lorries) expect(trips.get(l.id) ?? 0, l.name).toBeGreaterThanOrEqual(2);
  }, 180_000);
});
