import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../math/geometry';
import { Simulation } from '../Simulation';
import type { Vehicle } from '../traffic/vehicle';
import { generateCity } from '../world/cityGenerator';
import type { City } from '../world/types';

const city = generateCity(1337);

/** Residential buildings spread across the map (deterministic). */
function targets(c: City, count: number) {
  const homes = c.buildings.filter((b) => b.kind === 'residential');
  return Array.from({ length: count }, (_, i) => homes[Math.floor(((i + 0.5) / count) * homes.length)]);
}

function runUntil(sim: Simulation, done: () => boolean, maxSeconds: number, onTick?: () => void): void {
  for (let t = 0; t < maxSeconds * 20 && !done(); t++) {
    sim.step();
    onTick?.();
  }
}

function assertNoOverlap(vehicles: readonly Vehicle[], time: number): void {
  const fp = (v: Vehicle) => ({
    center: { x: v.pose.x, z: v.pose.z },
    halfW: v.width / 2 - 0.2,
    halfD: v.length / 2 - 0.2,
    rotation: v.pose.yaw,
  });
  for (let i = 0; i < vehicles.length; i++) {
    for (let j = i + 1; j < vehicles.length; j++) {
      if (obbOverlap(fp(vehicles[i]), fp(vehicles[j]))) {
        throw new Error(`t=${time.toFixed(2)} ${vehicles[i].role} ${vehicles[i].id} overlaps ${vehicles[j].role} ${vehicles[j].id}`);
      }
    }
  }
}

describe('Dispatcher', () => {
  it('starts with one fire engine parked at the fire station', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    expect(sim.dispatcher.unitsOfType('fire')).toHaveLength(1);
    expect(sim.dispatcher.unitsOfType('fire')[0]).toMatchObject({ type: 'fire', status: 'at_station', name: 'Engine 1' });
  });

  it('rejects stations and buildings that already have an incident', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const station = city.buildings.find((b) => b.kind === 'fire_station')!;
    expect(sim.reportIncident('fire', station.id)).toEqual({ ok: false, reason: 'station' });
    const [home] = targets(city, 1);
    expect(sim.reportIncident('fire', home.id).ok).toBe(true);
    expect(sim.reportIncident('fire', home.id)).toEqual({ ok: false, reason: 'busy' });
  });

  it('handles a fire end to end and the engine returns to the station', () => {
    const sim = new Simulation(city, { civilianCount: 20 });
    const [home] = targets(city, 1);
    const result = sim.reportIncident('fire', home.id);
    if (!result.ok) throw new Error('report failed');
    const incident = result.incident;
    const [engine] = sim.dispatcher.unitsOfType('fire');
    const seen = new Set<string>();

    runUntil(
      sim,
      () => incident.status === 'resolved' && engine.status === 'at_station',
      600,
      () => {
        seen.add(incident.status);
        assertNoOverlap(sim.traffic.vehicles, sim.time);
      },
    );

    expect(incident.status).toBe('resolved');
    expect(engine.status).toBe('at_station');
    expect([...seen]).toEqual(expect.arrayContaining(['reported', 'assigned', 'en_route', 'on_scene', 'resolved']));
    expect(incident.arrivedAt! - incident.reportedAt).toBeLessThan(180);
    expect(incident.resolvedAt! - incident.arrivedAt!).toBeCloseTo(incident.duration, 0);
  });

  it('queues calls when every engine is busy and serves them in order', () => {
    const sim = new Simulation(city, { civilianCount: 20 });
    // Calls 4 s apart, so call-processing delays (3–6 s) can't reorder them.
    const ids = targets(city, 3).map((b, k) => {
      if (k > 0) runUntil(sim, () => false, 4);
      const r = sim.reportIncident('fire', b.id);
      if (!r.ok) throw new Error('report failed');
      return r.incident;
    });

    runUntil(sim, () => ids.every((i) => i.status !== 'reported'), 30);
    expect(ids.filter((i) => i.status === 'queued')).toHaveLength(2);

    runUntil(sim, () => ids.every((i) => i.status === 'resolved'), 1200, () =>
      assertNoOverlap(sim.traffic.vehicles, sim.time),
    );
    expect(ids.map((i) => i.status)).toEqual(['resolved', 'resolved', 'resolved']);
    // FIFO: arrival order follows report order.
    const arrivals = ids.map((i) => i.arrivedAt!);
    expect([...arrivals].sort((a, b) => a - b)).toEqual(arrivals);
  });

  it('sends the closest of several engines', () => {
    const sim = new Simulation(city, { civilianCount: 0, fireUnits: 3 });
    expect(sim.dispatcher.unitsOfType('fire')).toHaveLength(3);
    const fires = targets(city, 3).map((b) => {
      const r = sim.reportIncident('fire', b.id);
      if (!r.ok) throw new Error('report failed');
      return r.incident;
    });
    runUntil(sim, () => fires.every((i) => i.status === 'resolved'), 900);
    expect(fires.every((i) => i.status === 'resolved')).toBe(true);
    // All three engines worked in parallel: nobody waited in the queue.
    expect(new Set(fires.map((i) => i.unitId)).size).toBe(3);
  });
});
