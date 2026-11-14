import type { Building, BuildingKind, City } from './types';

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

const LABELS: Record<BuildingKind, string> = {
  residential: 'Tenement house',
  apartment: 'Apartment block',
  house: 'House',
  office: 'Office building',
  shop: 'Shop',
  petrol_station: 'Petrol station',
  supermarket: 'Supermarket',
  mall: 'Shopping mall',
  town_hall: 'Town hall',
  school: 'School',
  hospital: 'Hospital',
  sports_hall: 'Sports hall',
  pool: 'Swimming pool',
  stadium: 'Stadium',
  factory: 'Factory',
  warehouse: 'Warehouse',
  container_yard: 'Container yard',
  waste_depot: 'Waste depot',
  power_plant: 'Power plant',
  fire_station: 'Fire station',
  police_station: 'Police station',
};

export function buildingLabel(building: Building): string {
  return LABELS[building.kind];
}
