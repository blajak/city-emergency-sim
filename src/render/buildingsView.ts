import * as THREE from 'three';
import { createRng, type Rng } from '../sim/math/rng';
import { BAY_WIDTH, FLOOR_HEIGHT } from '../sim/world/constants';
import type { Building } from '../sim/world/types';
import { Frame, GeometryBuilder, addBox, addGableRoof } from './geometryBuilder';
import { createShopTexture, createSignTexture, createWindowTexture } from './textures';

const ROOF_GREY = 0x8a8f96;
const ROOF_TILES = [0xa4553f, 0x8e4a3a, 0x6d6f73, 0xb2654a];

interface Builders {
  facade: GeometryBuilder;
  shop: GeometryBuilder;
  solid: GeometryBuilder;
}

const color = (hex: number) => new THREE.Color(hex);
const shade = (hex: number, factor: number) => new THREE.Color(hex).multiplyScalar(factor);

export function createBuildingsView(buildings: readonly Building[]): THREE.Group {
  const builders: Builders = {
    facade: new GeometryBuilder(),
    shop: new GeometryBuilder(),
    solid: new GeometryBuilder(),
  };
  const group = new THREE.Group();
  group.name = 'buildings';

  for (const building of buildings) {
    const rng = createRng(building.id * 7919 + 17);
    switch (building.kind) {
      case 'residential':
        addResidential(builders, building, rng);
        break;
      case 'office':
        addOffice(builders, building, rng);
        break;
      case 'fire_station':
        addFireStation(builders, building, group);
        break;
      case 'police_station':
        addPoliceStation(builders, building, group);
        break;
    }
  }

  const facadeMaterial = new THREE.MeshStandardMaterial({
    map: createWindowTexture(),
    vertexColors: true,
    roughness: 0.85,
  });
  const shopMaterial = new THREE.MeshStandardMaterial({
    map: createShopTexture(),
    vertexColors: true,
    roughness: 0.8,
  });
  const solidMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });

  for (const [builder, material] of [
    [builders.facade, facadeMaterial],
    [builders.shop, shopMaterial],
    [builders.solid, solidMaterial],
  ] as const) {
    const mesh = new THREE.Mesh(builder.build(), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Height of a pitched roof above the wall top. */
export function gableRise(b: Building): number {
  return Math.min(b.footprint.halfD * 0.8, 4.5);
}

/** Highest point of the building, roof included. */
export function roofTop(b: Building): number {
  return b.height + (b.roof === 'gable' ? gableRise(b) : 0.5);
}

function frameOf(b: Building): Frame {
  return new Frame(b.footprint.center.x, b.footprint.center.z, b.footprint.rotation);
}

function addResidential(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const facade = color(b.facadeColor);

  addBox(builders.shop, {
    frame,
    halfW: halfW + 0.1,
    halfD: halfD + 0.1,
    y0: 0,
    y1: b.groundFloorHeight,
    color: shade(b.facadeColor, 0.8),
    facade: { bayWidth: BAY_WIDTH * 1.4, rowHeight: b.groundFloorHeight },
  });
  addBox(builders.facade, {
    frame,
    halfW,
    halfD,
    y0: b.groundFloorHeight,
    y1: b.height,
    color: facade,
    facade: { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT },
  });

  if (b.roof === 'gable') {
    const rise = gableRise(b);
    addGableRoof(builders.solid, frame, halfW, halfD, b.height, rise, color(rng.pick(ROOF_TILES)), facade);
  } else {
    addCornice(builders.solid, frame, b, shade(b.facadeColor, 1.08));
    addRoofClutter(builders.solid, frame, b, rng);
  }
}

function addOffice(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  addBox(builders.shop, {
    frame,
    halfW: halfW + 0.1,
    halfD: halfD + 0.1,
    y0: 0,
    y1: b.groundFloorHeight,
    color: color(0x9aa4ad),
    facade: { bayWidth: BAY_WIDTH * 1.6, rowHeight: b.groundFloorHeight },
  });
  addBox(builders.facade, {
    frame,
    halfW,
    halfD,
    y0: b.groundFloorHeight,
    y1: b.height,
    color: color(b.facadeColor),
    facade: { bayWidth: BAY_WIDTH * 0.8, rowHeight: FLOOR_HEIGHT },
  });
  addCornice(builders.solid, frame, b, shade(b.facadeColor, 0.85));
  // Mechanical penthouse.
  addBox(builders.solid, {
    frame,
    ox: rng.range(-halfW * 0.3, halfW * 0.3),
    oz: rng.range(-halfD * 0.2, halfD * 0.2),
    halfW: halfW * 0.35,
    halfD: halfD * 0.35,
    y0: b.height,
    y1: b.height + 2.6,
    color: color(0xb4b8bc),
  });
  addRoofClutter(builders.solid, frame, b, rng);
}

function addCornice(solid: GeometryBuilder, frame: Frame, b: Building, trim: THREE.Color): void {
  addBox(solid, {
    frame,
    halfW: b.footprint.halfW + 0.25,
    halfD: b.footprint.halfD + 0.25,
    y0: b.height - 0.1,
    y1: b.height + 0.45,
    color: trim,
    topColor: color(ROOF_GREY),
  });
}

/** AC units and roof-access huts on flat roofs. */
function addRoofClutter(solid: GeometryBuilder, frame: Frame, b: Building, rng: Rng): void {
  const { halfW, halfD } = b.footprint;
  const y0 = b.height + 0.45;
  const units = rng.int(0, 2);
  for (let i = 0; i < units; i++) {
    addBox(solid, {
      frame,
      ox: rng.range(-halfW + 1.5, halfW - 1.5),
      oz: rng.range(-halfD + 1.5, halfD - 1.5),
      halfW: 0.8,
      halfD: 0.55,
      y0,
      y1: y0 + 1,
      color: color(0xd5d8db),
    });
  }
  if (rng.chance(0.5)) {
    addBox(solid, {
      frame,
      ox: rng.range(-halfW + 2, halfW - 2),
      oz: -halfD + 2,
      halfW: 1.3,
      halfD: 1.3,
      y0,
      y1: y0 + 2.3,
      color: color(0xa9a39a),
    });
  }
}

function addSign(
  group: THREE.Group,
  frame: Frame,
  text: string,
  background: string,
  foreground: string,
  width: number,
  y: number,
  z: number,
  rotation: number,
): void {
  const height = width * (96 / 512);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: createSignTexture(text, background, foreground) }),
  );
  const [x, , wz] = frame.toWorld(0, 0, z);
  mesh.position.set(x, y, wz);
  mesh.rotation.y = rotation;
  group.add(mesh);
}

function addFireStation(builders: Builders, b: Building, group: THREE.Group): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const red = color(b.facadeColor);
  const gf = b.groundFloorHeight;

  addBox(builders.solid, { frame, halfW, halfD, y0: 0, y1: gf, color: red });
  addBox(builders.facade, {
    frame,
    halfW,
    halfD,
    y0: gf,
    y1: b.height,
    color: red,
    facade: { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT },
  });
  addCornice(builders.solid, frame, b, color(0xf1e9e0));

  // Three bays of garage doors on the street side.
  const doorWidth = 5;
  for (const ox of [-6.5, 0, 6.5]) {
    addBox(builders.solid, {
      frame,
      ox,
      oz: halfD,
      halfW: doorWidth / 2,
      halfD: 0.08,
      y0: 0,
      y1: 4.0,
      color: color(0xdfe3e6),
    });
    for (let y = 0.8; y < 4.0; y += 0.8) {
      addBox(builders.solid, {
        frame,
        ox,
        oz: halfD + 0.1,
        halfW: doorWidth / 2 - 0.1,
        halfD: 0.03,
        y0: y,
        y1: y + 0.08,
        color: color(0xb5bcc2),
      });
    }
  }

  // Hose-drying tower at the back corner.
  addBox(builders.solid, {
    frame,
    ox: -halfW + 2.5,
    oz: -halfD + 2.5,
    halfW: 2.5,
    halfD: 2.5,
    y0: b.height,
    y1: b.height + 9,
    color: red,
  });
  addBox(builders.solid, {
    frame,
    ox: -halfW + 2.5,
    oz: -halfD + 2.5,
    halfW: 2.9,
    halfD: 2.9,
    y0: b.height + 9,
    y1: b.height + 9.6,
    color: color(0xf1e9e0),
    topColor: color(ROOF_GREY),
  });

  addSign(group, frame, 'FIRE STATION', '#f4efe6', '#b02a1f', 8, 4.95, halfD + 0.06, b.footprint.rotation);
}

function addPoliceStation(builders: Builders, b: Building, group: THREE.Group): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const blue = color(0x2c5aa0);
  const gf = b.groundFloorHeight;

  addBox(builders.shop, {
    frame,
    halfW: halfW + 0.1,
    halfD: halfD + 0.1,
    y0: 0,
    y1: gf,
    color: color(0xdfe6ee),
    facade: { bayWidth: BAY_WIDTH * 1.6, rowHeight: gf },
  });
  // Blue band above the ground floor.
  addBox(builders.solid, {
    frame,
    halfW: halfW + 0.2,
    halfD: halfD + 0.2,
    y0: gf,
    y1: gf + 1.2,
    color: blue,
  });
  addBox(builders.facade, {
    frame,
    halfW,
    halfD,
    y0: gf + 1.2,
    y1: b.height + 1.2,
    color: color(b.facadeColor),
    facade: { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT },
  });
  addBox(builders.solid, {
    frame,
    halfW: halfW + 0.25,
    halfD: halfD + 0.25,
    y0: b.height + 1.1,
    y1: b.height + 1.6,
    color: blue,
    topColor: color(ROOF_GREY),
  });
  // Entrance canopy.
  addBox(builders.solid, {
    frame,
    oz: halfD + 1.2,
    halfW: 3,
    halfD: 1.2,
    y0: 3.2,
    y1: 3.5,
    color: blue,
  });
  // Radio mast.
  addBox(builders.solid, {
    frame,
    ox: halfW - 2,
    oz: -halfD + 2,
    halfW: 0.15,
    halfD: 0.15,
    y0: b.height + 1.6,
    y1: b.height + 9,
    color: color(0xc8ccd0),
  });

  addSign(group, frame, 'POLICE', '#2c5aa0', '#ffffff', 7, gf + 0.6, halfD + 0.25, b.footprint.rotation);
}
