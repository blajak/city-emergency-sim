import * as THREE from 'three';
import { add, normalize, rightOf, scale, sub } from '../sim/math/vec2';
import type { LightState, SignalSystem } from '../sim/signals/signalSystem';
import type { Lane, LaneGraph, SegmentId } from '../sim/traffic/laneGraph';
import { LANE_WIDTH } from '../sim/world/constants';
import { Frame, GeometryBuilder, addBox } from './geometryBuilder';

const SIDEWALK_Y = 0.12;
/** Pole stands this far beyond the road edge, on the sidewalk. */
const POLE_OFFSET = 1.1;
const LAMP_RADIUS = 0.13;
/** Heights of red, yellow and green lamps. */
const LAMP_HEIGHTS = [3.28, 2.98, 2.68];
const LAMP_FORWARD = 0.36;

const POLE = new THREE.Color(0x2f3337);
const HOUSING = new THREE.Color(0x1d1f22);
const BACKPLATE = new THREE.Color(0xf2f2f2);

const LIT: Record<LightState, THREE.Color> = {
  red: new THREE.Color(0xff3b30),
  yellow: new THREE.Color(0xffc21a),
  green: new THREE.Color(0x2fe36b),
};
const OFF = [new THREE.Color(0x3b2120), new THREE.Color(0x3b3420), new THREE.Color(0x1f3526)];
const ORDER: LightState[] = ['red', 'yellow', 'green'];

/** One signal head per signalised approach, on a pole at the stop line. */
export class SignalsView {
  readonly group = new THREE.Group();
  private readonly lanes: SegmentId[] = [];
  private readonly lamps: THREE.InstancedMesh;
  private readonly lastState: (LightState | null)[] = [];

  constructor(
    private readonly signals: SignalSystem,
    graph: LaneGraph,
  ) {
    this.group.name = 'signals';
    for (const controller of signals.controllers) this.lanes.push(...controller.phases.flat());

    const builder = new GeometryBuilder();
    this.lamps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(LAMP_RADIUS, 10, 8),
      new THREE.MeshBasicMaterial(),
      this.lanes.length * 3,
    );

    const matrix = new THREE.Matrix4();
    this.lanes.forEach((laneId, i) => {
      const lane = graph.segments[laneId] as Lane;
      const end = lane.points[lane.points.length - 1];
      const dir = normalize(sub(end, lane.points[lane.points.length - 2]));
      const pos = add(end, scale(rightOf(dir), LANE_WIDTH / 2 + POLE_OFFSET));
      // Head faces the approaching drivers.
      const frame = new Frame(pos.x, pos.z, Math.atan2(-dir.x, -dir.z));

      addBox(builder, { frame, halfW: 0.07, halfD: 0.07, y0: SIDEWALK_Y, y1: 3.6, color: POLE });
      addBox(builder, { frame, oz: 0.22, halfW: 0.34, halfD: 0.03, y0: 2.38, y1: 3.58, color: BACKPLATE });
      addBox(builder, { frame, oz: 0.2, halfW: 0.22, halfD: 0.13, y0: 2.48, y1: 3.48, color: HOUSING });

      LAMP_HEIGHTS.forEach((y, k) => {
        const [x, , z] = frame.toWorld(0, y, LAMP_FORWARD);
        matrix.makeTranslation(x, y, z);
        this.lamps.setMatrixAt(i * 3 + k, matrix);
        this.lamps.setColorAt(i * 3 + k, OFF[k]);
      });
      this.lastState.push(null);
    });

    const poles = new THREE.Mesh(
      builder.build(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2 }),
    );
    poles.castShadow = true;
    this.group.add(poles, this.lamps);
    this.update();
  }

  update(): void {
    let changed = false;
    this.lanes.forEach((laneId, i) => {
      const state = this.signals.lightFor(laneId);
      if (state === this.lastState[i]) return;
      this.lastState[i] = state;
      changed = true;
      ORDER.forEach((light, k) => this.lamps.setColorAt(i * 3 + k, state === light ? LIT[light] : OFF[k]));
    });
    if (changed && this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
  }
}
