import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';

const city = generateCity(42, { scale: 10 });
const targets = city.buildings.filter((b) => ['residential', 'house', 'apartment', 'office', 'shop'].includes(b.kind));

/**
 * Ten minutes with a call every 35 s; returns how long responders stood at
 * closed level crossings, and how often they switched to a detour on the way.
 */
function respond(crossingAware: boolean) {
  const sim = new Simulation(city, { civilianCount: 150, fireUnits: 2, policeUnits: 2 });
  if (!crossingAware) (sim.rail as unknown as { expectedWait: undefined }).expectedWait = undefined;
  let barrierWait = 0;
  let k = 0;
  for (let i = 0; i < 20 * 600; i++) {
    if (i % (20 * 35) === 0) {
      sim.reportIncident(k % 2 ? 'crime' : 'fire', targets[(k * 7919 + 42) % targets.length].id);
      k++;
    }
    sim.step();
    for (const v of sim.traffic.vehicles) {
      if (!v.sirens || v.maneuver !== 'driving' || v.v >= 0.5) continue;
      for (const lc of sim.rail.crossingsOn(v.segment)) {
        if (lc.crossing.state !== 'open' && v.s < lc.stopS + 0.5 && v.s > lc.stopS - 40) barrierWait += 0.05;
      }
    }
    if (i % 20 === 0) {
      const overlap = findOverlap(sim.traffic.vehicles);
      if (overlap) throw new Error(`t=${sim.time.toFixed(1)} ${overlap}`);
    }
  }
  const arrived = sim.dispatcher.incidents.filter((i) => i.arrivedAt !== null).length;
  return { barrierWait, arrived };
}

describe('crossing-aware routing of responders', () => {
  it('spends far less time at closed level crossings than routing without the train forecast', () => {
    const aware = respond(true);
    const plain = respond(false);
    // Enough closed-crossing encounters without the forecast to make the comparison meaningful.
    expect(plain.barrierWait).toBeGreaterThan(8);
    expect(aware.barrierWait).toBeLessThan(plain.barrierWait / 3);
    expect(aware.arrived).toBeGreaterThanOrEqual(plain.arrived - 1);
  }, 120_000);
});
