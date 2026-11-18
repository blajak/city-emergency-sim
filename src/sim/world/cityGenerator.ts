import { createRng } from '../math/rng';
import { placeBuildings, utilityCrews } from './buildings';
import { placeLamps, placeTrees } from './decor';
import { planDistricts } from './districts';
import { planRail } from './rail';
import { generateRoadLayout } from './roadNetwork';
import { planTransit } from './transit';
import { addYardRoad } from './yardRoad';
import type { Bounds, City, RoadNetwork } from './types';

const MAP_MARGIN = 45;

export interface CityOptions {
  /** Size factor: 1 is the original town, 10 is roughly ten times the streets and buildings. */
  scale?: number;
}

export function generateCity(seed: number, options: CityOptions = {}): City {
  const scale = options.scale ?? 1;
  const rng = createRng(seed);
  const layout = generateRoadLayout(rng, scale);
  const bounds = computeBounds(layout.network, MAP_MARGIN);
  const districts = planDistricts(rng, bounds, scale);
  const rail = planRail(layout, bounds);
  rail.yardRoad = addYardRoad(layout, rail);
  const buildings = placeBuildings(rng, layout, districts, scale, rail);
  const transit = planTransit(layout, districts, buildings, rail);
  const id = (kind: string) => buildings.find((b) => b.kind === kind)?.id ?? null;
  const power = {
    plant: id('power_plant'),
    substations: districts.map((d) => buildings.find((b) => b.kind === 'substation' && b.district === d.id)?.id ?? null),
    depot: id('utility_depot'),
    depotSpots: utilityCrews(scale),
  };
  return {
    seed,
    scale,
    bounds,
    roads: layout.network,
    districts,
    rail,
    buildings,
    transit,
    power,
    parks: layout.parks,
    trees: placeTrees(rng, bounds, layout.network, buildings, layout.parks, rail),
    lamps: placeLamps(layout.network, buildings, rail, transit.stops),
  };
}

function computeBounds(network: RoadNetwork, margin: number): Bounds {
  const xs = network.nodes.map((n) => n.pos.x);
  const zs = network.nodes.map((n) => n.pos.z);
  return {
    minX: Math.min(...xs) - margin,
    maxX: Math.max(...xs) + margin,
    minZ: Math.min(...zs) - margin,
    maxZ: Math.max(...zs) + margin,
  };
}
