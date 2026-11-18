import * as THREE from 'three';
import type { Rng } from '../sim/math/rng';
import { BAY_WIDTH, FLOOR_HEIGHT } from '../sim/world/constants';
import { depotYard } from '../sim/world/depotYard';
import type { Building } from '../sim/world/types';
import { type Builders, ROOF_GREY, ROOF_TILES, addCornice, addRoofClutter, color, frameOf, shade } from './buildingParts';
import { type FacadeUv, Frame, type GeometryBuilder, type V3, addBox, addFacing, addFlatRect, addGableRoof, addLathe } from './geometryBuilder';
import type { SignStyle } from './textures';

/**
 * Models for the v2 building kinds: homes, shops, landmarks that fill a
 * block (with their car parks, pitches and yards) and industry.
 * Everything goes into the shared builders, so it costs no extra draw calls.
 */

const SHOP_NAMES = ['BAKERY', 'CAFÉ', 'PHARMACY', 'BOOKS', 'FLOWERS', 'DELI', 'SHOES', 'FASHION', 'BISTRO', 'HARDWARE', 'OPTICIAN', 'PIZZA'];
const SHOP_SIGN_COLORS = ['#2f6f5e', '#8c2f39', '#2b4c7e', '#6b4f9c', '#c06c2b', '#3d3d3d'];
const AWNING_COLORS = [0xc0392b, 0x2e7d5b, 0x2b5ca8, 0xe0a526, 0x7b4fa0, 0x3f4a55];

export const SIGN_STYLES: SignStyle[] = [
  ...SHOP_NAMES.map((text, i) => ({ text, background: SHOP_SIGN_COLORS[i % SHOP_SIGN_COLORS.length], foreground: '#ffffff' })),
  { text: 'SUPERMARKET', background: '#e8f3e4', foreground: '#2e7d32' },
  { text: 'MALL', background: '#1f2933', foreground: '#ffd166' },
  { text: 'TOWN HALL', background: '#efe6d2', foreground: '#5b4a2e' },
  { text: 'HOSPITAL', background: '#ffffff', foreground: '#d32f2f' },
  { text: 'SCHOOL', background: '#fff4dc', foreground: '#8a5a00' },
  { text: 'SPORTS HALL', background: '#e3f2fd', foreground: '#1565c0' },
  { text: 'SWIMMING POOL', background: '#e0f7fa', foreground: '#00838f' },
  { text: 'PETROL', background: '#c62828', foreground: '#ffffff' },
  { text: 'POWER PLANT', background: '#263238', foreground: '#ffca28' },
  { text: 'RECYCLING', background: '#2e7d32', foreground: '#ffffff' },
  { text: 'LOGISTICS', background: '#37474f', foreground: '#ffffff' },
  { text: 'WEST STATION', background: '#1f3a5f', foreground: '#ffffff' },
  { text: 'CENTRAL STATION', background: '#1f3a5f', foreground: '#ffffff' },
  { text: 'FREIGHT HUB', background: '#37474f', foreground: '#ffca28' },
  { text: 'FREIGHT TERMINAL', background: '#37474f', foreground: '#ffca28' },
  { text: 'BUS DEPOT', background: '#1e6fd0', foreground: '#ffffff' },
  { text: 'POWER CO.', background: '#f2b705', foreground: '#1f2933' },
];

const GLASS = color(0x5d7a8c);
const GLASS_LIGHT = color(0x9cc3d6);
const CONCRETE = color(0xb9b6ae);
const ASPHALT = color(0x55595e);
const PAVING = color(0xd9d2c3);
const LINE = color(0xf2f2ee);
const DARK = color(0x2b3036);
const STEEL = color(0x8d969e);
const GRASS = color(0x6fa553);

export function addOtherBuilding(builders: Builders, b: Building, rng: Rng): void {
  switch (b.kind) {
    case 'apartment':
      return addApartment(builders, b, rng);
    case 'house':
      return addHouse(builders, b, rng);
    case 'shop':
      return addShop(builders, b, rng);
    case 'petrol_station':
      return addPetrolStation(builders, b);
    case 'warehouse':
      return addWarehouse(builders, b, rng);
    case 'factory':
      return addFactory(builders, b, rng);
    case 'supermarket':
      return addSupermarket(builders, b, rng);
    case 'mall':
      return addMall(builders, b, rng);
    case 'town_hall':
      return addTownHall(builders, b);
    case 'hospital':
      return addHospital(builders, b);
    case 'school':
      return addSchool(builders, b);
    case 'sports_hall':
      return addSportsHall(builders, b);
    case 'pool':
      return addPool(builders, b);
    case 'stadium':
      return addStadium(builders, b);
    case 'waste_depot':
      return addWasteDepot(builders, b, rng);
    case 'power_plant':
      return addPowerPlant(builders, b);
    case 'bus_depot':
      return addBusDepot(builders, b);
    case 'substation':
      return addSubstation(builders, b);
    case 'utility_depot':
      return addUtilityDepot(builders, b);
    case 'train_station':
      return addTrainStation(builders, b);
    case 'freight_hub':
    case 'freight_terminal':
      return addFreightYard(builders, b);
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function box(
  b: GeometryBuilder,
  frame: Frame,
  ox: number,
  oz: number,
  halfW: number,
  halfD: number,
  y0: number,
  y1: number,
  c: THREE.Color,
  topColor?: THREE.Color,
  facade?: FacadeUv,
): void {
  addBox(b, { frame, ox, oz, halfW, halfD, y0, y1, color: c, topColor, facade });
}

/** Sign from the atlas on a plane facing local +z at depth `oz`. */
function sign(builders: Builders, frame: Frame, text: string, width: number, y: number, oz: number, ox = 0): void {
  const rect = builders.atlas.uv.get(text);
  if (!rect) return;
  const [u0, v0, u1, v1] = rect;
  const h = width / builders.atlas.aspect;
  const p = (x: number, yy: number) => frame.toWorld(ox + x, yy, oz);
  builders.signs.addPolygon(
    [p(-width / 2, y - h / 2), p(width / 2, y - h / 2), p(width / 2, y + h / 2), p(-width / 2, y + h / 2)],
    color(0xffffff),
    [
      [u0, v0],
      [u1, v0],
      [u1, v1],
      [u0, v1],
    ],
  );
}

function plotFrame(b: Building): Frame {
  const plot = b.plot ?? b.footprint;
  return new Frame(plot.center.x, plot.center.z, plot.rotation);
}

/** Local z of the footprint centre inside the plot frame (footprints sit at the back). */
function footprintOffset(b: Building): number {
  return b.plot ? -(b.plot.halfD - b.footprint.halfD) : 0;
}

/** Simple parked car (two boxes) for car parks. */
function parkedCar(solid: GeometryBuilder, frame: Frame, ox: number, oz: number, paint: number, rotated: boolean): void {
  const hw = rotated ? 2.2 : 0.9;
  const hd = rotated ? 0.9 : 2.2;
  box(solid, frame, ox, oz, hw, hd, 0.15, 0.95, color(paint));
  box(solid, frame, ox, oz, hw * (rotated ? 0.55 : 0.85), hd * (rotated ? 0.85 : 0.55), 0.95, 1.4, color(0x26323c), color(paint));
}

const CAR_PAINTS = [0xd94b3d, 0x2f6fb3, 0xf2f2f2, 0x2b2b2b, 0x9aa3ab, 0xe0b23a, 0x3f8f5a, 0x5bb5d6];

/** Car park: asphalt, bay lines and some parked cars, in the plot frame. */
function carPark(solid: GeometryBuilder, frame: Frame, ox: number, oz: number, halfW: number, halfD: number, rng: Rng): void {
  addFlatRect(solid, frame, ox, oz, halfW, halfD, 0.07, ASPHALT);
  const rows = Math.max(1, Math.floor((halfD * 2) / 12));
  for (let r = 0; r < rows; r++) {
    const rz = oz - halfD + 6 + r * 12;
    for (let x = ox - halfW + 1.5; x < ox + halfW - 1.5; x += 2.8) {
      addFlatRect(solid, frame, x, rz, 0.06, 2.4, 0.09, LINE);
      if (rng.chance(0.55) && x + 2.8 < ox + halfW - 1.5) parkedCar(solid, frame, x + 1.4, rz, rng.pick(CAR_PAINTS), false);
    }
  }
}

// ---------------------------------------------------------------------------
// Homes and shops
// ---------------------------------------------------------------------------

function addApartment(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  box(builders.facade, frame, 0, 0, halfW, halfD, 0, b.height, wall, undefined, { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT });
  // Balconies on the street side.
  const balcony = shade(b.facadeColor, 1.12);
  const rail = shade(b.facadeColor, 0.7);
  for (let floor = 1; floor <= b.upperFloors; floor++) {
    const y = b.groundFloorHeight + (floor - 1) * FLOOR_HEIGHT;
    for (let x = -halfW + 3; x < halfW - 2; x += BAY_WIDTH * 2) {
      box(builders.solid, frame, x + BAY_WIDTH / 2, halfD + 0.6, 1.3, 0.6, y, y + 0.15, balcony);
      box(builders.solid, frame, x + BAY_WIDTH / 2, halfD + 1.15, 1.3, 0.05, y + 0.15, y + 1.05, rail);
    }
  }
  addCornice(builders.solid, frame, b, shade(b.facadeColor, 0.9));
  addRoofClutter(builders.solid, frame, b, rng);
}

function addHouse(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  box(builders.facade, frame, 0, 0, halfW, halfD, 0, b.height, wall, undefined, { bayWidth: BAY_WIDTH * 1.2, rowHeight: b.groundFloorHeight });
  // Front door.
  box(builders.solid, frame, rng.range(-halfW * 0.4, halfW * 0.4), halfD + 0.03, 0.55, 0.05, 0, 2.2, color(rng.pick([0x6d4c41, 0x2e5e4e, 0x8c2f39, 0x3b4a6b])));
  if (b.roof === 'gable') {
    addGableRoof(builders.solid, frame, halfW, halfD, b.height, Math.min(halfD * 0.8, 3.6), color(rng.pick(ROOF_TILES)), wall);
    box(builders.solid, frame, halfW * 0.5, -halfD * 0.3, 0.4, 0.4, b.height, b.height + 3.4, color(0x8a5a44));
  } else {
    addCornice(builders.solid, frame, b, shade(b.facadeColor, 0.9));
  }
}

function addShop(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const gf = b.groundFloorHeight;
  box(builders.shop, frame, 0, 0, halfW, halfD, 0, gf, color(b.facadeColor), color(ROOF_GREY), { bayWidth: BAY_WIDTH * 1.5, rowHeight: gf });
  if (b.upperFloors > 0) {
    box(builders.facade, frame, 0, 0, halfW, halfD, gf, b.height, shade(b.facadeColor, 0.95), undefined, { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT });
  }
  addCornice(builders.solid, frame, b, shade(b.facadeColor, 0.85));
  // Sloped awning over the shop window.
  const awning = color(rng.pick(AWNING_COLORS));
  const w = halfW - 0.4;
  addFacing(builders.solid, frame, [[-w, 3.55, halfD + 0.05], [w, 3.55, halfD + 0.05], [w, 3.0, halfD + 1.6], [-w, 3.0, halfD + 1.6]], [0, 1, 1], awning);
  addFacing(builders.solid, frame, [[-w, 3.0, halfD + 1.6], [w, 3.0, halfD + 1.6], [w, 2.75, halfD + 1.6], [-w, 2.75, halfD + 1.6]], [0, 0, 1], shade(awning.getHex(), 0.8));
  sign(builders, frame, SHOP_NAMES[Math.floor(b.variant * SHOP_NAMES.length)], Math.min(8, halfW * 1.4), gf - 0.5, halfD + 0.06);
}

function addPetrolStation(builders: Builders, b: Building): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, halfW, halfD, 0.07, color(0x9a9a96));
  // Small shop at the back.
  box(builders.shop, frame, 0, -halfD + 3.5, halfW * 0.5, 3.5, 0, 3.8, color(0xf2f2f0), color(ROOF_GREY), { bayWidth: BAY_WIDTH * 1.5, rowHeight: 3.8 });
  // Canopy on pillars over the pumps.
  const cz = 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(builders.solid, frame, sx * (halfW - 4), cz + sz * 3.5, 0.25, 0.25, 0, 5, color(0xe8e8e8));
  box(builders.solid, frame, 0, cz, halfW - 2, 5.5, 5, 5.8, color(0xf4f4f4), color(0xe0e0e0));
  box(builders.solid, frame, 0, cz, halfW - 1.9, 5.6, 5.3, 5.6, color(0xc62828));
  for (const x of [-halfW * 0.35, halfW * 0.35]) {
    box(builders.solid, frame, x, cz, 0.6, 1.4, 0, 0.3, CONCRETE);
    box(builders.solid, frame, x, cz, 0.35, 0.5, 0.3, 1.9, color(0xd84315));
  }
  // Price pylon by the road.
  box(builders.solid, frame, halfW - 1.5, halfD - 1, 0.6, 0.2, 0, 6, color(0xc62828));
  sign(builders, frame, 'PETROL', 5, 5.45, cz + 5.62);
}

// ---------------------------------------------------------------------------
// Industry
// ---------------------------------------------------------------------------

function addWarehouse(builders: Builders, b: Building, rng: Rng): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  box(builders.solid, frame, 0, 0, halfW, halfD, 0, b.height, wall, color(0x9ea4a8));
  // Darker plinth and a band of high windows.
  box(builders.solid, frame, 0, 0, halfW + 0.03, halfD + 0.03, 0, 1.2, shade(b.facadeColor, 0.75));
  box(builders.solid, frame, 0, 0, halfW + 0.04, halfD + 0.04, b.height - 1.6, b.height - 0.8, GLASS);
  // Loading doors with a dock canopy.
  const doors = Math.max(2, Math.floor((halfW * 2) / 8));
  for (let i = 0; i < doors; i++) {
    const x = -halfW + ((i + 0.5) * halfW * 2) / doors;
    box(builders.solid, frame, x, halfD + 0.05, 1.6, 0.06, 1.1, 4.6, color(0x5f6b74));
  }
  box(builders.solid, frame, 0, halfD + 1.2, halfW - 1, 1.2, 4.9, 5.2, color(0x8d969e));
  box(builders.solid, frame, 0, halfD + 0.6, halfW - 1, 0.6, 0, 1.1, CONCRETE);
  if (rng.chance(0.4)) sign(builders, frame, 'LOGISTICS', 7, b.height - 2.8, halfD + 0.08, -halfW * 0.4);
}

function addFactory(builders: Builders, b: Building, rng: Rng): void {
  const frame = plotFrame(b);
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  if (b.plot) {
    // Concrete yard with pallets and a few containers.
    addFlatRect(builders.solid, frame, 0, 0, b.plot.halfW, b.plot.halfD, 0.06, color(0xa9a59c));
    for (let i = 0; i < 6; i++) {
      const x = rng.range(-b.plot.halfW + 4, b.plot.halfW - 4);
      const z = rng.range(oz + halfD + 3, b.plot.halfD - 3);
      if (rng.chance(0.5)) box(builders.solid, frame, x, z, 3, 1.25, 0, 2.6, color(rng.pick([0xc0392b, 0x2b5ca8, 0x2e7d5b, 0xe67e22])));
      else box(builders.solid, frame, x, z, 0.6, 0.6, 0, 0.9, color(0xa1887f));
    }
  }
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, wall, color(0x9ea4a8));
  box(builders.solid, frame, 0, oz, halfW + 0.03, halfD + 0.03, b.height - 2.2, b.height - 1.2, GLASS);
  // Sawtooth roof: rows of north-light prisms.
  const teeth = Math.max(2, Math.floor((halfD * 2) / 6));
  const tooth = (halfD * 2) / teeth;
  for (let i = 0; i < teeth; i++) {
    const z0 = oz - halfD + i * tooth;
    const z1 = z0 + tooth;
    const y0 = b.height;
    const y1 = b.height + 2.6;
    addFacing(builders.solid, frame, [[-halfW, y0, z1], [halfW, y0, z1], [halfW, y1, z0], [-halfW, y1, z0]], [0, 1, 1], color(0x9aa1a6));
    addFacing(builders.solid, frame, [[-halfW, y0, z0], [halfW, y0, z0], [halfW, y1, z0], [-halfW, y1, z0]], [0, 0, -1], GLASS_LIGHT);
    addFacing(builders.solid, frame, [[-halfW, y0, z0], [-halfW, y0, z1], [-halfW, y1, z0]], [-1, 0, 0], wall);
    addFacing(builders.solid, frame, [[halfW, y0, z0], [halfW, y0, z1], [halfW, y1, z0]], [1, 0, 0], wall);
  }
  // Big doors and a brick chimney with a red-and-white top.
  box(builders.solid, frame, -halfW * 0.4, oz + halfD + 0.05, 2.5, 0.06, 0, 5, color(0x5f6b74));
  const chimneyX = halfW * 0.65;
  const chimneyZ = oz - halfD * 0.4;
  const h = b.height + rng.range(12, 20);
  addLathe(builders.solid, frame, chimneyX, chimneyZ, [[1.3, 0], [1.0, h - 3], [1.0, h]], 10, (k) => (k === 0 ? color(0xa1543a) : color(0xd9d9d9)));
}

function addWasteDepot(builders: Builders, b: Building, rng: Rng): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.06, color(0x8f8a80));
  // Open-fronted hall.
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(0x6f7a6c));
  box(builders.solid, frame, 0, oz + halfD + 0.05, halfW - 1.5, 0.06, 0, b.height - 2, DARK);
  // Heaps of sorted waste.
  const heaps = [0x7d6b55, 0x9e9e9e, 0x5d7a5d, 0xb08d57];
  for (let i = 0; i < 5; i++) {
    const x = -plot.halfW + 8 + i * ((plot.halfW * 2 - 16) / 4);
    const z = plot.halfD - 10;
    const c = color(rng.pick(heaps));
    addLathe(builders.solid, frame, x, z, [[5, 0], [3, 2], [0, 3.6]], 8, c);
  }
  // Fence along the street.
  box(builders.solid, frame, 0, plot.halfD - 0.3, plot.halfW - 6, 0.05, 0, 2, color(0x6f7a6c));
  sign(builders, frame, 'RECYCLING', 7, b.height - 1.5, oz + halfD + 0.1);
}

/** Fenced compound with transformers and a small control building. */
function addSubstation(builders: Builders, b: Building): void {
  const frame = frameOf(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, halfW, halfD, 0.07, color(0xa7a49c));
  // Fence: posts and a light mesh band on all four sides.
  const fence = color(0x8f979e);
  for (const [ox, oz, hw, hd] of [
    [0, halfD, halfW, 0.03],
    [0, -halfD, halfW, 0.03],
    [halfW, 0, 0.03, halfD],
    [-halfW, 0, 0.03, halfD],
  ] as const) {
    box(builders.solid, frame, ox, oz, hw, hd, 0.2, 2.2, fence);
  }
  for (let x = -halfW; x <= halfW + 0.01; x += 3.5) {
    for (const z of [-halfD, halfD]) box(builders.solid, frame, x, z, 0.06, 0.06, 0, 2.4, DARK);
  }
  // Transformers with cooling fins and insulators.
  const grey = color(0x7d868c);
  for (const x of [-halfW + 3.2, -halfW + 7.2]) {
    box(builders.solid, frame, x, -0.5, 1.3, 1.6, 0, 2.6, grey);
    for (const sx of [-1, 1]) box(builders.solid, frame, x + sx * 1.45, -0.5, 0.15, 1.3, 0.3, 2.3, shade(0x7d868c, 0.8));
    for (const dx of [-0.6, 0, 0.6]) box(builders.solid, frame, x + dx, -0.5, 0.09, 0.09, 2.6, 3.6, color(0xc9ced2));
  }
  // Control building.
  box(builders.solid, frame, halfW - 2.6, -halfD + 2.2, 2, 1.8, 0, 3, color(b.facadeColor), color(ROOF_GREY));
  box(builders.solid, frame, halfW - 2.6, -halfD + 4.02, 0.5, 0.03, 0, 2.1, DARK);
  // Warning sign on the fence.
  box(builders.solid, frame, 0, halfD + 0.05, 0.35, 0.02, 1.2, 1.7, color(0xffd166));
}

/** Power-company garage at the back, a paved driveway with van spots in front. */
function addUtilityDepot(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.07, color(0x9a9a96));
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(ROOF_GREY));
  // Roller doors facing the driveway.
  const doors = Math.max(1, Math.floor((halfW * 2) / 6));
  for (let i = 0; i < doors; i++) {
    const x = -halfW + ((i + 0.5) * halfW * 2) / doors;
    box(builders.solid, frame, x, oz + halfD + 0.05, 2, 0.06, 0, 3.6, color(0x6b737a));
  }
  sign(builders, frame, 'POWER CO.', 6, b.height - 0.7, oz + halfD + 0.1);
  // Yellow kerb lines at the driveway edges.
  for (const sx of [-1, 1]) addFlatRect(builders.solid, frame, sx * (plot.halfW - 0.15), 0, 0.12, plot.halfD - 0.2, 0.09, color(0xf2c230));
}

/** Bus garage at the back of the plot, open yard with parked buses in front. */
function addBusDepot(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.06, ASPHALT);
  // Hall with a shallow roof band and tall doors facing the yard.
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(ROOF_GREY));
  box(builders.solid, frame, 0, oz, halfW + 0.04, halfD + 0.04, b.height - 1.4, b.height - 0.6, GLASS);
  const doors = Math.max(3, Math.floor((halfW * 2) / 5.5));
  for (let i = 0; i < doors; i++) {
    const x = -halfW + ((i + 0.5) * halfW * 2) / doors;
    box(builders.solid, frame, x, oz + halfD + 0.05, 1.8, 0.06, 0, 4.4, color(0x5f6b74));
  }
  sign(builders, frame, 'BUS DEPOT', 8, b.height - 2.4, oz + halfD + 0.1);
  // Stall lines; the buses parked there are simulated (sim/transit).
  const yard = depotYard(b);
  if (!yard) return;
  for (const stall of yard.stalls) {
    for (const dx of [-1.9, 1.9]) addFlatRect(builders.solid, frame, stall.x + dx, yard.zStall, 0.06, 5.8, 0.08, LINE);
  }
}

function addPowerPlant(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.06, color(0xa3a099));
  // Turbine hall with a strip of high windows.
  box(builders.solid, frame, -plot.halfW + halfW + 2, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(0x8e9399));
  box(builders.solid, frame, -plot.halfW + halfW + 2, oz, halfW + 0.04, halfD + 0.04, b.height - 5, b.height - 3, GLASS);
  // Cooling tower (hyperboloid) and a tall striped chimney.
  const towerX = plot.halfW * 0.45;
  const towerZ = -plot.halfD * 0.25;
  const r = Math.min(plot.halfW, plot.halfD) * 0.42;
  addLathe(
    builders.solid,
    frame,
    towerX,
    towerZ,
    [[r, 0], [r * 0.86, 10], [r * 0.72, 22], [r * 0.66, 32], [r * 0.7, 40]],
    20,
    color(0xd7d3cc),
    color(0x5b5f63),
  );
  const chimneyX = -plot.halfW * 0.1;
  const chimneyZ = -plot.halfD * 0.65;
  const bands = 8;
  const profile: [number, number][] = [];
  for (let i = 0; i <= bands; i++) profile.push([2.4 - i * 0.12, (i * 64) / bands]);
  addLathe(builders.solid, frame, chimneyX, chimneyZ, profile, 12, (k) => (k % 2 === 0 ? color(0xe9e9e9) : color(0xc0392b)));
  // Transformer yard with small units and gantries.
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) {
      box(builders.solid, frame, -plot.halfW * 0.1 + i * 6, plot.halfD - 10 - j * 7, 1.5, 1.2, 0, 3, color(0x6b7b8c));
    }
  }
  box(builders.solid, frame, plot.halfW * 0.05, plot.halfD - 13.5, 13, 0.25, 7, 7.5, STEEL);
  // Fence and sign.
  box(builders.solid, frame, 0, plot.halfD - 0.3, plot.halfW - 6, 0.05, 0, 2.2, color(0x6f7a6c));
  sign(builders, frame, 'POWER PLANT', 9, b.height - 1.5, oz + halfD + 0.1, -plot.halfW + halfW + 2);
}

// ---------------------------------------------------------------------------
// Landmarks
// ---------------------------------------------------------------------------

function addSupermarket(builders: Builders, b: Building, rng: Rng): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  const x = -plot.halfW + halfW + 1;
  carPark(builders.solid, frame, 0, oz + halfD + (plot.halfD - (oz + halfD)) / 2, plot.halfW - 1, (plot.halfD - (oz + halfD)) / 2 - 1, rng);
  box(builders.solid, frame, x, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(ROOF_GREY));
  box(builders.solid, frame, x, oz, halfW + 0.05, halfD + 0.05, 0.4, 3.4, GLASS);
  box(builders.solid, frame, x, oz + halfD + 1.5, halfW * 0.6, 1.5, 3.6, 3.9, color(0x2e7d32));
  sign(builders, frame, 'SUPERMARKET', 10, b.height - 1.6, oz + halfD + 0.1, x);
}

function addMall(builders: Builders, b: Building, rng: Rng): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  carPark(builders.solid, frame, 0, oz + halfD + (plot.halfD - (oz + halfD)) / 2, plot.halfW - 1, (plot.halfD - (oz + halfD)) / 2 - 1, rng);
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(0xb0b5ba));
  box(builders.solid, frame, 0, oz, halfW + 0.05, halfD + 0.05, 5.5, 7, GLASS);
  // Glass atrium at the entrance.
  box(builders.solid, frame, 0, oz + halfD - 4, 9, 5, 0, b.height + 4, GLASS_LIGHT, color(0xcfe3ee));
  addLathe(builders.solid, frame, 0, oz + halfD - 4, [[5, b.height + 4], [3.5, b.height + 6], [0, b.height + 7]], 12, GLASS_LIGHT);
  sign(builders, frame, 'MALL', 9, b.height - 2, oz + halfD + 1.06);
}

function addTownHall(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  // Square in front: paving, a fountain and some trees' planters.
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.08, PAVING);
  const fz = (oz + halfD + plot.halfD) / 2;
  addLathe(builders.solid, frame, 0, fz, [[4.5, 0], [4.5, 0.7]], 16, color(0xbdb6a6), color(0x6aa6c8));
  addLathe(builders.solid, frame, 0, fz, [[0.6, 0.7], [0.4, 2.6], [1.2, 2.8], [0, 3.1]], 10, color(0xbdb6a6));
  for (const sx of [-1, 1]) box(builders.solid, frame, sx * plot.halfW * 0.6, fz, 2, 2, 0, 0.6, color(0x8d8371), GRASS);
  // Hall with three floors of windows and a stone cornice.
  box(builders.facade, frame, 0, oz, halfW, halfD, 0, b.height, wall, undefined, { bayWidth: BAY_WIDTH * 1.3, rowHeight: b.height / 3 });
  box(builders.solid, frame, 0, oz, halfW + 0.35, halfD + 0.35, b.height, b.height + 0.6, shade(b.facadeColor, 0.85), color(0x8e5a45));
  addGableRoof(builders.solid, frame, halfW, halfD, b.height + 0.6, 5, color(0x8e5a45), wall);
  // Clock tower in the middle of the front.
  const tz = oz + halfD - 3;
  box(builders.solid, frame, 0, tz, 3.2, 3.2, 0, b.height + 13, shade(b.facadeColor, 0.95));
  // Pyramid roof on the tower.
  const ty = b.height + 13;
  const apex: V3 = [0, ty + 8, tz];
  const c = (sx: number, sz: number): V3 => [sx * 3.5, ty, tz + sz * 3.5];
  const spire = color(0x4f6f5f);
  addFacing(builders.solid, frame, [c(-1, 1), c(1, 1), apex], [0, 0.5, 1], spire);
  addFacing(builders.solid, frame, [c(1, -1), c(-1, -1), apex], [0, 0.5, -1], spire);
  addFacing(builders.solid, frame, [c(1, 1), c(1, -1), apex], [1, 0.5, 0], spire);
  addFacing(builders.solid, frame, [c(-1, -1), c(-1, 1), apex], [-1, 0.5, 0], spire);
  const clock: V3[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    clock.push([Math.cos(a) * 1.6, b.height + 9 + Math.sin(a) * 1.6, tz + 3.22]);
  }
  addFacing(builders.solid, frame, clock, [0, 0, 1], color(0xf7f3e8));
  box(builders.solid, frame, 0.5, tz + 3.25, 0.6, 0.04, b.height + 8.95, b.height + 9.05, DARK);
  box(builders.solid, frame, 0, tz + 3.25, 0.05, 0.04, b.height + 9, b.height + 10.2, DARK);
  sign(builders, frame, 'TOWN HALL', 8, 4.4, tz + 3.22);
}

function addHospital(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.07, color(0xcfd2d4));
  box(builders.facade, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), undefined, { bayWidth: BAY_WIDTH, rowHeight: FLOOR_HEIGHT * 1.1 });
  box(builders.solid, frame, 0, oz, halfW + 0.25, halfD + 0.25, b.height - 0.1, b.height + 0.45, color(0xdfe5ea), color(ROOF_GREY));
  // Low emergency wing with a canopy in front.
  const wz = oz + halfD + 6;
  box(builders.facade, frame, -halfW * 0.4, wz, halfW * 0.45, 6, 0, 6.5, color(0xe6ebef), color(ROOF_GREY), { bayWidth: BAY_WIDTH * 1.4, rowHeight: 3.25 });
  box(builders.solid, frame, halfW * 0.25, wz + 3, 7, 3, 4.2, 4.6, color(0xd32f2f));
  for (const sx of [-1, 1]) box(builders.solid, frame, halfW * 0.25 + sx * 6.5, wz + 5.5, 0.2, 0.2, 0, 4.2, color(0xe0e0e0));
  // Helipad on the roof.
  const pad: V3[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    pad.push([halfW * 0.5 + Math.cos(a) * 6, b.height + 0.55, oz + Math.sin(a) * 6]);
  }
  addFacing(builders.solid, frame, pad, [0, 1, 0], color(0x3a4048));
  box(builders.solid, frame, halfW * 0.5 - 1.6, oz, 0.4, 2.6, b.height + 0.56, b.height + 0.6, LINE);
  box(builders.solid, frame, halfW * 0.5 + 1.6, oz, 0.4, 2.6, b.height + 0.56, b.height + 0.6, LINE);
  box(builders.solid, frame, halfW * 0.5, oz, 1.6, 0.35, b.height + 0.56, b.height + 0.6, LINE);
  // Red cross and sign.
  box(builders.solid, frame, -halfW + 4, oz + halfD + 0.08, 0.6, 0.05, b.height - 5, b.height - 1, color(0xd32f2f));
  box(builders.solid, frame, -halfW + 4, oz + halfD + 0.08, 2, 0.05, b.height - 3.6, b.height - 2.4, color(0xd32f2f));
  sign(builders, frame, 'HOSPITAL', 10, b.height - 3, oz + halfD + 0.1, halfW * 0.3);
}

function addSchool(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.06, GRASS);
  // L-shaped building: main wing plus a side wing.
  box(builders.facade, frame, 0, oz, halfW, halfD, 0, b.height, wall, color(ROOF_GREY), { bayWidth: BAY_WIDTH * 1.2, rowHeight: b.height / 3 });
  box(builders.facade, frame, -halfW + 6, oz + halfD + 8, 6, 8, 0, b.height * 0.66, wall, color(ROOF_GREY), { bayWidth: BAY_WIDTH * 1.2, rowHeight: b.height / 3 });
  // Sports court with lines and a flagpole.
  const cx = halfW * 0.3;
  const cz = (oz + halfD + plot.halfD) / 2 + 2;
  addFlatRect(builders.solid, frame, cx, cz, 13, 8, 0.08, color(0xd9774a));
  addFlatRect(builders.solid, frame, cx, cz, 12, 0.08, 0.1, LINE);
  addFlatRect(builders.solid, frame, cx, cz, 0.08, 7, 0.1, LINE);
  box(builders.solid, frame, plot.halfW - 4, plot.halfD - 4, 0.08, 0.08, 0, 9, color(0xcccccc));
  box(builders.solid, frame, plot.halfW - 4 + 1, plot.halfD - 4, 1, 0.03, 7.6, 8.9, color(0x2b5ca8));
  sign(builders, frame, 'SCHOOL', 7, b.height - 1.6, oz + halfD + 0.1, halfW * 0.35);
}

function addSportsHall(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.07, PAVING);
  const wallTop = b.height - 4;
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, wallTop, color(b.facadeColor));
  box(builders.solid, frame, 0, oz, halfW + 0.04, halfD + 0.04, 1, 3.5, GLASS);
  // Barrel roof across the hall.
  const segments = 10;
  const roof = color(0x2f7f8f);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI;
    const a1 = ((i + 1) / segments) * Math.PI;
    const z0 = oz - Math.cos(a0) * halfD;
    const z1 = oz - Math.cos(a1) * halfD;
    const y0 = wallTop + Math.sin(a0) * 4;
    const y1 = wallTop + Math.sin(a1) * 4;
    addFacing(builders.solid, frame, [[-halfW - 0.3, y0, z0], [halfW + 0.3, y0, z0], [halfW + 0.3, y1, z1], [-halfW - 0.3, y1, z1]], [0, 1, (z0 + z1) / 2 - oz], roof);
    for (const sx of [-1, 1]) {
      addFacing(builders.solid, frame, [[sx * halfW, wallTop, oz], [sx * halfW, y0, z0], [sx * halfW, y1, z1]], [sx, 0, 0], color(b.facadeColor));
    }
  }
  sign(builders, frame, 'SPORTS HALL', 9, wallTop - 1.4, oz + halfD + 0.1);
}

function addPool(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = footprintOffset(b);
  const { halfW, halfD } = b.footprint;
  addFlatRect(builders.solid, frame, 0, 0, plot.halfW, plot.halfD, 0.06, GRASS);
  box(builders.solid, frame, 0, oz, halfW, halfD, 0, b.height, color(b.facadeColor), GLASS_LIGHT);
  box(builders.solid, frame, 0, oz, halfW + 0.04, halfD + 0.04, 0.6, b.height - 1, GLASS_LIGHT);
  // Outdoor pool on a deck.
  const pz = (oz + halfD + plot.halfD) / 2;
  addFlatRect(builders.solid, frame, 0, pz, halfW * 0.9, 9, 0.08, PAVING);
  addFlatRect(builders.solid, frame, 0, pz, halfW * 0.75, 6.5, 0.1, color(0x3fb4e0));
  for (let k = -2; k <= 2; k++) addFlatRect(builders.solid, frame, 0, pz + k * 2.6, halfW * 0.72, 0.05, 0.11, LINE);
  sign(builders, frame, 'SWIMMING POOL', 10, b.height - 1.4, oz + halfD + 0.1);
}

function addStadium(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const W = plot.halfW;
  const D = plot.halfD;
  addFlatRect(builders.solid, frame, 0, 0, W, D, 0.06, CONCRETE);
  // Pitch with mowing stripes and lines.
  const pw = W - 13;
  const pd = D - 13;
  addFlatRect(builders.solid, frame, 0, 0, pw, pd, 0.08, color(0x4f9a46));
  const stripes = 8;
  for (let i = 0; i < stripes; i += 2) {
    const x0 = -pw + (i * 2 * pw) / stripes;
    addFlatRect(builders.solid, frame, x0 + pw / stripes, 0, pw / stripes, pd, 0.09, color(0x5aa951));
  }
  addFlatRect(builders.solid, frame, 0, 0, 0.1, pd - 1, 0.1, LINE);
  addFlatRect(builders.solid, frame, 0, -pd + 1, pw - 1, 0.1, 0.1, LINE);
  addFlatRect(builders.solid, frame, 0, pd - 1, pw - 1, 0.1, 0.1, LINE);
  addFlatRect(builders.solid, frame, -pw + 1, 0, 0.1, pd - 1, 0.1, LINE);
  addFlatRect(builders.solid, frame, pw - 1, 0, 0.1, pd - 1, 0.1, LINE);
  // Stands: three stepped tiers on every side.
  const seat = [color(0xc62828), color(0x1565c0), color(0xd8dde2)];
  for (let tier = 0; tier < 3; tier++) {
    const inner = 1 + tier * 3.5;
    const y1 = 3 + tier * 3.3;
    box(builders.solid, frame, 0, -(pd + inner + 1.75), pw + inner + 3.5, 1.75, 0, y1, shade(0xb0b5ba, 0.9), seat[tier]);
    box(builders.solid, frame, 0, pd + inner + 1.75, pw + inner + 3.5, 1.75, 0, y1, shade(0xb0b5ba, 0.9), seat[tier]);
    box(builders.solid, frame, -(pw + inner + 1.75), 0, 1.75, pd + inner, 0, y1, shade(0xb0b5ba, 0.9), seat[tier]);
    box(builders.solid, frame, pw + inner + 1.75, 0, 1.75, pd + inner, 0, y1, shade(0xb0b5ba, 0.9), seat[tier]);
  }
  // Roof over the main stand and floodlights in the corners.
  box(builders.solid, frame, 0, -(pd + 7), pw + 6, 5.5, b.height + 1, b.height + 1.5, color(0xe8eaec));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(builders.solid, frame, sx * (W - 2), sz * (D - 2), 0.4, 0.4, 0, 28, STEEL);
      box(builders.solid, frame, sx * (W - 2), sz * (D - 2), 2, 0.5, 28, 30, color(0xf5f5f0));
    }
  }
}

// ---------------------------------------------------------------------------
// Railway buildings (tracks and platforms are drawn by the rail view)
// ---------------------------------------------------------------------------

/** Footprint centre in the plot frame; railway buildings stand in the front part. */
function frontOffset(b: Building): number {
  return b.plot ? b.plot.halfD - b.footprint.halfD : 0;
}

function addTrainStation(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const oz = frontOffset(b);
  const { halfW, halfD } = b.footprint;
  const wall = color(b.facadeColor);
  // Forecourt between the building and the street side of the plot is paved.
  addFlatRect(builders.solid, frame, 0, oz, b.plot!.halfW, halfD, 0.07, PAVING);
  // Main hall with tall arched windows and a central clock gable.
  box(builders.facade, frame, 0, oz, halfW, halfD, 0, b.height, wall, color(0x7d5a44), { bayWidth: BAY_WIDTH * 1.6, rowHeight: b.height / 2 });
  box(builders.solid, frame, 0, oz, halfW + 0.3, halfD + 0.3, b.height, b.height + 0.6, shade(b.facadeColor, 0.85), color(0x7d5a44));
  box(builders.solid, frame, 0, oz + halfD - 1, 5, 1.2, b.height, b.height + 5, wall);
  const clock: V3[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    clock.push([Math.cos(a) * 1.3, b.height + 2.6 + Math.sin(a) * 1.3, oz + halfD + 0.25]);
  }
  addFacing(builders.solid, frame, clock, [0, 0, 1], color(0xf7f3e8));
  box(builders.solid, frame, 0, oz + halfD + 1.4, halfW * 0.6, 1.4, 4, 4.3, color(0x1f3a5f));
  sign(builders, frame, b.name === 'West Station' ? 'WEST STATION' : 'CENTRAL STATION', 11, b.height - 1.5, oz + halfD + 0.1);
}

function addFreightYard(builders: Builders, b: Building): void {
  const frame = plotFrame(b);
  const plot = b.plot!;
  const oz = frontOffset(b);
  const { halfW, halfD } = b.footprint;
  // Office / warehouse on the street side.
  box(builders.solid, frame, -plot.halfW + halfW + 2, oz, halfW, halfD, 0, b.height, color(b.facadeColor), color(0x9ea4a8));
  box(builders.solid, frame, -plot.halfW + halfW + 2, oz, halfW + 0.04, halfD + 0.04, b.height - 2.2, b.height - 1.2, GLASS);
  sign(builders, frame, b.kind === 'freight_hub' ? 'FREIGHT HUB' : 'FREIGHT TERMINAL', 9, b.height - 3.2, oz + halfD + 0.1, -plot.halfW + halfW + 2);
  // The gantry crane and the container stacks are simulated (render/freightView.ts).
}
