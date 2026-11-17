import * as THREE from 'three';
import { samplePolyline, subPolyline } from '../sim/math/geometry';
import { type Vec2, add, normalize, rightOf, scale, sub } from '../sim/math/vec2';
import type { CarModel, RailSystem } from '../sim/rail/railSystem';
import { LANE_WIDTH } from '../sim/world/constants';
import { type Track, isPassengerTrack } from '../sim/world/rail';
import { RoadIndex } from '../sim/world/roadIndex';
import type { City } from '../sim/world/types';
import { Frame, GeometryBuilder, type V3, addBox, addFacing } from './geometryBuilder';
import { buildCarModel } from './trainModels';

const RAIL_GAUGE_HALF = 0.72;
const SLEEPER_SPACING = 0.8;
const PLATFORM_OFFSET = 3.25;
const PLATFORM_HALF_WIDTH = 1.5;
const PLATFORM_HEIGHT = 0.95;
const CAR_CAPACITY = 64;

const STEEL = new THREE.Color(0x8b9096);
const CONCRETE = new THREE.Color(0xc9c5bc);
const DARK = new THREE.Color(0x15181b);
const CANOPY = new THREE.Color(0x4f6d7a);
const LAMP_ON = new THREE.Color(0xff2a1f);
const LAMP_OFF = new THREE.Color(0x3a1513);

/** Tracks, platforms, tunnel portals, level crossings and the trains themselves. */
export class RailView {
  readonly group = new THREE.Group();
  private readonly cars = new Map<CarModel, THREE.InstancedMesh>();
  private readonly arms: THREE.InstancedMesh;
  private readonly lamps: THREE.InstancedMesh;
  private readonly armBases: { position: THREE.Vector3; yaw: number; crossing: number; lamps: [V3, V3] }[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly roll = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(
    city: City,
    private readonly rail: RailSystem,
  ) {
    this.group.name = 'rail';
    const solid = new GeometryBuilder();
    const roads = new RoadIndex(city.roads);
    const sleeperSpots: { p: Vec2; yaw: number }[] = [];

    for (const track of city.rail.tracks) {
      addRails(solid, track);
      for (let s = 0.4; s < track.length; s += SLEEPER_SPACING) {
        const { point, dir } = samplePolyline(track.points, s);
        if (roads.isNear(point, 4.4)) continue; // the street surface covers the sleepers
        sleeperSpots.push({ p: point, yaw: Math.atan2(dir.x, dir.z) });
      }
    }
    for (const station of city.buildings.filter((b) => b.kind === 'train_station')) addPlatforms(solid, city.rail.tracks, station.plot?.center ?? station.footprint.center);
    addTunnelPortals(solid, city.rail.tracks);
    this.addCrossingFurniture(solid);

    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    const staticMesh = new THREE.Mesh(solid.build(), material);
    staticMesh.castShadow = true;
    staticMesh.receiveShadow = true;
    this.group.add(staticMesh);

    const sleepers = new THREE.InstancedMesh(
      new THREE.BoxGeometry(2.5, 0.14, 0.24).translate(0, 0.12, 0),
      new THREE.MeshStandardMaterial({ color: 0x8f8a82, roughness: 1 }),
      sleeperSpots.length,
    );
    sleeperSpots.forEach(({ p, yaw }, i) => {
      this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      sleepers.setMatrixAt(i, this.matrix.compose(new THREE.Vector3(p.x, 0, p.z), this.quat, this.one));
    });
    sleepers.receiveShadow = true;
    this.group.add(sleepers);

    // Barrier arms (pivot at one end) and warning lamps, updated every frame.
    this.arms = new THREE.InstancedMesh(
      new THREE.BoxGeometry(4.2, 0.13, 0.13).translate(2.1, 0, 0),
      new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }),
      Math.max(1, this.armBases.length),
    );
    this.arms.castShadow = true;
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.13, 8, 6), new THREE.MeshBasicMaterial(), Math.max(1, this.armBases.length * 2));
    this.armBases.forEach((base, i) => {
      base.lamps.forEach(([x, y, z], k) => {
        this.lamps.setMatrixAt(i * 2 + k, this.matrix.makeTranslation(x, y, z));
        this.lamps.setColorAt(i * 2 + k, LAMP_OFF);
      });
    });
    this.group.add(this.arms, this.lamps);

    for (const model of ['emu_cab', 'emu_middle', 'freight_loco', 'container_wagon'] as CarModel[]) {
      const length = model === 'freight_loco' ? 12 : model === 'container_wagon' ? 12.5 : 17;
      const mesh = new THREE.InstancedMesh(buildCarModel(model, length), material, CAR_CAPACITY);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.cars.set(model, mesh);
      this.group.add(mesh);
    }
  }

  update(alpha: number, time: number): void {
    this.updateCrossings(time);
    this.updateTrains(alpha);
  }

  private updateTrains(alpha: number): void {
    const counts = new Map<CarModel, number>();
    for (const train of this.rail.trains) {
      const s = train.prevS + (train.s - train.prevS) * alpha;
      let cursor = s;
      train.cars.forEach((car, index) => {
        const front = cursor;
        const rear = cursor - car.length;
        cursor = rear - 1;
        const outside = front < 0.5 || rear > train.track.length - 0.5;
        // Cars still (or again) inside a tunnel are not drawn; the shuttle never leaves its track.
        if (train.kind !== 'freight' && outside) return;
        const points = train.track.points;
        const a = samplePolyline(points, Math.max(0, front - 2.6)).point;
        const b = samplePolyline(points, Math.max(0, rear + 2.6)).point;
        const mid = samplePolyline(points, (front + rear) / 2).point;
        let yaw = Math.atan2(a.x - b.x, a.z - b.z);
        // The rear cab of a passenger set faces the other way.
        if (car.model === 'emu_cab' && index === train.cars.length - 1) yaw += Math.PI;
        const mesh = this.cars.get(car.model)!;
        const i = counts.get(car.model) ?? 0;
        if (i >= CAR_CAPACITY) return;
        counts.set(car.model, i + 1);
        this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        mesh.setMatrixAt(i, this.matrix.compose(this.pos.set(mid.x, 0.12, mid.z), this.quat, this.one));
      });
    }
    for (const [model, mesh] of this.cars) {
      mesh.count = counts.get(model) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private updateCrossings(time: number): void {
    const flash = Math.floor(time * 3) % 2;
    this.armBases.forEach((base, i) => {
      const crossing = this.rail.crossings[base.crossing];
      const angle = (1 - crossing.barrier) * (Math.PI / 2) * 0.95;
      this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), base.yaw);
      this.roll.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
      this.quat.multiply(this.roll);
      this.arms.setMatrixAt(i, this.matrix.compose(base.position, this.quat, this.one));
      const active = crossing.state !== 'open' || crossing.barrier > 0.05;
      this.lamps.setColorAt(i * 2, active && flash === 0 ? LAMP_ON : LAMP_OFF);
      this.lamps.setColorAt(i * 2 + 1, active && flash === 1 ? LAMP_ON : LAMP_OFF);
    });
    this.arms.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }

  /** Posts, crossbuck signs and the base transform of every barrier arm. */
  private addCrossingFurniture(solid: GeometryBuilder): void {
    for (const crossing of this.rail.crossings) {
      for (const lc of crossing.lanes) {
        const lanePoints = this.rail.lanePoints(lc.laneId);
        const { point, dir } = samplePolyline(lanePoints, lc.stopS);
        const right = rightOf(dir);
        const post = add(point, scale(right, LANE_WIDTH / 2 + 0.9));
        const frame = new Frame(post.x, post.z, Math.atan2(-dir.x, -dir.z)); // local +z faces oncoming traffic
        addBox(solid, { frame, halfW: 0.09, halfD: 0.09, y0: 0, y1: 3.1, color: new THREE.Color(0xe8e8e8) });
        addBox(solid, { frame, oz: 0.02, halfW: 0.42, halfD: 0.06, y0: 1.75, y1: 2.25, color: DARK });
        addCrossbuck(solid, frame, 2.75);
        // Arm points from the post across the lane, towards the centre line.
        const across = scale(right, -1);
        this.armBases.push({
          position: new THREE.Vector3(post.x, 1.1, post.z),
          yaw: Math.atan2(-across.z, across.x),
          crossing: crossing.id,
          lamps: [frame.toWorld(-0.2, 2.0, 0.12), frame.toWorld(0.2, 2.0, 0.12)],
        });
        addBox(solid, { frame, halfW: 0.18, halfD: 0.18, y0: 0, y1: 1.2, color: new THREE.Color(0xd32f2f) });
      }
    }
  }
}

/** Two rails per track, following the centre line. */
function addRails(b: GeometryBuilder, track: Track): void {
  const frame = new Frame(0, 0, 0);
  for (const lateral of [-RAIL_GAUGE_HALF, RAIL_GAUGE_HALF]) {
    const points = offset(track.points, lateral);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const c = points[i + 1];
      const n = scale(rightOf(normalize(sub(c, a))), 0.06);
      const quad = (y: number, l0: number, l1: number): V3[] => [
        [a.x + n.x * l0, y, a.z + n.z * l0],
        [c.x + n.x * l0, y, c.z + n.z * l0],
        [c.x + n.x * l1, y, c.z + n.z * l1],
        [a.x + n.x * l1, y, a.z + n.z * l1],
      ];
      addFacing(b, frame, quad(0.34, -1, 1), [0, 1, 0], STEEL);
      addFacing(b, frame, [[a.x - n.x, 0.18, a.z - n.z], [c.x - n.x, 0.18, c.z - n.z], [c.x - n.x, 0.34, c.z - n.z], [a.x - n.x, 0.34, a.z - n.z]], [-n.x, 0, -n.z], STEEL);
      addFacing(b, frame, [[a.x + n.x, 0.18, a.z + n.z], [c.x + n.x, 0.18, c.z + n.z], [c.x + n.x, 0.34, c.z + n.z], [a.x + n.x, 0.34, a.z + n.z]], [n.x, 0, n.z], STEEL);
    }
  }
}

function offset(points: readonly Vec2[], lateral: number): Vec2[] {
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    return add(p, scale(rightOf(normalize(sub(next, prev))), lateral));
  });
}

/** Box-shaped strip following a polyline (platforms, canopies). */
function addStrip(b: GeometryBuilder, points: readonly Vec2[], lateral: number, halfWidth: number, y0: number, y1: number, color: THREE.Color): void {
  const frame = new Frame(0, 0, 0);
  const inner = offset(points, lateral - halfWidth);
  const outer = offset(points, lateral + halfWidth);
  for (let i = 0; i < points.length - 1; i++) {
    const p: V3[] = [
      [inner[i].x, y1, inner[i].z],
      [inner[i + 1].x, y1, inner[i + 1].z],
      [outer[i + 1].x, y1, outer[i + 1].z],
      [outer[i].x, y1, outer[i].z],
    ];
    addFacing(b, frame, p, [0, 1, 0], color);
    const n = rightOf(normalize(sub(points[i + 1], points[i])));
    addFacing(b, frame, [[inner[i].x, y0, inner[i].z], [inner[i + 1].x, y0, inner[i + 1].z], [inner[i + 1].x, y1, inner[i + 1].z], [inner[i].x, y1, inner[i].z]], [-n.x, 0, -n.z], color);
    addFacing(b, frame, [[outer[i].x, y0, outer[i].z], [outer[i + 1].x, y0, outer[i + 1].z], [outer[i + 1].x, y1, outer[i + 1].z], [outer[i].x, y1, outer[i].z]], [n.x, 0, n.z], color);
  }
  for (const end of [0, points.length - 1]) {
    const toward = end === 0 ? sub(points[0], points[1]) : sub(points[end], points[end - 1]);
    addFacing(b, frame, [[inner[end].x, y0, inner[end].z], [outer[end].x, y0, outer[end].z], [outer[end].x, y1, outer[end].z], [inner[end].x, y1, inner[end].z]], [toward.x, 0, toward.z], color);
  }
}

/** Platforms on the outer side of both passenger tracks, canopies and a footbridge. */
function addPlatforms(b: GeometryBuilder, tracks: readonly Track[], centre: Vec2): void {
  const ends: Vec2[] = [];
  for (const track of tracks.filter((t) => isPassengerTrack(t.kind))) {
    const sc = projectS(track, centre);
    const strip = subPolyline(track.points, sc - 32, sc + 32, 2);
    addStrip(b, strip, PLATFORM_OFFSET, PLATFORM_HALF_WIDTH, 0, PLATFORM_HEIGHT, CONCRETE);
    addStrip(b, strip, PLATFORM_OFFSET - PLATFORM_HALF_WIDTH + 0.15, 0.12, PLATFORM_HEIGHT, PLATFORM_HEIGHT + 0.02, new THREE.Color(0xf2d02e));
    const roof = subPolyline(track.points, sc - 24, sc + 24, 2);
    addStrip(b, roof, PLATFORM_OFFSET + 0.2, 1.8, 4.1, 4.35, CANOPY);
    for (let s = sc - 22; s <= sc + 22; s += 8) {
      const { point, dir } = samplePolyline(track.points, s);
      const p = add(point, scale(rightOf(dir), PLATFORM_OFFSET + 0.9));
      addBox(b, { frame: new Frame(p.x, p.z, 0), halfW: 0.1, halfD: 0.1, y0: PLATFORM_HEIGHT, y1: 4.1, color: CANOPY });
    }
    // Both ends of the footbridge at the same place along the line.
    const reference = ends.length === 0 ? samplePolyline(track.points, sc + 18).point : ends[0];
    const sb = ends.length === 0 ? sc + 18 : projectS(track, reference);
    const { point, dir } = samplePolyline(track.points, sb);
    ends.push(add(point, scale(rightOf(dir), PLATFORM_OFFSET)));
  }
  // Footbridge joining the two platforms over the tracks.
  if (ends.length === 2) {
    const [p, q] = ends;
    const mid = scale(add(p, q), 0.5);
    const along = normalize(sub(q, p));
    const half = Math.hypot(q.x - p.x, q.z - p.z) / 2;
    const frame = new Frame(mid.x, mid.z, Math.atan2(along.x, along.z));
    addBox(b, { frame, halfW: 1.3, halfD: half + 1.3, y0: 6.3, y1: 6.7, color: CONCRETE });
    addBox(b, { frame, halfW: 1.35, halfD: half + 1.3, y0: 6.7, y1: 7.7, color: new THREE.Color(0x9fb8c4) });
    for (const end of [-1, 1]) addBox(b, { frame, oz: end * half, halfW: 1.4, halfD: 1.4, y0: PLATFORM_HEIGHT, y1: 7.8, color: CANOPY });
  }
}

function projectS(track: Track, p: Vec2): number {
  let best = Infinity;
  let bestS = 0;
  for (let s = 0; s < track.length; s += 1) {
    const q = samplePolyline(track.points, s).point;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < best) {
      best = d;
      bestS = s;
    }
  }
  return bestS;
}

/** Earth mounds with concrete portals where the line leaves the map. */
function addTunnelPortals(b: GeometryBuilder, tracks: readonly Track[]): void {
  const passenger = tracks.filter((t) => isPassengerTrack(t.kind));
  if (passenger.length < 2) return;
  // The long-distance freight siding comes out of the same hill, through its own mouth.
  const longhaul = tracks.find((t) => t.kind === 'longhaul');
  if (longhaul) {
    const mouth = longhaul.points[0];
    const inward = normalize(sub(longhaul.points[1], longhaul.points[0]));
    const frame = new Frame(mouth.x, mouth.z, Math.atan2(inward.x, inward.z));
    addBox(b, { frame, oz: 7.05, halfW: 3.4, halfD: 0.4, y0: 0, y1: 6.6, color: CONCRETE });
    addBox(b, { frame, oz: 7.5, halfW: 2.4, halfD: 0.08, y0: 0.1, y1: 5.4, color: DARK });
  }
  const [east, west] = passenger;
  const mouths = [
    { a: east.points[0], b: west.points[west.points.length - 1], inward: normalize(sub(east.points[1], east.points[0])) },
    { a: east.points[east.points.length - 1], b: west.points[0], inward: normalize(sub(west.points[1], west.points[0])) },
  ];
  const grass = new THREE.Color(0x8fb56a);
  const earth = new THREE.Color(0x7a5c43);
  for (const { a, b: bb, inward } of mouths) {
    const centre = scale(add(a, bb), 0.5);
    const frame = new Frame(centre.x, centre.z, Math.atan2(inward.x, inward.z));
    addBox(b, { frame, oz: 0, halfW: 16, halfD: 7, y0: 0, y1: 10, color: earth, topColor: grass });
    addBox(b, { frame, oz: 7.05, halfW: 7.2, halfD: 0.4, y0: 0, y1: 8.4, color: CONCRETE });
    addBox(b, { frame, oz: 7.5, halfW: 5.6, halfD: 0.08, y0: 0.1, y1: 6.8, color: DARK });
  }
}

/** St Andrew's cross on the barrier post. */
function addCrossbuck(b: GeometryBuilder, frame: Frame, y: number): void {
  const red = new THREE.Color(0xd32f2f);
  for (const sign of [-1, 1]) {
    const a = (sign * Math.PI) / 4;
    const dx = Math.cos(a) * 0.6;
    const dy = Math.sin(a) * 0.6;
    const nx = -Math.sin(a) * 0.09;
    const ny = Math.cos(a) * 0.09;
    const quad: V3[] = [
      [-dx - nx, y - dy - ny, 0.12],
      [dx - nx, y + dy - ny, 0.12],
      [dx + nx, y + dy + ny, 0.12],
      [-dx + nx, y - dy + ny, 0.12],
    ];
    addFacing(b, frame, quad, [0, 0, 1], sign > 0 ? red : new THREE.Color(0xf2f2f2));
    addFacing(b, frame, quad.map(([x, yy, z]) => [x, yy, z - 0.02] as V3), [0, 0, -1], new THREE.Color(0xf2f2f2));
  }
}
