import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { generateCity } from '../world/cityGenerator';
import type { Building, City } from '../world/types';
import { priorityFor } from './types';

// Scale 3: small enough to be quick, big enough for a hospital and a mall.
const city = generateCity(1337, { scale: 3 });

function homes(c: City, count: number): Building[] {
  const list = c.buildings.filter((b) => b.kind === 'residential');
  return Array.from({ length: count }, (_, i) => list[Math.floor(((i + 0.5) / count) * list.length)]);
}

const kind = (k: Building['kind']) => city.buildings.find((b) => b.kind === k)!;

function run(sim: Simulation, seconds: number, until: () => boolean = () => false): void {
  for (let t = 0; t < seconds * 20 && !until(); t++) sim.step();
}

function report(sim: Simulation, type: 'fire' | 'crime', building: Building) {
  const r = sim.reportIncident(type, building.id);
  if (!r.ok) throw new Error(`report failed: ${r.reason}`);
  return r.incident;
}

describe('incident priorities', () => {
  it('ranks the power plant, then hospital / school / mall, then everything else', () => {
    expect(priorityFor(kind('power_plant'))).toBe('critical');
    for (const k of ['hospital', 'mall'] as const) expect(priorityFor(kind(k))).toBe('high');
    expect(priorityFor({ ...kind('office'), kind: 'school' })).toBe('high');
    expect(priorityFor(homes(city, 1)[0])).toBe('normal');
    expect(priorityFor(kind('office'))).toBe('normal');
  });

  it('serves a queued high-priority call before an older normal one', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const [a, b] = homes(city, 2);
    const first = report(sim, 'fire', a);
    run(sim, 300, () => first.status === 'on_scene');
    expect(first.status).toBe('on_scene');

    // Engine busy on scene: both new calls queue, the older one being normal.
    const older = report(sim, 'fire', b);
    run(sim, 4);
    const urgent = report(sim, 'fire', kind('hospital'));
    run(sim, 10);
    expect(older.status).toBe('queued');
    expect(urgent.status).toBe('queued');

    run(sim, 300, () => first.status === 'resolved');
    run(sim, 1);
    expect(urgent.status === 'assigned' || urgent.status === 'en_route').toBe(true);
    expect(older.status).toBe('queued');
  });

  it('diverts a unit driving to a normal call to a more urgent one, never one on scene', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const [engine] = sim.dispatcher.unitsOfType('fire');
    const diversions: string[] = [];
    sim.dispatcher.onDiverted = (unit, from, to) => diversions.push(`${unit.name}:${from.id}->${to.id}`);

    const normal = report(sim, 'fire', homes(city, 1)[0]);
    run(sim, 10, () => normal.status === 'assigned' || normal.status === 'en_route');
    expect(engine.incidentId).toBe(normal.id);

    const critical = report(sim, 'fire', kind('power_plant'));
    run(sim, 10, () => critical.status !== 'reported');
    expect(engine.incidentId).toBe(critical.id);
    expect(critical.unitId).toBe(engine.id);
    expect(normal).toMatchObject({ status: 'queued', unitId: null, scene: null, diverted: 1 });
    expect(diversions).toEqual([`Engine 1:${normal.id}->${critical.id}`]);

    // On scene the engine stays, even for another critical-looking call.
    run(sim, 400, () => critical.status === 'on_scene');
    expect(critical.status).toBe('on_scene');
    const high = report(sim, 'fire', kind('hospital'));
    run(sim, 10, () => high.status !== 'reported');
    expect(high.status).toBe('queued');
    expect(engine.incidentId).toBe(critical.id);

    // Afterwards: the hospital (high) first, then the diverted normal call.
    run(sim, 1500, () => normal.status === 'resolved');
    expect(high.status).toBe('resolved');
    expect(normal.status).toBe('resolved');
    expect(high.arrivedAt!).toBeLessThan(normal.arrivedAt!);
  });

  it('a diverted call ahead of newer calls of the same priority', () => {
    const sim = new Simulation(city, { civilianCount: 0 });
    const [a, b, c] = homes(city, 3);
    const dropped = report(sim, 'fire', a);
    run(sim, 10, () => dropped.status === 'assigned' || dropped.status === 'en_route');
    report(sim, 'fire', kind('mall'));
    run(sim, 10);
    expect(dropped.status).toBe('queued');
    const later = [report(sim, 'fire', b)];
    run(sim, 4);
    later.push(report(sim, 'fire', c));
    run(sim, 1800, () => dropped.status === 'resolved');
    expect(dropped.status).toBe('resolved');
    for (const i of later) expect(i.arrivedAt === null || i.arrivedAt > dropped.arrivedAt!).toBe(true);
  });

  it('a diverted call takes over a unit heading to a less urgent call in turn', () => {
    const sim = new Simulation(city, { civilianCount: 0, fireUnits: 2 });
    const normal = report(sim, 'fire', homes(city, 1)[0]);
    const high = report(sim, 'fire', kind('hospital'));
    run(sim, 10, () => [normal, high].every((i) => i.status === 'assigned' || i.status === 'en_route'));
    const highUnit = high.unitId;
    const normalUnit = normal.unitId;
    expect(highUnit).not.toBeNull();
    expect(normalUnit).not.toBeNull();

    const critical = report(sim, 'fire', kind('power_plant'));
    run(sim, 10, () => critical.status !== 'reported');
    expect(critical.unitId).not.toBeNull();
    // The hospital still has an engine; only the normal call is left waiting.
    expect(high.unitId).not.toBeNull();
    expect(high.status === 'assigned' || high.status === 'en_route').toBe(true);
    expect(normal.status).toBe('queued');
  });
});
