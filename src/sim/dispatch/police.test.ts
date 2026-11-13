import { describe, expect, it } from 'vitest';
import { obbOverlap } from '../math/geometry';
import { Simulation } from '../Simulation';
import type { Vehicle } from '../traffic/vehicle';
import { generateCity } from '../world/cityGenerator';

const city = generateCity(1337);
const homes = city.buildings.filter((b) => b.kind === 'residential');
const home = (k: number) => homes[Math.floor(((k + 0.5) / 4) * homes.length)];

function run(sim: Simulation, seconds: number, until: () => boolean = () => false, check = true): void {
  for (let t = 0; t < seconds * 20 && !until(); t++) {
    sim.step();
    if (check) assertNoOverlap(sim.traffic.vehicles, sim.time);
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

function report(sim: Simulation, type: 'fire' | 'crime', k: number) {
  const r = sim.reportIncident(type, home(k).id);
  if (!r.ok) throw new Error(`report failed: ${r.reason}`);
  return r.incident;
}

describe('police', () => {
  it('sends the only patrol car out on patrol right away', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    sim.step();
    const [patrol] = sim.dispatcher.unitsOfType('police');
    expect(patrol.status).toBe('patrolling');
    run(sim, 60);
    expect(patrol.vehicle.odometer).toBeGreaterThan(200);
  });

  it('handles a crime and the single car resumes patrol instead of going home', () => {
    const sim = new Simulation(city, { civilianCount: 20 });
    const [car] = sim.dispatcher.unitsOfType('police');
    const crime = report(sim, 'crime', 1);
    const statuses = new Set<string>();
    run(sim, 400, () => {
      statuses.add(car.status);
      return crime.status === 'resolved' && car.status === 'patrolling';
    });
    expect(crime.status).toBe('resolved');
    expect(crime.duration).toBeGreaterThanOrEqual(10);
    expect(crime.duration).toBeLessThanOrEqual(25);
    expect([...statuses]).toEqual(expect.arrayContaining(['patrolling', 'en_route', 'on_scene']));
    expect(car.status).toBe('patrolling');
  });

  it('replaces a dispatched patroller from the station, and the responder then returns home', () => {
    const sim = new Simulation(city, { civilianCount: 20, policeUnits: 2 });
    run(sim, 1);
    const [a, b] = sim.dispatcher.unitsOfType('police');
    const patroller = a.status === 'patrolling' ? a : b;
    const reserve = patroller === a ? b : a;
    expect(reserve.status).toBe('at_station');

    // Put the crime right next to the patroller so it is the fastest unit.
    const crime = report(sim, 'crime', 2);
    run(sim, 10, () => crime.unitId !== null);
    const responder = sim.dispatcher.unit(crime.unitId)!;
    const other = responder === a ? b : a;
    run(sim, 1);
    // Whoever responded, the other car must now be patrolling.
    expect(other.status).toBe('patrolling');

    run(sim, 500, () => crime.status === 'resolved' && responder.status === 'at_station');
    expect(crime.status).toBe('resolved');
    expect(responder.status).toBe('at_station');
    expect(sim.dispatcher.unitsOfType('police').filter((u) => u.status === 'patrolling')).toHaveLength(1);
  });

  it('serves fires and crimes in parallel with separate unit types', () => {
    const sim = new Simulation(city, { civilianCount: 20 });
    const fire = report(sim, 'fire', 0);
    const crime = report(sim, 'crime', 3);
    run(sim, 600, () => fire.status === 'resolved' && crime.status === 'resolved');
    expect(sim.dispatcher.unit(fire.unitId)!.type).toBe('fire');
    expect(sim.dispatcher.unit(crime.unitId)!.type).toBe('police');
    expect([fire.status, crime.status]).toEqual(['resolved', 'resolved']);
  });
});

describe('station units', () => {
  it('allows 1–3 units per station, removing only units at the station', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const d = sim.dispatcher;
    const [engine1] = d.unitsOfType('fire');
    expect(d.removalBlocker(engine1)).toMatch(/at least one/);

    const engine2 = d.addUnit('fire')!;
    const engine3 = d.addUnit('fire')!;
    expect(d.addUnit('fire')).toBeNull();
    expect(d.unitsOfType('fire').map((u) => u.name)).toEqual(['Engine 1', 'Engine 2', 'Engine 3']);

    expect(d.removeUnit(engine2.id)).toBe(true);
    expect(sim.traffic.vehicles).not.toContain(engine2.vehicle);
    // Freed name and slot are reused.
    const again = d.addUnit('fire')!;
    expect(again.name).toBe('Engine 2');
    expect(again.slot).toBe(engine2.slot);

    // A busy unit can't be removed.
    report(sim, 'fire', 1);
    run(sim, 10, () => d.unitsOfType('fire').some((u) => u.status === 'en_route'), false);
    const busy = d.unitsOfType('fire').find((u) => u.status === 'en_route')!;
    expect(d.removalBlocker(busy)).toMatch(/Only units waiting/);
    expect(d.removeUnit(busy.id)).toBe(false);
    expect(engine3).toBeDefined();
  });

  it('a patrolling police car cannot be removed', () => {
    const sim = new Simulation(city, { civilianCount: 0, policeUnits: 2 });
    sim.step();
    const patroller = sim.dispatcher.unitsOfType('police').find((u) => u.status === 'patrolling')!;
    expect(sim.dispatcher.removeUnit(patroller.id)).toBe(false);
  });
});
