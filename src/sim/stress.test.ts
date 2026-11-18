import { describe, it } from 'vitest';
import { obbOverlap } from './math/geometry';
import { createRng } from './math/rng';
import { SpatialGrid, obbBox } from './math/spatialGrid';
import { Simulation } from './Simulation';
import { bodyBox } from './testing/overlap';
import { type Body, type Vehicle, vehicleBodies } from './traffic/vehicle';
import { generateCity } from './world/cityGenerator';

declare const process: { env: Record<string, string | undefined> };

/**
 * Long stress run, skipped in `npm test`. Run on demand, e.g.:
 *   STRESS=1 SEEDS=1337,7,42 SCALES=1,10 MINUTES=12 DARK=2 [MATCH=1] npx vitest run src/sim/stress.test.ts
 * Reports (does not fail on) vehicle overlaps — including buses in the depot yard
 * and utility vans on their driveway —, trains on occupied crossings, and
 * vehicles standing still too long (units/service > 60 s, cars > 120 s; DARK
 * marks lanes into unsignalised junctions). Incidents every 10–20 s, now and then
 * a fire at the power plant; DARK=n switches districts 0..n-1 off. MATCH=1 organises
 * a match at the stadium after a minute, and the next one a minute after each car park empties.
 */
const env = process.env;
const SEEDS = (env.SEEDS ?? '1337,7,42').split(',').map(Number);
const SCALES = (env.SCALES ?? '1,10').split(',').map(Number);
const MINUTES = Number(env.MINUTES ?? 10);
const DARK = Number(env.DARK ?? 0);
const MATCH = Boolean(Number(env.MATCH ?? 0));

interface Part extends Body {
  label: string;
  owner: unknown;
}

function firstOverlap(parts: Part[]): string | null {
  const grid = new SpatialGrid<Part>(12);
  for (const p of parts) {
    const box = bodyBox(p);
    for (const o of grid.query(obbBox(box))) if (o.owner !== p.owner && obbOverlap(box, bodyBox(o))) return `${p.label} / ${o.label}`;
    grid.insert(p, obbBox(box));
  }
  return null;
}

const describeVehicle = (v: Vehicle) =>
  `${v.role}${v.id}(${v.model},${v.maneuver},lat ${v.lateral.toFixed(2)},seg ${v.segment} s ${v.s.toFixed(1)},res ${v.reservation})`;

describe.skipIf(!env.STRESS)('stress', () => {
  for (const seed of SEEDS) {
    for (const scale of SCALES) {
      it(`seed ${seed} scale ${scale} dark ${DARK}`, () => {
        const city = generateCity(seed, { scale });
        const small = scale === 1;
        const sim = new Simulation(city, { civilianCount: small ? 25 : 300, fireUnits: small ? 1 : 3, policeUnits: small ? 1 : 3 });
        for (let d = 0; d < Math.min(DARK, city.districts.length); d++) sim.power.switchOff(d);
        const rng = createRng(seed + 5);
        const targets = city.buildings.filter((b) => b.kind !== 'fire_station' && b.kind !== 'police_station');
        const plant = city.power.plant;
        let nextIncident = 10;
        let nextMatch = 60;
        let lastEmpty = '';
        const still = new Map<Vehicle, number>();
        const problems: string[] = [];
        const seen = new Set<string>();

        for (let step = 0; step < MINUTES * 60 * 20; step++) {
          if (sim.time >= nextIncident) {
            const target = plant !== null && rng.chance(0.08) ? city.buildings[plant] : rng.pick(targets);
            sim.reportIncident(rng.chance(0.5) || target.id === plant ? 'fire' : 'crime', target.id);
            nextIncident += rng.range(10, 20);
          }
          if (MATCH && sim.time >= nextMatch && sim.match.canOrganise()) sim.match.organise();
          sim.step();
          for (const e of sim.match.drainEvents()) {
            if (e.kind !== 'car_park_empty') continue;
            nextMatch = sim.time + 60;
            lastEmpty += ` ${(sim.time - sim.match.whistle).toFixed(0)}s`;
          }

          const parts: Part[] = [];
          for (const v of sim.traffic.vehicles) for (const b of vehicleBodies(v)) parts.push({ ...b, label: describeVehicle(v), owner: v });
          sim.buses.yard.forEach((y, i) => parts.push({ label: `yard bus ${i}`, owner: y, pose: y.pose, length: 11, width: 2.55 }));
          for (const c of sim.power.crews) {
            if (!c.vehicle) parts.push({ label: `driveway ${c.name} ${c.status}`, owner: c, pose: c.pose, length: 5.4, width: 2.05 });
          }
          const hit = firstOverlap(parts);
          const key = hit?.replace(/[\d.]+/g, '');
          if (hit && !seen.has(key!)) {
            seen.add(key!);
            problems.push(`t=${sim.time.toFixed(1)} overlap ${hit}`);
          }

          for (const c of sim.rail.crossings) {
            if (!c.occupied) continue;
            for (const t of sim.rail.trains) {
              for (const ct of c.tracks) {
                if (ct.trackId === t.track.id && ct.s > t.s - t.length - 1 && ct.s < t.s + 1) {
                  problems.push(`t=${sim.time.toFixed(1)} train ${t.id} on occupied crossing ${c.id}`);
                }
              }
            }
          }

          for (const v of sim.traffic.vehicles) {
            if (v.v > 0.1 || v.maneuver !== 'driving' || v.halted) {
              still.delete(v);
              continue;
            }
            const since = still.get(v) ?? sim.time;
            still.set(v, since);
            const limit = v.role === 'civilian' ? 120 : 60;
            if (sim.time - since >= limit && sim.time - since < limit + 0.05) {
              const seg = sim.traffic.graph.segments[v.segment];
              const dark = seg.kind === 'lane' && sim.signals.isDark(seg.toNode) ? ' DARK' : '';
              problems.push(`t=${sim.time.toFixed(1)} still ${limit}s ${describeVehicle(v)}${dark}`);
            }
          }
        }
        const off = sim.power.districts.filter((d) => !d.on).length;
        console.log(
          `seed ${seed} scale ${scale} dark ${DARK}: incidents ${sim.dispatcher.incidents.length} ` +
            `resolved ${sim.dispatcher.incidents.filter((i) => i.status === 'resolved').length}, ` +
            `lorries ${sim.logistics.count('truck')}, buses ${sim.buses.buses.length}, districts off ${off}, ` +
            (MATCH ? `matches ${sim.match.stats.matches} (car park empty after whistle:${lastEmpty || ' -'}), ` : '') +
            `problems ${problems.length}`,
        );
        for (const p of problems.slice(0, 25)) console.log(`  ${p}`);
      });
    }
  }
});
