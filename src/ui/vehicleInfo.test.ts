import { describe, expect, it } from 'vitest';
import { Simulation } from '../sim/Simulation';
import { generateCity } from '../sim/world/cityGenerator';
import { describeSubject, subjectAlive, subjectForVehicle, subjectPosition } from './vehicleInfo';

const city = generateCity(1337, { scale: 10 });

describe('vehicle info card', () => {
  it('says who each vehicle is and where it is going', () => {
    const sim = new Simulation(city, { civilianCount: 40 });
    const home = city.buildings.find((b) => b.kind === 'house')!;
    sim.reportIncident('fire', home.id);
    sim.power.switchOff(0);
    sim.power.dispatchCrew(0);
    const info = (v: (typeof sim.traffic.vehicles)[number]) => describeSubject(sim, subjectForVehicle(sim, v));

    // Fire engine on its way: incident address on the card.
    const engine = sim.dispatcher.unitsOfType('fire')[0];
    for (let i = 0; i < 20 * 60 && engine.status !== 'en_route'; i++) sim.step();
    const engineInfo = info(engine.vehicle);
    expect(engineInfo).toMatchObject({ title: 'Engine 1', kind: 'Fire engine', status: 'En route' });
    expect(engineInfo.rows.some(([k]) => k === 'Fire'), JSON.stringify(engineInfo)).toBe(true);
    for (let i = 0; i < 20 * 90; i++) sim.step();

    // Lorries and vans: origin, customer and cargo.
    const lorry = sim.logistics.fleet.find((l) => l.kind === 'truck' && l.customer)!;
    const lorryInfo = info(lorry.vehicle);
    expect(lorryInfo.kind).toBe('Articulated lorry');
    expect(lorryInfo.rows.map(([k]) => k)).toEqual(expect.arrayContaining(['From', 'To', 'Cargo']));
    expect(lorryInfo.rows.find(([k]) => k === 'Cargo')![1]).toBe(lorry.cargo);

    // Civilians: the street they are on.
    const car = sim.traffic.vehicles.find((v) => v.role === 'civilian' && v.maneuver === 'driving')!;
    const carInfo = info(car);
    expect(carInfo.title).toBe(`Car ${car.id}`);
    expect(carInfo.rows[0][0]).toBe('On');

    // The crew's van is described as the crew.
    const crew = sim.power.crews.find((c) => c.vehicle)!;
    expect(subjectForVehicle(sim, crew.vehicle!)).toEqual({ kind: 'crew', crew });
    expect(info(crew.vehicle!)).toMatchObject({ title: crew.name, kind: 'Utility van' });

    // Trains: next stop and direction.
    const train = sim.rail.trains.find((t) => t.kind === 'passenger')!;
    const trainInfo = describeSubject(sim, { kind: 'train', train });
    expect(trainInfo.kind).toBe('Passenger train');
    expect(trainInfo.status).toMatch(/^(At|Next stop:|Leaving)/);
    const p = subjectPosition(sim, { kind: 'train', train });
    expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
  });

  it('counts the bins on a garbage round and notices when a vehicle has left', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    for (let i = 0; i < 20 * 120; i++) sim.step();
    const garbage = sim.logistics.fleet.find((l) => l.kind === 'garbage')!;
    expect(garbage.binsTotal).toBeGreaterThan(0);
    const subject = subjectForVehicle(sim, garbage.vehicle);
    expect(describeSubject(sim, subject).status).toMatch(/^Bin \d+ of \d+$|depot/);

    // Lorries go back into their yard after the round trip: the card notices.
    const lorry = sim.logistics.fleet.find((l) => l.kind === 'truck')!;
    const lorrySubject = subjectForVehicle(sim, lorry.vehicle);
    for (let i = 0; i < 20 * 900 && sim.logistics.fleet.includes(lorry); i++) sim.step();
    expect(sim.logistics.fleet.includes(lorry)).toBe(false);
    expect(subjectAlive(sim, lorrySubject)).toBe(false);
    expect(sim.logistics.stats.deliveries).toBeGreaterThan(0);
    expect(sim.logistics.stats.binsEmptied).toBeGreaterThan(0);
  });

  it('describes the gantry cranes: the move, the trains they work for and the stacks', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const [hub, dockside] = sim.containers.yards;
    const hubCrane = { kind: 'crane', yard: hub } as const;
    expect(subjectAlive(sim, hubCrane)).toBe(true);
    let info = describeSubject(sim, hubCrane);
    expect(info).toMatchObject({ title: 'Freight Hub crane', kind: 'Gantry crane', status: 'Idle' });
    expect(info.rows).toContainEqual(['Long-distance', 'Due in 1 min']);
    expect(info.rows).toContainEqual(['Stacks', '2 containers (0 in, 2 out)']);

    // The long-distance train arrives: the crane takes a container off it.
    for (let i = 0; i < 20 * 200 && !hub.crane.task; i++) sim.step();
    info = describeSubject(sim, hubCrane);
    expect(info.status).toMatch(/^Moving a container: long-distance train → (shuttle|stack)$/);
    expect(info.rows.find(([k]) => k === 'Long-distance')![1]).toMatch(/^Here, (about \d+ min|under a minute) of work left$/);
    expect(info.rows.find(([k]) => k === 'Container')![1]).toMatch(/^#\d+, from outside$/);
    const at = subjectPosition(sim, hubCrane);
    expect(Math.hypot(at.x - hub.origin.x, at.z - hub.origin.z)).toBeLessThan(80);

    // Dockside: the container lorries are counted.
    const docksideInfo = describeSubject(sim, { kind: 'crane', yard: dockside });
    expect(docksideInfo.title).toBe('Dockside Freight Terminal crane');
    expect(docksideInfo.rows.find(([k]) => k === 'Lorries')![1]).toMatch(/^\d at the crane, \d in town$/);
  });
});
