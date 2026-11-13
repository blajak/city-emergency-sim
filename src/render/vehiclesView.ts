import * as THREE from 'three';
import type { Pose, Vehicle, VehicleId } from '../sim/traffic/vehicle';
import { type VehicleModelGeometry, buildVehicleModel } from './vehicleModels';

/** Road surface height (vehicles sit on the asphalt layer). */
const ROAD_Y = 0.16;
/** Beacon flashes per second (alternating left/right). */
const FLASH_RATE = 3;

const BEACON_ON = new THREE.Color(0x3d8bff);
const BEACON_OFF = new THREE.Color(0x1a2a44);

interface VehicleMesh {
  body: THREE.Mesh;
  beacons: THREE.Mesh<THREE.BoxGeometry, THREE.MeshBasicMaterial>[];
}

/**
 * Draws vehicles as low-poly meshes. Each model/colour combination gets one
 * merged geometry; poses are interpolated between simulation ticks. Service
 * vehicles get flashing beacons.
 */
export class VehiclesView {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<VehicleId, VehicleMesh>();
  private readonly models = new Map<string, VehicleModelGeometry>();
  private readonly beaconGeometry = new THREE.BoxGeometry(0.42, 0.22, 0.3);
  private readonly material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.15,
  });

  constructor() {
    this.group.name = 'vehicles';
  }

  update(vehicles: readonly Vehicle[], alpha: number, time: number): void {
    const alive = new Set<VehicleId>();
    const flash = Math.floor(time * FLASH_RATE * 2) % 2;
    for (const vehicle of vehicles) {
      alive.add(vehicle.id);
      const mesh = this.meshes.get(vehicle.id) ?? this.createMesh(vehicle);
      const pose = interpolate(vehicle.prevPose, vehicle.pose, alpha);
      mesh.body.position.set(pose.x, ROAD_Y, pose.z);
      mesh.body.rotation.y = pose.yaw;
      mesh.beacons.forEach((beacon, i) => {
        beacon.material.color.copy(vehicle.sirens && i % 2 === flash ? BEACON_ON : BEACON_OFF);
      });
    }
    for (const [id, mesh] of this.meshes) {
      if (alive.has(id)) continue;
      this.group.remove(mesh.body);
      mesh.beacons.forEach((b) => b.material.dispose());
      this.meshes.delete(id);
    }
  }

  private createMesh(vehicle: Vehicle): VehicleMesh {
    const model = this.modelFor(vehicle);
    const body = new THREE.Mesh(model.geometry, this.material);
    body.castShadow = true;
    const beacons = model.beacons.map((mount) => {
      const beacon = new THREE.Mesh(this.beaconGeometry, new THREE.MeshBasicMaterial({ color: BEACON_OFF }));
      beacon.position.set(mount.x, mount.y, mount.z);
      body.add(beacon);
      return beacon;
    });
    const mesh = { body, beacons };
    this.meshes.set(vehicle.id, mesh);
    this.group.add(body);
    return mesh;
  }

  private modelFor(vehicle: Vehicle): VehicleModelGeometry {
    const key = `${vehicle.model}:${vehicle.color}`;
    let model = this.models.get(key);
    if (!model) {
      model = buildVehicleModel(vehicle.model, vehicle.length, vehicle.width, new THREE.Color(vehicle.color));
      this.models.set(key, model);
    }
    return model;
  }
}

function interpolate(a: Pose, b: Pose, t: number): Pose {
  let dYaw = b.yaw - a.yaw;
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, yaw: a.yaw + dYaw * t };
}
