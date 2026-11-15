import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../math/geometry';
import { createRng } from '../math/rng';
import { SpatialGrid, obbBox } from '../math/spatialGrid';
import { Simulation } from '../Simulation';
import type { Pose } from '../traffic/vehicle';
import { generateCity } from '../world/cityGenerator';

interface Body {
  id: string;
  pose: Pose;
  width: number;
  length: number;
}

const footprint = (b: Body) => ({ center: { x: b.pose.x, z: b.pose.z }, halfW: b.width / 2 - 0.2, halfD: b.length / 2 - 0.2, rotation: b.pose.yaw });

function findOverlap(bodies: readonly Body[]): string | null {
  const grid = new SpatialGrid<Body>(12);
  for (const b of bodies) {
    const box = footprint(b);
    for (const other of grid.query(obbBox(box))) if (obbOverlap(box, footprint(other))) return `${b.id} / ${other.id}`;
    grid.insert(b, obbBox(box));
  }
  return null;
}

describe('buses', () => {
  it('serve their stops, overtaken in the lane, leave and enter the depot yard, collision-free', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 250, fireUnits: 2, policeUnits: 2 });
    const rng = createRng(4);
    const homes = city.buildings.filter((b) => b.kind === 'residential');
    const startIds = new Set(sim.buses.buses.map((b) => b.id));
    expect(startIds.size).toBeGreaterThanOrEqual(6);
    const yardStart = sim.buses.yard.length;
    expect(yardStart).toBeGreaterThan(0);

    const served = new Map<string, Set<number>>();
    let overtakes = 0;
    let yardExits = 0;
    let yardEntries = 0;
    for (let step = 0; step < 16 * 60 * 20; step++) {
      if (step % 300 === 0) sim.reportIncident(rng.chance(0.5) ? 'fire' : 'crime', rng.pick(homes).id);
      const overtakingBefore = new Set(sim.traffic.vehicles.filter((v) => v.overtaking !== null).map((v) => v.id));
      const leavingBefore = sim.buses.yard.filter((y) => y.pullOut).length;
      const yardBefore = sim.buses.yard.length;
      sim.step();
      for (const v of sim.traffic.vehicles) if (v.overtaking !== null && !overtakingBefore.has(v.id)) overtakes++;
      if (sim.buses.yard.length > yardBefore) yardEntries++;
      if (sim.buses.yard.filter((y) => y.pullOut).length < leavingBefore) yardExits++;
      for (const bus of sim.buses.buses) {
        if (bus.status !== 'at_stop' && bus.status !== 'layover') continue;
        const set = served.get(bus.line.name) ?? new Set<number>();
        set.add(bus.line.calls[bus.call].stop);
        served.set(bus.line.name, set);
      }
      const bodies: Body[] = [
        ...sim.traffic.vehicles.map((v) => ({ id: `${v.role}${v.id}`, pose: v.pose, width: v.width, length: v.length })),
        ...sim.buses.yard.map((y, i) => ({ id: `yard${i}`, pose: y.pose, width: 2.55, length: 11 })),
      ];
      const hit = findOverlap(bodies);
      if (hit) throw new Error(`t=${sim.time.toFixed(2)} overlap: ${hit}`);
    }

    for (const line of city.transit.lines) {
      // Every line has served most of its stops by now.
      expect(served.get(line.name)?.size ?? 0, `line ${line.name}`).toBeGreaterThanOrEqual(Math.ceil(line.calls.length / 2));
    }
    expect(overtakes).toBeGreaterThan(0);
    // Fresh buses came out of the yard and joined the road; tired ones went back in.
    expect(yardExits).toBeGreaterThan(0);
    expect(sim.buses.buses.some((b) => !startIds.has(b.id))).toBe(true);
    expect(yardEntries).toBeGreaterThan(0);
  });
});
