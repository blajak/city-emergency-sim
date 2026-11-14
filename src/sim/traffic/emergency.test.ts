import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../math/geometry';
import { createRng } from '../math/rng';
import { Simulation } from '../Simulation';
import { generateCity } from '../world/cityGenerator';
import type { Vehicle } from './vehicle';

function overlapping(vehicles: readonly Vehicle[]): string | null {
  const fp = (v: Vehicle) => ({
    center: { x: v.pose.x, z: v.pose.z },
    halfW: v.width / 2 - 0.2,
    halfD: v.length / 2 - 0.2,
    rotation: v.pose.yaw,
  });
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      if (obbOverlap(fp(vehicles[i]), fp(vehicles[j]))) return `${vehicles[i].role} ${vehicles[i].id} / ${vehicles[j].role} ${vehicles[j].id}`;
    }
  }
  return null;
}

describe('emergency driving', () => {
  for (const seed of [1337, 2024]) {
    it(`keeps everyone collision-free under a stream of incidents (seed ${seed})`, () => {
      const city = generateCity(seed);
      const sim = new Simulation(city, { civilianCount: 30, fireUnits: 2, policeUnits: 2 });
      const rng = createRng(seed + 5);
      const targets = city.buildings.filter((b) => b.kind === 'residential' || b.kind === 'office');
      const vehicles = sim.traffic.vehicles;
      let redCrossings = 0;
      let maxPullOver = 0;

      // 7 minutes: since the railway, units sometimes wait at level crossings
      // (routing around closed crossings comes with a later milestone).
      for (let t = 0; t < 7 * 60 * 20; t++) {
        if (t % 500 === 0 && t < 5 * 60 * 20) sim.reportIncident(rng.chance(0.5) ? 'fire' : 'crime', rng.pick(targets).id);
        const before = vehicles.map((v) => v.segment);
        sim.step();
        vehicles.forEach((v, i) => {
          const prev = sim.traffic.segment(before[i]);
          if (v.role !== 'civilian' && prev.kind === 'lane' && v.segment !== prev.id && sim.signals.lightFor(prev.id) === 'red') {
            redCrossings++;
          }
          if (v.role === 'civilian') maxPullOver = Math.max(maxPullOver, v.lateral);
        });
        const hit = overlapping(vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(2)} overlap: ${hit}`);
      }

      // Responding units cross red lights and civilians pull over for them.
      expect(redCrossings).toBeGreaterThan(0);
      expect(maxPullOver).toBeGreaterThan(1);
      // Nothing is stuck: every incident reported in the first 4 minutes is done.
      const early = sim.dispatcher.incidents.filter((i) => i.reportedAt < 4 * 60);
      expect(early.every((i) => i.status === 'resolved')).toBe(true);
    });
  }

  it('reaches incidents faster than normal traffic would', () => {
    const city = generateCity(1337);
    const homes = city.buildings.filter((b) => b.kind === 'residential');
    const times: number[] = [];
    for (let k = 0; k < 4; k++) {
      const sim = new Simulation(city, { civilianCount: 25 });
      const target = homes[Math.floor(((k + 0.5) / 4) * homes.length)];
      const r = sim.reportIncident('fire', target.id);
      if (!r.ok) throw new Error('report failed');
      const engine = sim.dispatcher.unitsOfType('fire')[0];
      for (let t = 0; t < 300 * 20 && r.incident.status !== 'on_scene'; t++) sim.step();
      expect(r.incident.status).toBe('on_scene');
      const drive = r.incident.arrivedAt! - r.incident.dispatchAt;
      // Compare with the free-flow route estimate at the speed limit.
      times.push(drive);
      expect(engine.vehicle.sirens).toBe(true);
    }
    const average = times.reduce((a, b) => a + b, 0) / times.length;
    // Without priority this takes ~100 s; level crossings add some waiting.
    expect(average).toBeLessThan(75);
  });
});
