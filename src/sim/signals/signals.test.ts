import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../math/geometry';
import { Simulation } from '../Simulation';
import type { Connector, Lane } from '../traffic/laneGraph';
import type { Vehicle } from '../traffic/vehicle';
import { generateCity } from '../world/cityGenerator';

describe('SignalSystem', () => {
  const sim = new Simulation(generateCity(1337), { civilianCount: 0 });
  const { signals, traffic } = sim;
  const graph = traffic.graph;

  it('controls every approach of every signalised intersection exactly once', () => {
    for (const node of sim.city.roads.nodes) {
      const approaches = graph.lanes.filter((l) => l.toNode === node.id).map((l) => l.id);
      const controller = signals.controllers.find((c) => c.nodeId === node.id);
      if (!node.signalized) {
        expect(controller).toBeUndefined();
        continue;
      }
      expect(controller).toBeDefined();
      expect(controller!.phases.flat().sort()).toEqual(approaches.sort());
      expect(controller!.phases.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('never shows green to crossing straight movements at the same time', () => {
    const straights = graph.connectors.filter((c) => c.turn === 'straight');
    for (let t = 0; t < 120 * 20; t++) {
      signals.step(0.05);
      for (const a of straights) {
        if (signals.lightFor(a.fromLane) !== 'green') continue;
        for (const id of a.conflicts) {
          const b = graph.segments[id] as Connector;
          if (b.turn !== 'straight') continue;
          expect(signals.lightFor(b.fromLane), `node ${a.nodeId}`).not.toBe('green');
        }
      }
    }
  });

  it('cycles green → yellow → red', () => {
    const lane = signals.controllers[0].phases[0][0];
    const seen = new Set<string>();
    for (let t = 0; t < 120 * 20; t++) {
      signals.step(0.05);
      seen.add(signals.lightFor(lane)!);
    }
    expect([...seen].sort()).toEqual(['green', 'red', 'yellow']);
  });
});

describe('traffic with signals', () => {
  for (const [seed, cars] of [
    [1337, 20],
    [99, 40],
  ] as const) {
    it(`obeys red lights and never collides (seed ${seed}, ${cars} cars)`, () => {
      const sim = new Simulation(generateCity(seed), { civilianCount: cars, fireUnits: 0, policeUnits: 0 });
      const { traffic, signals } = sim;
      const vehicles = traffic.vehicles.filter((v) => v.role === 'civilian');
      const footprint = (v: Vehicle) => ({
        center: { x: v.pose.x, z: v.pose.z },
        halfW: v.width / 2 - 0.2,
        halfD: v.length / 2 - 0.2,
        rotation: v.pose.yaw,
      });

      let redRuns = 0;
      for (let t = 0; t < 5 * 60 * 20; t++) {
        const before = vehicles.map((v) => v.segment);
        sim.step();
        vehicles.forEach((v, i) => {
          const prev = traffic.segment(before[i]);
          if (prev.kind === 'lane' && v.segment !== prev.id && signals.lightFor((prev as Lane).id) === 'red') {
            redRuns++;
          }
        });
        for (let i = 0; i < vehicles.length; i++) {
          for (let j = i + 1; j < vehicles.length; j++) {
            if (obbOverlap(footprint(vehicles[i]), footprint(vehicles[j]))) {
              throw new Error(`t=${sim.time.toFixed(2)} vehicles ${vehicles[i].id} and ${vehicles[j].id} overlap`);
            }
          }
        }
      }
      expect(redRuns).toBe(0);
      for (const v of vehicles) expect(v.odometer, `vehicle ${v.id}`).toBeGreaterThan(300);
    });
  }
});
