import * as THREE from 'three';
import { samplePolyline } from '../sim/math/geometry';
import { add, rightOf, scale } from '../sim/math/vec2';
import { STREET_CLEARANCE } from '../sim/world/constants';
import type { BusStop, City } from '../sim/world/types';
import { Frame, GeometryBuilder, addBox } from './geometryBuilder';

const SIDEWALK_Y = 0.12;
const FRAME = new THREE.Color(0x4a5560);
const GLASS = new THREE.Color(0xa9c7d6);
const ROOF = new THREE.Color(0x3b434b);
const BENCH = new THREE.Color(0x8a6a4a);
const SIGN = new THREE.Color(0xf2c230);
const SIGN_MARK = new THREE.Color(0x2e7d32);

/** Shelter footprint: along the street × across it. */
const SHELTER_HALF_LENGTH = 1.8;
const SHELTER_HALF_DEPTH = 0.65;
/** Distance of the shelter centre from the street centre line. */
const SHELTER_OFFSET = STREET_CLEARANCE - 1.15;
const SIGN_OFFSET = STREET_CLEARANCE - 2.1;

/** Where a stop's shelter stands (centre, along the edge) and which way the buses go. */
export function shelterPlacement(
  city: City,
  stop: BusStop,
): { frame: Frame; signFrame: Frame; center: { x: number; z: number }; rotation: number; halfLength: number } {
  const edge = city.roads.edges[stop.edgeId];
  // Lay-bys take most of the sidewalk: the shelter stands just past the bay's far end.
  const along = stop.bay ? stop.side * (stop.length / 2 + SHELTER_HALF_LENGTH + 0.8) : 0;
  const at = (s: number, lateral: number) => {
    const sample = samplePolyline(edge.points, s);
    const outward = scale(rightOf(sample.dir), stop.side);
    const point = add(sample.point, scale(outward, lateral));
    // Local +z faces the road.
    return { point, rotation: Math.atan2(-outward.x, -outward.z) };
  };
  const signS = stop.s + stop.side * (stop.length / 2 - 0.5);
  const shelter = at(stop.s + along, SHELTER_OFFSET);
  const sign = at(signS, SIGN_OFFSET);
  return {
    frame: new Frame(shelter.point.x, shelter.point.z, shelter.rotation),
    signFrame: new Frame(sign.point.x, sign.point.z, sign.rotation),
    center: shelter.point,
    rotation: shelter.rotation,
    halfLength: SHELTER_HALF_LENGTH,
  };
}

/** Bus shelters and stop signs, merged into one mesh. */
export function createTransitView(city: City): THREE.Mesh {
  const b = new GeometryBuilder();
  const y = SIDEWALK_Y;
  for (const stop of city.transit.stops) {
    const { frame, signFrame } = shelterPlacement(city, stop);
    const box = (ox: number, oz: number, halfW: number, halfD: number, y0: number, y1: number, color: THREE.Color) =>
      addBox(b, { frame, ox, oz, halfW, halfD, y0: y + y0, y1: y + y1, color });
    const L = SHELTER_HALF_LENGTH;
    const D = SHELTER_HALF_DEPTH;
    // Posts, back and side glass, roof, bench.
    for (const x of [-L + 0.05, L - 0.05]) for (const z of [-D + 0.05, D - 0.05]) box(x, z, 0.05, 0.05, 0, 2.4, FRAME);
    box(0, -D + 0.05, L - 0.1, 0.03, 0.3, 2.3, GLASS);
    for (const x of [-L + 0.05, L - 0.05]) box(x, -0.1, 0.03, D - 0.2, 0.3, 2.3, GLASS);
    box(0, 0, L + 0.15, D + 0.15, 2.4, 2.55, ROOF);
    box(0, -D + 0.35, L - 0.4, 0.18, 0.45, 0.52, BENCH);

    // Stop sign: pole with a yellow plate and a green mark.
    addBox(b, { frame: signFrame, halfW: 0.04, halfD: 0.04, y0: y, y1: y + 2.6, color: FRAME });
    addBox(b, { frame: signFrame, oz: 0.05, halfW: 0.3, halfD: 0.02, y0: y + 2.1, y1: y + 2.7, color: SIGN });
    for (const oz of [0.08, -0.03]) addBox(b, { frame: signFrame, oz, halfW: 0.16, halfD: 0.01, y0: y + 2.28, y1: y + 2.52, color: SIGN_MARK });
  }
  const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
  mesh.castShadow = true;
  mesh.name = 'transit';
  return mesh;
}
