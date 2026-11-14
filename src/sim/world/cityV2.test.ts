import { describe, expect, it } from 'vitest';
import { distanceToPolyline, obbCorners, obbOverlap, pointInObb } from '../math/geometry';
import { SpatialGrid, obbBox } from '../math/spatialGrid';
import { STREET_CLEARANCE } from './constants';
import { generateCity } from './cityGenerator';
import { RoadIndex } from './roadIndex';
import type { Building, BuildingKind } from './types';

const city = generateCity(1337, { scale: 10 });
const site = (b: Building) => b.plot ?? b.footprint;

describe('10× city layout', () => {
  it('is deterministic', () => {
    expect(generateCity(1337, { scale: 10 })).toEqual(city);
  });

  it('has nine districts of every kind, each with buildings', () => {
    expect(city.districts).toHaveLength(9);
    expect(new Set(city.districts.map((d) => d.kind))).toEqual(new Set(['old_town', 'commercial', 'residential', 'industrial']));
    for (const d of city.districts) expect(city.buildings.some((b) => b.district === d.id), d.name).toBe(true);
  });

  it('has every kind of building', () => {
    const kinds = new Set(city.buildings.map((b) => b.kind));
    const expected: BuildingKind[] = [
      'residential', 'apartment', 'house', 'office', 'shop', 'petrol_station', 'supermarket', 'mall', 'town_hall',
      'school', 'hospital', 'sports_hall', 'pool', 'stadium', 'factory', 'warehouse', 'container_yard', 'waste_depot',
      'power_plant', 'fire_station', 'police_station',
    ];
    for (const kind of expected) expect(kinds.has(kind), kind).toBe(true);
  });

  it('puts industry and the power plant in industrial districts', () => {
    for (const b of city.buildings.filter((x) => ['power_plant', 'container_yard', 'waste_depot'].includes(x.kind))) {
      expect(city.districts[b.district].kind, b.kind).toBe('industrial');
    }
    const townHall = city.buildings.find((b) => b.kind === 'town_hall')!;
    expect(city.districts[townHall.district].kind).toBe('old_town');
  });

  it('keeps every site off roads, sidewalks and the railway, and apart from each other', () => {
    const roads = new RoadIndex(city.roads);
    const grid = new SpatialGrid<Building>(32);
    for (const b of city.buildings) {
      for (const corner of obbCorners(site(b))) {
        expect(roads.isNear(corner, STREET_CLEARANCE), `${b.kind} ${b.id} on a road`).toBe(false);
        expect(distanceToPolyline(corner, city.railCorridor), `${b.kind} ${b.id} on the railway`).toBeGreaterThan(5);
      }
      // The main structure stays inside its plot.
      if (b.plot) for (const corner of obbCorners(b.footprint)) expect(pointInObb(corner, b.plot, 0.01)).toBe(true);
      const shrunk = { ...site(b), halfW: site(b).halfW - 0.06, halfD: site(b).halfD - 0.06 };
      for (const other of grid.query(obbBox(shrunk))) {
        expect(obbOverlap(shrunk, site(other)), `${b.kind} ${b.id} overlaps ${other.kind} ${other.id}`).toBe(false);
      }
      grid.insert(b, obbBox(site(b)));
    }
  });

  it('gives shops and industry delivery bays that do not overlap', () => {
    const withBay = city.buildings.filter((b) => b.bay);
    expect(withBay.length).toBeGreaterThan(150);
    expect(withBay.every((b) => ['shop', 'supermarket', 'mall', 'warehouse', 'factory', 'petrol_station'].includes(b.kind))).toBe(true);
    const bySide = new Map<string, { s: number; length: number }[]>();
    for (const b of withBay) {
      const bay = b.bay!;
      const edge = city.roads.edges[bay.edgeId];
      expect(bay.s - bay.length / 2).toBeGreaterThan(city.roads.nodes[edge.from].clearance);
      expect(bay.s + bay.length / 2).toBeLessThan(edge.length - city.roads.nodes[edge.to].clearance);
      const key = `${bay.edgeId}:${bay.side}`;
      for (const other of bySide.get(key) ?? []) {
        expect(Math.abs(other.s - bay.s)).toBeGreaterThan((other.length + bay.length) / 2);
      }
      bySide.set(key, [...(bySide.get(key) ?? []), bay]);
    }
  });

  it('runs a railway corridor across the whole city', () => {
    const xs = city.railCorridor.map((p) => p.x);
    expect(Math.min(...xs)).toBeLessThanOrEqual(city.bounds.minX + 10);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(city.bounds.maxX - 10);
  });
});
