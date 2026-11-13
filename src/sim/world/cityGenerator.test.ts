import { describe, expect, it } from 'vitest';
import { distanceToPolyline, obbCorners, obbOverlap } from '../math/geometry';
import { STREET_CLEARANCE } from './constants';
import { generateCity } from './cityGenerator';
import type { RoadNetwork } from './types';

const city = generateCity(1337);

function isConnected(network: RoadNetwork): boolean {
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const node = network.nodes[stack.pop()!];
    for (const edgeId of node.edges) {
      const edge = network.edges[edgeId];
      const next = edge.from === node.id ? edge.to : edge.from;
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen.size === network.nodes.length;
}

describe('generateCity', () => {
  it('is deterministic for a given seed', () => {
    expect(generateCity(1337)).toEqual(city);
  });

  it('has 20–30 connected streets', () => {
    expect(city.roads.edges.length).toBeGreaterThanOrEqual(20);
    expect(city.roads.edges.length).toBeLessThanOrEqual(30);
    expect(isConnected(city.roads)).toBe(true);
  });

  it('has no dead ends and lights only at real intersections', () => {
    for (const node of city.roads.nodes) {
      expect(node.edges.length).toBeGreaterThanOrEqual(2);
      expect(node.signalized).toBe(node.edges.length >= 3);
    }
  });

  it('has exactly one fire station and one police station', () => {
    expect(city.buildings.filter((b) => b.kind === 'fire_station')).toHaveLength(1);
    expect(city.buildings.filter((b) => b.kind === 'police_station')).toHaveLength(1);
  });

  it('places a reasonable number of buildings', () => {
    expect(city.buildings.length).toBeGreaterThan(80);
  });

  it('keeps buildings off roads and sidewalks', () => {
    for (const b of city.buildings) {
      for (const corner of obbCorners(b.footprint)) {
        for (const edge of city.roads.edges) {
          expect(distanceToPolyline(corner, edge.points)).toBeGreaterThanOrEqual(STREET_CLEARANCE);
        }
      }
    }
  });

  it('never overlaps two buildings', () => {
    const shrink = (b: (typeof city.buildings)[number]) => ({
      ...b.footprint,
      halfW: b.footprint.halfW - 0.06,
      halfD: b.footprint.halfD - 0.06,
    });
    for (let i = 0; i < city.buildings.length; i++) {
      for (let j = i + 1; j < city.buildings.length; j++) {
        expect(obbOverlap(shrink(city.buildings[i]), shrink(city.buildings[j]))).toBe(false);
      }
    }
  });
});
