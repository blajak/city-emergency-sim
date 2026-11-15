import { describe, expect, it } from 'vitest';
import { Simulation } from '../Simulation';
import { findOverlap } from '../testing/overlap';
import { generateCity } from '../world/cityGenerator';

describe('power grid', () => {
  it('has a substation in every district and a depot with a van spot per crew', () => {
    for (const scale of [1, 10]) {
      const city = generateCity(1337, { scale });
      expect(city.power.plant).not.toBeNull();
      expect(city.power.substations.every((s) => s !== null)).toBe(true);
      city.power.substations.forEach((id, district) => expect(city.buildings[id!].district).toBe(district));
      expect(city.power.depot).not.toBeNull();
      expect(city.power.depotSpots).toBe(scale >= 2 ? 2 : 1);
    }
  });

  it('switching a district off darkens its lights; a crew drives out, repairs it and parks again', () => {
    const city = generateCity(1337, { scale: 10 });
    const sim = new Simulation(city, { civilianCount: 150 });
    const { power, signals } = sim;
    const district = 2;

    power.switchOff(district);
    expect(power.isOn(district)).toBe(false);
    const dark = signals.controllers.filter((c) => signals.isDark(c.nodeId));
    expect(dark.length).toBeGreaterThan(0);
    // A dark junction shows no light at all: it works as an unsignalised one.
    for (const lane of dark[0].phases.flat()) expect(signals.lightFor(lane)).toBeNull();

    // A manual cut stays until someone acts.
    for (let i = 0; i < 20 * 30; i++) sim.step();
    expect(power.isOn(district)).toBe(false);

    const sent = power.dispatchCrew(district);
    expect(sent.ok).toBe(true);
    const seen = new Set<string>();
    for (let i = 0; i < 20 * 60 * 10 && !(power.isOn(district) && power.crews.every((c) => c.status === 'at_depot')); i++) {
      sim.step();
      for (const c of power.crews) seen.add(c.status);
      const hit = findOverlap(sim.traffic.vehicles);
      if (hit) throw new Error(`t=${sim.time.toFixed(2)} overlap: ${hit}`);
    }
    expect(power.isOn(district)).toBe(true);
    expect(signals.controllers.some((c) => signals.isDark(c.nodeId))).toBe(false);
    for (const status of ['leaving', 'to_substation', 'repairing', 'returning', 'entering']) expect(seen.has(status), status).toBe(true);
    expect(power.crews.every((c) => c.status === 'at_depot' && c.vehicle === null)).toBe(true);
  });

  it('a fire at the plant cuts a district; the crew repairs it only after the fire is out', () => {
    const city = generateCity(1337);
    const sim = new Simulation(city, { civilianCount: 15 });
    const { power } = sim;
    const report = sim.reportIncident('fire', city.power.plant!);
    expect(report.ok).toBe(true);
    sim.step();
    const cut = power.districts.find((d) => !d.on)!;
    expect(cut.cause).toBe('fire');
    expect(power.dispatchCrew(cut.district)).toEqual({ ok: false, reason: 'fire' });
    expect(power.switchOn(cut.district)).toBe(false);

    let crewLeftBeforeFireOut = false;
    for (let i = 0; i < 20 * 60 * 15 && !power.isOn(cut.district); i++) {
      sim.step();
      if (report.ok && report.incident.status !== 'resolved' && power.crews.some((c) => c.status !== 'at_depot')) crewLeftBeforeFireOut = true;
    }
    expect(crewLeftBeforeFireOut).toBe(false);
    expect(power.isOn(cut.district)).toBe(true);
  });
});
