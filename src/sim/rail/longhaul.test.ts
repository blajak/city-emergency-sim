import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';

describe('long-distance freight', () => {
  it('has a siding from the east tunnel into the hub only in cities with a freight line', () => {
    const small = generateCity(1337, { scale: 1 });
    expect(small.rail.tracks.some((t) => t.kind === 'longhaul')).toBe(false);
    const city = generateCity(1337, { scale: 10 });
    const siding = city.rail.tracks.find((t) => t.kind === 'longhaul')!;
    expect(siding).toBeDefined();
    // Starts at the east edge of the map, ends inside the freight hub's block.
    expect(siding.points[0].x).toBeGreaterThan(city.bounds.maxX - 1);
    const hub = city.rail.sites.find((s) => s.kind === 'freight_hub')!;
    const end = siding.points[siding.points.length - 1];
    const xs = hub.block.corners.map((c) => c.x);
    expect(end.x).toBeGreaterThan(Math.min(...xs));
    expect(end.x).toBeLessThan(Math.max(...xs));
  });

  it('comes out of the tunnel, stays in the hub clear of the street, and backs out again', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 120 });
    const { rail } = sim;
    const siding = city.rail.tracks.find((t) => t.kind === 'longhaul')!;
    const crossings = rail.crossings.filter((c) => c.tracks.some((t) => t.trackId === siding.id));
    expect(crossings.length).toBeGreaterThanOrEqual(1);

    const seen = new Set<number>();
    let dwellSamples = 0;
    let crossingOpenWhileDwelling = 0;
    let unsafe = 0;
    for (let i = 0; i < 20 * 660; i++) {
      sim.step();
      const trains = rail.trains.filter((t) => t.kind === 'longhaul');
      expect(trains.length).toBeLessThanOrEqual(1);
      for (const t of trains) {
        seen.add(t.id);
        if (t.dwell > 0) {
          dwellSamples++;
          expect(t.stoppedAt).toBe('Freight Hub');
          // The whole train stands beyond the street crossing.
          for (const c of crossings) {
            const at = c.tracks.find((x) => x.trackId === siding.id)!.s;
            expect(t.s - t.length).toBeGreaterThan(at + 3);
            if (c.state === 'open') crossingOpenWhileDwelling++;
          }
        }
      }
      for (const c of rail.crossings) {
        const onIt = rail.trains.some((t) => c.tracks.some((x) => x.trackId === t.track.id && x.s > t.s - t.length - 1 && x.s < t.s + 1));
        if (onIt && c.occupied) unsafe++;
      }
      if (i % 20 === 0) {
        const hit = findOverlap(sim.traffic.vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(1)} ${hit}`);
      }
    }
    // First train at 60 s, the next one 8 minutes later; each stayed in the hub and left.
    expect(seen.size).toBe(2);
    expect(rail.stats.longhaulVisits).toBe(2);
    expect(dwellSamples).toBeGreaterThan(20 * 200);
    // Road traffic gets the crossing back while the train stands in the hub.
    expect(crossingOpenWhileDwelling).toBeGreaterThan(dwellSamples * 0.5);
    expect(unsafe).toBe(0);
    // The shuttle to Dockside keeps running.
    expect(rail.stats.freightTrips).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('fits the whole train (a loco at each end, four wagons) into the hub, clear of the street, in every big city', () => {
    for (const seed of [1337, 7, 42, 99, 5, 11, 2024]) {
      const sim = new Simulation(generateCity(seed, { scale: 10 }), { civilianCount: 0 });
      const lh = sim.rail.longhaul!;
      expect(lh, `seed ${seed}`).not.toBeNull();
      expect(lh.wagons).toBe(4);
      expect(lh.cars.map((c) => c.model)).toEqual(['freight_loco', ...Array(4).fill('container_wagon'), 'freight_loco']);
      expect(lh.length).toBe(79);
      const stopTail = lh.track.length - 3 - lh.length;
      for (const c of sim.rail.crossings) {
        for (const t of c.tracks.filter((x) => x.trackId === lh.track.id)) expect(stopTail, `seed ${seed}`).toBeGreaterThan(t.s + 5);
      }
    }
  });
});
