import * as THREE from 'three';
import { CHASSIS_DECK, CONTAINER_HEIGHT, CONTAINER_LENGTH, CONTAINER_WIDTH, type ContainerSystem, WAGON_DECK, type Yard } from '../sim/freight/containerSystem';
import { Frame, GeometryBuilder, addBox, addFlatRect } from './geometryBuilder';

/** Gantry cranes, their rails and stack pads, and every container (instanced). */

const YELLOW = new THREE.Color(0xf2b134);
const DARK = new THREE.Color(0x3a3f45);
const STEEL = new THREE.Color(0x6f757b);
const PAD = new THREE.Color(0xb9b4a8);
const RAIL = new THREE.Color(0x55595e);
const GLASS = new THREE.Color(0x2c3a46);
/** Underside of the crane's girders, m. */
const BEAM_Y = 14.2;
const CONTAINER_CAPACITY = 160;

interface CraneMeshes {
  yard: Yard;
  yaw: number;
  /** +1 when the yard's w axis is the local +x of the crane's frame, else -1. */
  side: number;
  gantry: THREE.Mesh;
  trolley: THREE.Mesh;
  spreader: THREE.Mesh;
  cables: THREE.Mesh;
}

export class FreightView {
  readonly group = new THREE.Group();
  private readonly cranes: CraneMeshes[] = [];
  private readonly boxes: THREE.InstancedMesh;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly color = new THREE.Color();

  constructor(private readonly system: ContainerSystem) {
    this.group.name = 'freight';
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    const ground = new GeometryBuilder();
    for (const yard of system.yards) {
      const yaw = Math.atan2(yard.uAxis.x, yard.uAxis.z);
      const side = Math.sign(yard.wAxis.x * Math.cos(yaw) - yard.wAxis.z * Math.sin(yaw)) || 1;
      const frame = new Frame(yard.origin.x, yard.origin.z, yaw);
      const [u0, u1] = yard.uRange;
      const reach = yard.halfSpan + 1.5;
      // Crane rails along both legs and concrete pads under the stacks.
      for (const w of yard.legs) {
        addBox(ground, { frame, ox: w * side, oz: (u0 + u1) / 2, halfW: 0.35, halfD: (u1 - u0) / 2 + reach, y0: 0, y1: 0.16, color: RAIL });
      }
      for (const s of yard.stacks) {
        addFlatRect(ground, frame, s.w * side, s.u, CONTAINER_WIDTH / 2 + 0.25, CONTAINER_LENGTH / 2 + 0.3, 0.06, PAD);
      }
      this.cranes.push(this.buildCrane(yard, yaw, side, material));
    }
    const groundMesh = new THREE.Mesh(ground.build(), material);
    groundMesh.receiveShadow = true;
    this.group.add(groundMesh);

    this.boxes = new THREE.InstancedMesh(containerGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 }), CONTAINER_CAPACITY);
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.castShadow = true;
    this.boxes.receiveShadow = true;
    this.boxes.frustumCulled = false;
    this.boxes.count = 0;
    this.group.add(this.boxes);
  }

  update(alpha: number): void {
    for (const c of this.cranes) this.updateCrane(c);
    this.updateContainers(alpha);
  }

  private buildCrane(yard: Yard, yaw: number, side: number, material: THREE.Material): CraneMeshes {
    const f = new Frame(0, 0, 0);
    const [wa, wb] = yard.legs.map((w) => w * side).sort((a, b) => a - b);
    const hs = yard.halfSpan;
    const gantry = new GeometryBuilder();
    const box = (b: GeometryBuilder, ox: number, oz: number, halfW: number, halfD: number, y0: number, y1: number, color: THREE.Color) =>
      addBox(b, { frame: f, ox, oz, halfW, halfD, y0, y1, color });
    for (const x of [wa, wb]) {
      // Sill beam with wheel bogies, two legs, and a tie along the top.
      box(gantry, x, 0, 0.45, hs + 1.2, 0.2, 1.0, YELLOW);
      for (const z of [-hs - 0.9, hs + 0.9]) box(gantry, x, z, 0.5, 0.5, 0, 0.35, DARK);
      for (const z of [-hs, hs]) box(gantry, x, z, 0.35, 0.35, 1.0, BEAM_Y, YELLOW);
      box(gantry, x, 0, 0.4, hs + 0.4, BEAM_Y - 1.0, BEAM_Y + 1.2, YELLOW);
    }
    // Two girders across, with a short cantilever beyond the legs.
    for (const z of [-1.3, 1.3]) box(gantry, (wa + wb) / 2, z, (wb - wa) / 2 + 2.5, 0.35, BEAM_Y, BEAM_Y + 1.3, YELLOW);
    // Operator's cab under the girders near the first leg.
    box(gantry, wa + 1.6, -2.2, 0.9, 0.8, BEAM_Y - 2.2, BEAM_Y, GLASS);
    const gantryMesh = this.mesh(gantry, material);

    const trolley = new GeometryBuilder();
    box(trolley, 0, 0, 1.4, 1.8, BEAM_Y + 1.3, BEAM_Y + 2.3, STEEL);
    box(trolley, 0, 0, 1.0, 1.2, BEAM_Y + 2.3, BEAM_Y + 2.9, YELLOW);
    const trolleyMesh = this.mesh(trolley, material);

    const spreader = new GeometryBuilder();
    box(spreader, 0, 0, CONTAINER_WIDTH / 2 + 0.05, CONTAINER_LENGTH / 2, 0, 0.35, YELLOW);
    box(spreader, 0, 0, 0.5, 1.2, 0.35, 0.9, STEEL);
    const spreaderMesh = this.mesh(spreader, material);

    // Four cables, 1 m tall, scaled to the hoist length every frame.
    const cables = new GeometryBuilder();
    for (const x of [-0.35, 0.35]) for (const z of [-0.9, 0.9]) box(cables, x, z, 0.04, 0.04, 0, 1, DARK);
    const cablesMesh = this.mesh(cables, material);
    cablesMesh.castShadow = false;

    for (const m of [gantryMesh, trolleyMesh, spreaderMesh, cablesMesh]) m.rotation.y = yaw;
    return { yard, yaw, side, gantry: gantryMesh, trolley: trolleyMesh, spreader: spreaderMesh, cables: cablesMesh };
  }

  private mesh(b: GeometryBuilder, material: THREE.Material): THREE.Mesh {
    const m = new THREE.Mesh(b.build(), material);
    m.castShadow = true;
    this.group.add(m);
    return m;
  }

  private updateCrane(c: CraneMeshes): void {
    const { crane } = c.yard;
    const base = this.system.toWorld(c.yard, crane.u, 0);
    c.gantry.position.set(base.x, 0, base.z);
    const at = this.system.toWorld(c.yard, crane.u, crane.w);
    c.trolley.position.set(at.x, 0, at.z);
    c.spreader.position.set(at.x, crane.h, at.z);
    c.cables.position.set(at.x, crane.h + 0.9, at.z);
    c.cables.scale.set(1, Math.max(0.1, BEAM_Y + 1.3 - crane.h - 0.9), 1);
  }

  private updateContainers(alpha: number): void {
    let n = 0;
    const put = (x: number, y: number, z: number, yaw: number, color: number) => {
      if (n >= CONTAINER_CAPACITY) return;
      this.quat.setFromAxisAngle(this.up, yaw);
      this.boxes.setMatrixAt(n, this.matrix.compose(this.pos.set(x, y, z), this.quat, this.one));
      this.boxes.setColorAt(n, this.color.setHex(color));
      n++;
    };
    for (const train of this.system.trains()) {
      const load = this.system.loadOf(train);
      if (!load) continue;
      const s = train.prevS + (train.s - train.prevS) * alpha;
      load.forEach((c, car) => {
        if (!c) return;
        const front = s - train.cars.slice(0, car).reduce((sum, x) => sum + x.length + 1, 0);
        // Not drawn while in the tunnel.
        if (front < 0.5 || front - train.cars[car].length > train.track.length - 0.5) return;
        const p = this.system.carPose(train, car, s);
        put(p.x, WAGON_DECK, p.z, p.yaw, c.color);
      });
    }
    // On container lorries, following the trailer.
    for (const lorry of this.system.lorries) {
      const t = lorry.vehicle.trailer;
      const p = lorry.vehicle.prevTrailer;
      if (!lorry.container || !t || !p) continue;
      let dyaw = t.yaw - p.yaw;
      if (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      if (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      put(p.x + (t.x - p.x) * alpha, CHASSIS_DECK, p.z + (t.z - p.z) * alpha, p.yaw + dyaw * alpha, lorry.container.color);
    }
    for (const c of this.cranes) {
      const yard = c.yard;
      for (const st of yard.stacks) {
        const p = this.system.toWorld(yard, st.u, st.w);
        st.tiers.forEach((box, tier) => put(p.x, tier * CONTAINER_HEIGHT, p.z, c.yaw, box.color));
      }
      const held = yard.crane.holding;
      if (held) {
        const p = this.system.toWorld(yard, yard.crane.u, yard.crane.w);
        put(p.x, yard.crane.h - CONTAINER_HEIGHT, p.z, c.yaw, held.color);
      }
    }
    this.boxes.count = n;
    this.boxes.instanceMatrix.needsUpdate = true;
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
  }
}

/** A 40 ft box with darker corner posts and end doors, origin at the bottom centre. */
function containerGeometry(): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  const f = new Frame(0, 0, 0);
  const white = new THREE.Color(0xffffff);
  const shade = new THREE.Color(0xb8b8b8);
  const hw = CONTAINER_WIDTH / 2;
  const hl = CONTAINER_LENGTH / 2;
  addBox(b, { frame: f, halfW: hw, halfD: hl, y0: 0, y1: CONTAINER_HEIGHT, color: white, topColor: new THREE.Color(0xdedede) });
  // Ribs along the sides.
  for (let z = -hl + 0.6; z < hl - 0.3; z += 0.9) addBox(b, { frame: f, oz: z, halfW: hw + 0.03, halfD: 0.08, y0: 0.15, y1: CONTAINER_HEIGHT - 0.15, color: shade });
  for (const z of [-hl, hl]) for (const x of [-hw, hw]) addBox(b, { frame: f, ox: x * 0.97, oz: z * 0.99, halfW: 0.09, halfD: 0.09, y0: 0, y1: CONTAINER_HEIGHT, color: shade });
  return b.build();
}
