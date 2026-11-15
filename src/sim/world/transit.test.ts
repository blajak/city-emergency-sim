import { describe, expect, it } from 'vitest';
import { distanceToPolyline, samplePolyline } from '../math/geometry';
import { generateCity } from './cityGenerator';
import type { City } from './types';

function checkPlan(city: City): void {
  const { transit, roads } = city;
  expect(transit.lines).toHaveLength(3);
  for (const line of transit.lines) {
    // The route is a closed loop of connected streets without U-turns.
    const endOf = (i: number) => {
      const step = line.route[i];
      const edge = roads.edges[step.edgeId];
      return step.forward ? edge.to : edge.from;
    };
    line.route.forEach((step, i) => {
      const prev = line.route[(i - 1 + line.route.length) % line.route.length];
      const edge = roads.edges[step.edgeId];
      expect(step.forward ? edge.from : edge.to, `line ${line.name} step ${i}`).toBe(endOf((i - 1 + line.route.length) % line.route.length));
      expect(step.edgeId, `line ${line.name} U-turn at step ${i}`).not.toBe(prev.edgeId);
    });
    // Stops in route order, each on the kerb the bus drives along.
    expect(line.calls.length).toBeGreaterThanOrEqual(3);
    expect(line.turnCall).toBeGreaterThan(0);
    expect(line.turnCall).toBeLessThan(line.calls.length - 1);
    for (let k = 1; k < line.calls.length; k++) expect(line.calls[k].step).toBeGreaterThan(line.calls[k - 1].step);
    for (const call of line.calls) {
      const stop = transit.stops[call.stop];
      const step = line.route[call.step];
      expect(stop.edgeId).toBe(step.edgeId);
      expect(stop.side).toBe(step.forward ? 1 : -1);
    }
  }
}

describe('bus network', () => {
  it('plans three looping lines in the small town', () => {
    const city = generateCity(1337);
    checkPlan(city);
    expect(city.transit.depot).toBeNull();
  });

  it('plans three lines, a depot and stops ~300 m apart in the 10× city', () => {
    const city = generateCity(1337, { scale: 10 });
    checkPlan(city);
    const depot = city.buildings[city.transit.depot!];
    expect(depot.kind).toBe('bus_depot');
    expect(city.districts[depot.district].kind).toBe('industrial');
    expect(depot.bay).not.toBeNull();
    const { stops } = city.transit;
    expect(stops.some((s) => s.bay)).toBe(true);
    expect(stops.some((s) => !s.bay)).toBe(true);
    for (const line of city.transit.lines) {
      const length = line.route.reduce((sum, s) => sum + city.roads.edges[s.edgeId].length, 0);
      // Turning loops have no stops, so allow for them.
      expect(line.calls.length, `line ${line.name}`).toBeGreaterThanOrEqual(Math.floor(length / 300 / 2));
    }
  });

  it('keeps stops away from level crossings, delivery bays and each other', () => {
    for (const seed of [1337, 7, 42]) {
      const city = generateCity(seed, { scale: 10 });
      const { stops } = city.transit;
      for (const stop of stops) {
        const edge = city.roads.edges[stop.edgeId];
        const { point } = samplePolyline(edge.points, stop.s);
        for (const track of city.rail.tracks) expect(distanceToPolyline(point, track.points)).toBeGreaterThan(25);
        for (const other of stops) {
          if (other === stop || other.edgeId !== stop.edgeId || other.side !== stop.side) continue;
          expect(Math.abs(other.s - stop.s)).toBeGreaterThan(stop.length);
        }
        if (!stop.bay) continue;
        for (const b of city.buildings) {
          if (!b.bay || b.bay.edgeId !== stop.edgeId || b.bay.side !== stop.side) continue;
          expect(Math.abs(b.bay.s - stop.s)).toBeGreaterThan((b.bay.length + stop.length) / 2);
        }
      }
    }
  });
});
