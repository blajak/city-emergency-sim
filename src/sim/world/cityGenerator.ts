import { createRng } from '../math/rng';
import { placeBuildings } from './buildings';
import { placeLamps, placeTrees } from './decor';
import { planDistricts } from './districts';
import { generateRoadLayout } from './roadNetwork';
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
  const buildings = placeBuildings(rng, layout, districts, scale);
  return {
    seed,
    scale,
    bounds,
    roads: layout.network,
    districts,
    railCorridor: layout.railCorridor,
    buildings,
    parks: layout.parks,
    trees: placeTrees(rng, bounds, layout.network, buildings, layout.parks, layout.railCorridor),
    lamps: placeLamps(layout.network, buildings, layout.railCorridor),
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
