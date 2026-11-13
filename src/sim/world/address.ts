import type { Building, City } from './types';

/** Metres of frontage per house number step. */
const NUMBER_SPACING = 10;

/**
 * Human-readable address, e.g. "14 Linden St". Numbers grow from west to
 * east (or north to south) along the whole street; odd on one side, even
 * on the other.
 */
export function formatAddress(city: City, building: Building): string {
  const edge = city.roads.edges[building.address.edgeId];
  const a = city.roads.nodes[edge.from].pos;
  const b = city.roads.nodes[edge.to].pos;
  const { center } = building.footprint;
  const along = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z) ? center.x - city.bounds.minX : center.z - city.bounds.minZ;
  const n = 2 * Math.max(0, Math.round(along / NUMBER_SPACING)) + (building.address.side === 1 ? 1 : 2);
  return `${n} ${edge.name}`;
}

export function buildingLabel(building: Building): string {
  switch (building.kind) {
    case 'fire_station':
      return 'Fire Station';
    case 'police_station':
      return 'Police Station';
    case 'office':
      return 'Office building';
    case 'residential':
      return 'Apartment house';
  }
}
