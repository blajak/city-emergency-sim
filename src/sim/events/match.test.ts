import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';
import { ARRIVAL_TIME, MATCH_TIME, type MatchEvent } from './matchSystem';

describe('match day at the stadium', () => {
  it('cannot be organised in a town without a stadium', () => {
    const sim = new Simulation(generateCity(1337, { scale: 1 }), { civilianCount: 0 });
    expect(sim.match.canOrganise()).toBe(false);
    expect(sim.match.organise()).toBe(false);
  });

  it('fills the car park before and during the match, keeps duty units off other calls, then everyone leaves', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 150 });
    const m = sim.match;
    for (let i = 0; i < 100; i++) sim.step();
    expect(m.canOrganise()).toBe(true);
    expect(m.organise()).toBe(true);
    expect(m.organise()).toBe(false); // one at a time
    const fans = m.fans.length;
    expect(fans).toBeLessThanOrEqual(m.spaces.length);
    expect(fans).toBeGreaterThanOrEqual(Math.round(m.spaces.length * 0.85));

    const events: MatchEvent[] = [];
    let parkedAtKickOff = 0;
    let parkedAtWhistle = 0;
    let crime: ReturnType<typeof sim.reportIncident> | null = null;
    const start = sim.time;
    const dutyParked = new Set<string>();
    for (let i = 0; i < 20 * 900 && !(m.phase === 'idle' && events.some((e) => e.kind === 'car_park_empty')); i++) {
      sim.step();
      for (const e of m.drainEvents()) {
        events.push(e);
        if (e.kind === 'kick_off') parkedAtKickOff = m.parked();
        if (e.kind === 'final_whistle') parkedAtWhistle = m.parked();
      }
      // Never more than one car per space, and each where its space is.
      const parked = m.fans.filter((f) => f.status === 'parked');
      expect(new Set(parked.map((f) => f.space)).size).toBe(parked.length);
      for (const f of parked) {
        const space = m.spaces[f.space];
        expect(f.vehicle!.segment).toBe(space.segment);
        expect(Math.abs(f.vehicle!.s - space.s)).toBeLessThan(1);
      }
      // Duty units stand in their own spaces.
      for (const u of m.duty) {
        if (u.vehicle.maneuver !== 'parked') continue;
        const space = m.dutySpaces.get(u.type)!;
        expect(u.vehicle.segment).toBe(space.segment);
        expect(Math.abs(u.vehicle.s - space.s)).toBeLessThan(1);
        dutyParked.add(u.type);
      }
      // A crime during the match: the only police car is on duty, so it waits.
      if (m.phase === 'playing' && !crime) {
        crime = sim.reportIncident('crime', city.buildings.find((b) => b.kind === 'house')!.id);
      }
      if (m.phase === 'playing' && crime?.ok) {
        expect(sim.dispatcher.unitsOfType('police').every((u) => u.status === 'on_duty' || u.status === 'en_route')).toBe(true);
        if (sim.time > m.kickOff + 30) expect(crime.incident.unitId).toBeNull();
      }
      if (i % 20 === 0) {
        const hit = findOverlap(sim.traffic.vehicles);
        if (hit) throw new Error(`t=${sim.time.toFixed(1)} ${hit}`);
      }
    }
    expect(events.map((e) => e.kind).filter((k) => k !== 'goal')).toEqual(['announced', 'kick_off', 'final_whistle', 'car_park_empty']);
    expect(m.kickOff - start).toBeCloseTo(ARRIVAL_TIME, 0);
    expect(m.whistle - m.kickOff).toBeCloseTo(MATCH_TIME, 0);
    const whistle = events.find((e) => e.kind === 'final_whistle') as Extract<MatchEvent, { kind: 'final_whistle' }>;
    expect(whistle.home + whistle.away).toBe(events.filter((e) => e.kind === 'goal').length);
    // About half the fans are in before kick-off, nearly all by the end of the match.
    expect(parkedAtKickOff).toBeGreaterThanOrEqual(fans * 0.4);
    expect(parkedAtWhistle).toBeGreaterThanOrEqual(fans * 0.85);
    // The car park empties within a few minutes; the duty units are released.
    expect([...dutyParked].sort()).toEqual(['ambulance', 'police']);
    expect(m.phase).toBe('idle');
    expect(sim.time - m.whistle).toBeLessThan(420);
    expect(m.parked()).toBe(0);
    for (const u of sim.dispatcher.units) expect(u.status).not.toBe('on_duty');
    expect(m.duty).toHaveLength(0);
    // The police car takes the waiting call once free.
    for (let i = 0; i < 20 * 60 && crime?.ok && crime.incident.unitId === null; i++) sim.step();
    if (crime?.ok) expect(crime.incident.unitId).not.toBeNull();
    expect(m.canOrganise()).toBe(true);
  }, 180_000);
});
