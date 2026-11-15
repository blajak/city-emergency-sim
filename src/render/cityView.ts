import * as THREE from 'three';
import type { City } from '../sim/world/types';
import { type BuildingsView, createBuildingsView } from './buildingsView';
import { type LampsView, createGroundView, createLampsView, createTreesView } from './decorView';
import { createRoadsView } from './roadsView';
import { createTransitView } from './transitView';

export interface CityView {
  group: THREE.Group;
  /** Night lighting and blackouts (per district). */
  setLighting(night: boolean, powered: readonly boolean[]): void;
}

/** Static scenery for a generated city. */
export function createCityView(city: City): CityView {
  const group = new THREE.Group();
  group.name = 'city';
  const buildings: BuildingsView = createBuildingsView(city.buildings, city.districts.length);
  const lamps: LampsView = createLampsView(city.lamps, city.districts);
  group.add(
    createGroundView(city.bounds),
    createRoadsView(city),
    buildings.group,
    createTreesView(city.trees),
    lamps.group,
    createTransitView(city),
  );
  return {
    group,
    setLighting(night, powered) {
      buildings.setLighting(night, powered);
      lamps.setLighting(night, powered);
    },
  };
}
