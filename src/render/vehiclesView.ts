import * as THREE from 'three';
import { TRUCK, VEHICLE_DIMENSIONS, type Pose, type Vehicle, type VehicleModel } from '../sim/traffic/vehicle';
import { type VehicleModelGeometry, buildVehicleModel } from './vehicleModels';

/** Road surface height (vehicles sit on the asphalt layer). */
const ROAD_Y = 0.16;
/** Beacon flashes per second (alternating left/right). */
const FLASH_RATE = 3;
const INITIAL_CAPACITY = 64;

/** What the view needs from a vehicle (road traffic or a bus moving in the depot yard). */
export type RenderVehicle = Pick<Vehicle, 'model' | 'color' | 'pose' | 'prevPose' | 'sirens'> &
  Partial<Pick<Vehicle, 'trailer' | 'prevTrailer'>>;

const BEACON_ON = new THREE.Color(0x3d8bff);
const BEACON_OFF = new THREE.Color(0x1a2a44);

/** Instanced meshes for one vehicle model; grown on demand. */
interface ModelBatch {
  model: VehicleModelGeometry;
  paint: THREE.InstancedMesh;
  fixed: THREE.InstancedMesh;
  capacity: number;
}

/**
 * Draws every vehicle with a few instanced meshes (one pair per model plus
 * one for all beacons), so hundreds of vehicles cost a handful of draw
 * calls. Poses are interpolated between simulation ticks.
 */
export class VehiclesView {
  readonly group = new THREE.Group();
  private readonly batches = new Map<VehicleModel, ModelBatch>();
  private readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
  private readonly beaconGeometry = new THREE.BoxGeometry(0.42, 0.22, 0.3);
  private beacons: THREE.InstancedMesh;
  private beaconCapacity = INITIAL_CAPACITY;

  private readonly matrix = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor() {
    this.group.name = 'vehicles';
    this.beacons = this.createBeacons(this.beaconCapacity);
  }

  update(input: readonly RenderVehicle[], alpha: number, time: number): void {
    // An articulated lorry is drawn as two instances: tractor and trailer.
    const vehicles: RenderVehicle[] = [];
    for (const v of input) {
      vehicles.push(v);
      if (v.trailer && v.prevTrailer) {
        vehicles.push({ model: 'trailer', color: v.color, pose: v.trailer, prevPose: v.prevTrailer, sirens: false });
      }
    }
    const flash = Math.floor(time * FLASH_RATE * 2) % 2;
    const counts = new Map<VehicleModel, number>();
    for (const v of vehicles) counts.set(v.model, (counts.get(v.model) ?? 0) + 1);
    for (const [model, count] of counts) this.ensureCapacity(model, count);

    const used = new Map<VehicleModel, number>();
    let beaconCount = 0;
    for (const vehicle of vehicles) {
      const batch = this.batches.get(vehicle.model)!;
      const i = used.get(vehicle.model) ?? 0;
      used.set(vehicle.model, i + 1);

      const pose = interpolate(vehicle.prevPose, vehicle.pose, alpha);
      this.position.set(pose.x, ROAD_Y, pose.z);
      this.quaternion.setFromAxisAngle(this.up, pose.yaw);
      this.matrix.compose(this.position, this.quaternion, this.one);
      batch.paint.setMatrixAt(i, this.matrix);
      batch.fixed.setMatrixAt(i, this.matrix);
      batch.paint.setColorAt(i, this.color.setHex(vehicle.color));

      batch.model.beacons.forEach((mount, k) => {
        if (beaconCount >= this.beaconCapacity) this.growBeacons();
        this.local.makeTranslation(mount.x, mount.y, mount.z);
        this.beacons.setMatrixAt(beaconCount, this.local.premultiply(this.matrix));
        this.beacons.setColorAt(beaconCount, vehicle.sirens && k % 2 === flash ? BEACON_ON : BEACON_OFF);
        beaconCount++;
      });
    }

    for (const [model, batch] of this.batches) {
      const count = used.get(model) ?? 0;
      for (const mesh of [batch.paint, batch.fixed]) {
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
      }
      if (batch.paint.instanceColor) batch.paint.instanceColor.needsUpdate = true;
    }
    this.beacons.count = beaconCount;
    this.beacons.instanceMatrix.needsUpdate = true;
    if (this.beacons.instanceColor) this.beacons.instanceColor.needsUpdate = true;
  }

  private ensureCapacity(model: VehicleModel, count: number): void {
    let batch = this.batches.get(model);
    if (batch && batch.capacity >= count) return;
    const capacity = Math.max(INITIAL_CAPACITY, batch ? batch.capacity * 2 : 0, count);
    if (batch) {
      this.group.remove(batch.paint, batch.fixed);
      batch.paint.dispose();
      batch.fixed.dispose();
    }
    // The tractor of an articulated lorry is drawn on its own (the trailer is a separate model).
    const length = model === 'truck' ? TRUCK.tractorLength : VEHICLE_DIMENSIONS[model].length;
    const geometry = batch?.model ?? buildVehicleModel(model, length, VEHICLE_DIMENSIONS[model].width);
    batch = {
      model: geometry,
      paint: this.instanced(geometry.paint, capacity),
      fixed: this.instanced(geometry.fixed, capacity),
      capacity,
    };
    // Allocate the colour buffer up front so `instanceColor` exists from the start.
    batch.paint.setColorAt(0, this.color.setHex(0xffffff));
    this.batches.set(model, batch);
    this.group.add(batch.paint, batch.fixed);
  }

  private instanced(geometry: THREE.BufferGeometry, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    return mesh;
  }

  private createBeacons(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.beaconGeometry, new THREE.MeshBasicMaterial(), capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.setColorAt(0, BEACON_OFF);
    this.group.add(mesh);
    return mesh;
  }

  /** Doubles the beacon buffer, keeping instances already written this frame. */
  private growBeacons(): void {
    const old = this.beacons;
    this.beaconCapacity *= 2;
    this.beacons = this.createBeacons(this.beaconCapacity);
    this.beacons.instanceMatrix.array.set(old.instanceMatrix.array);
    if (old.instanceColor && this.beacons.instanceColor) this.beacons.instanceColor.array.set(old.instanceColor.array);
    this.group.remove(old);
    old.dispose();
  }
}

function interpolate(a: Pose, b: Pose, t: number): Pose {
  let dYaw = b.yaw - a.yaw;
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: a.yaw + dYaw * t };
}
