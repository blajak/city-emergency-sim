import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import type { Vehicle } from '../traffic/vehicle';
import { generateCity } from '../world/cityGenerator';

const city = generateCity(1337, { scale: 10 });

function vehicleOverlap(vehicles: readonly Vehicle[]): boolean {
  return findOverlap(vehicles) !== null;
}

describe('railway', () => {
  it('finds a level crossing wherever a street crosses the tracks', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const { crossings } = sim.rail;
    // Every north–south street across the main line, plus the freight line's streets.
    expect(crossings.length).toBeGreaterThanOrEqual(15);
    for (const c of crossings) {
      expect(c.lanes).toHaveLength(2);
      for (const lc of c.lanes) {
        expect(lc.stopS).toBeLessThan(lc.startS);
        expect(lc.startS).toBeLessThan(lc.endS);
      }
    }
    expect(crossings.some((c) => c.tracks.length >= 2)).toBe(true);
  });

  it('runs trains on time and never lets a train meet a car on a crossing', () => {
    const sim = new Simulation(city, { civilianCount: 250 });
    const rail = sim.rail;
    let unsafe = 0;
    let carOnClosedCrossing = 0;
    for (let t = 0; t < 6 * 60 * 20; t++) {
      sim.step();
      for (const c of rail.crossings) {
        if (c.state === 'closed' && c.occupied) carOnClosedCrossing++;
        const trainOn = rail.trains.some((train) =>
          c.tracks.some((x) => x.trackId === train.track.id && x.s > train.s - train.length - 2 && x.s < train.s + 2),
        );
        if (trainOn && c.occupied) unsafe++;
      }
      // Trains on the same track keep their distance.
      for (const a of rail.trains) {
        for (const b of rail.trains) {
          if (a !== b && a.track === b.track) {
            expect(a.s - a.length > b.s || b.s - b.length > a.s, `trains ${a.id}/${b.id} overlap`).toBe(true);
          }
        }
      }
      if (t % 20 === 0 && vehicleOverlap(sim.traffic.vehicles)) throw new Error(`vehicles overlap at t=${sim.time.toFixed(1)}`);
    }
    expect(unsafe).toBe(0);
    expect(carOnClosedCrossing).toBe(0);
    // Two directions × two stations, roughly one train per direction every 150 s.
    expect(rail.stats.stationStops).toBeGreaterThanOrEqual(8);
    // The freight shuttle made it to the terminal and back at least once.
    expect(rail.stats.freightTrips).toBeGreaterThanOrEqual(2);
    // Crossings do open again.
    expect(rail.crossings.filter((c) => c.state === 'open').length).toBeGreaterThan(rail.crossings.length / 2);
  });

  it('keeps cars moving through the city while trains run', () => {
    const sim = new Simulation(city, { civilianCount: 200 });
    for (let t = 0; t < 4 * 60 * 20; t++) sim.step();
    const civilians = sim.traffic.vehicles.filter((v) => v.role === 'civilian');
    const stuck = civilians.filter((v) => v.odometer < 100);
    expect(stuck.length).toBeLessThan(civilians.length * 0.05);
  });
});
