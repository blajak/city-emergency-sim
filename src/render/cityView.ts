import * as THREE from 'three';
import type { City } from '../sim/world/types';
import { createBuildingsView } from './buildingsView';
import { createGroundView, createLampsView, createTreesView } from './decorView';
import { createRoadsView } from './roadsView';
import { createTransitView } from './transitView';

/** Static scenery for a generated city. */
export function createCityView(city: City): THREE.Group {
  const group = new THREE.Group();
  group.name = 'city';
  group.add(
    createGroundView(city.bounds),
    createRoadsView(city),
    createBuildingsView(city.buildings),
    createTreesView(city.trees),
    createLampsView(city.lamps),
    createTransitView(city),
  );
  return group;
}
