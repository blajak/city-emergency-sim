import { describe, expect, it } from 'vitest';
import { type OBB, obbOverlap } from '../math/geometry';
import { Simulation } from '../Simulation';
import { generateCity } from '../world/cityGenerator';
import { buildLaneGraph, type Connector } from './laneGraph';
import type { Vehicle } from './vehicle';

const city = generateCity(1337);

function footprint(v: Vehicle, shrink: number): OBB {
  return {
    center: { x: v.pose.x, z: v.pose.z },
    halfW: v.width / 2 - shrink,
    halfD: v.length / 2 - shrink,
    rotation: v.pose.yaw,
  };
}

describe('buildLaneGraph', () => {
  const graph = buildLaneGraph(city.roads);

  it('creates two lanes per street', () => {
    expect(graph.lanes).toHaveLength(city.roads.edges.length * 2);
  });

  it('lets every lane continue somewhere and never U-turns', () => {
    for (const lane of graph.lanes) {
      expect(lane.outConnectors.length).toBeGreaterThan(0);
      for (const id of lane.outConnectors) {
        const c = graph.segments[id] as Connector;
        expect(graph.segments[c.toLane].kind).toBe('lane');
        expect((graph.segments[c.toLane] as typeof lane).edgeId).not.toBe(lane.edgeId);
      }
    }
  });

  it('marks crossing movements as conflicting, symmetrically', () => {
    for (const c of graph.connectors) {
      for (const other of c.conflicts) {
        expect((graph.segments[other] as Connector).conflicts).toContain(c.id);
      }
    }
    // A 4-way intersection has left turns crossing oncoming straights.
    expect(graph.connectors.some((c) => c.turn === 'left' && c.conflicts.length > 0)).toBe(true);
  });
});

describe('civilian traffic', () => {
  const scenarios: [seed: number, cars: number][] = [
    [1337, 20],
    [7, 20],
    [2024, 40],
    [99, 60], // heavy traffic, 3x the target
  ];
  for (const [seed, cars] of scenarios) {
    it(`runs 5 minutes without collisions or gridlock (seed ${seed}, ${cars} cars)`, () => {
      const sim = new Simulation(generateCity(seed), { civilianCount: cars, fireUnits: 0, policeUnits: 0 });
      const vehicles = sim.traffic.vehicles.filter((v) => v.role === 'civilian');
      expect(vehicles).toHaveLength(cars);

      const ticks = 5 * 60 * 20;
      for (let t = 0; t < ticks; t++) {
        sim.step();
        for (let i = 0; i < vehicles.length; i++) {
          for (let j = i + 1; j < vehicles.length; j++) {
            const a = vehicles[i];
            const b = vehicles[j];
            if (obbOverlap(footprint(a, 0.2), footprint(b, 0.2))) {
              throw new Error(
                `t=${sim.time.toFixed(2)}s vehicles ${a.id} (seg ${a.segment}, s=${a.s.toFixed(1)}) and ` +
                  `${b.id} (seg ${b.segment}, s=${b.s.toFixed(1)}) overlap`,
              );
            }
          }
        }
      }

      for (const v of vehicles) {
        // Average under 50 km/h with stops, but every car must keep moving.
        expect(v.odometer, `vehicle ${v.id}`).toBeGreaterThan(300);
      }
    });
  }
});
