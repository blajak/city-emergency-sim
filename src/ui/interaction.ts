import * as THREE from 'three';
import type { IncidentType } from '../sim/dispatch/types';
import type { Simulation } from '../sim/Simulation';
import type { Bus } from '../sim/transit/busSystem';
import type { Building, BusStop } from '../sim/world/types';
import { BuildingHighlight, pickBuilding, rayBoxDistance } from '../render/picking';
import { shelterPlacement } from '../render/transitView';
import { vehicleBodies } from '../sim/traffic/vehicle';
import { type Subject, subjectForVehicle } from './vehicleInfo';

type TransitPick = { kind: 'bus'; bus: Bus } | { kind: 'stop'; stop: BusStop } | { kind: 'subject'; subject: Subject };

/** Pointer travel (px) above which a press counts as a camera drag, not a click. */
const CLICK_TOLERANCE = 6;
const VALID = 0xff8a1f;
const INVALID = 0xe5484d;
const STATION = 0x2f6fe4;

function isStation(building: Building): boolean {
  return building.kind === 'fire_station' || building.kind === 'police_station';
}

/** Buildings that open a card when clicked without a report tool. */
function isClickable(building: Building): boolean {
  return isStation(building) || building.kind === 'power_plant';
}

export interface InteractionCallbacks {
  onReport(type: IncidentType, building: Building): void;
  onRejected(message: string): void;
  /** Click on a station while no report tool is active. */
  onStation(building: Building, screen: { x: number; y: number }): void;
  /** Click on a bus or a bus stop while no report tool is active. */
  onBus(bus: Bus, screen: { x: number; y: number }): void;
  onStop(stop: BusStop, screen: { x: number; y: number }): void;
  /** Click on any other vehicle or a train while no report tool is active. */
  onVehicle(subject: Subject, screen: { x: number; y: number }): void;
  /** Click on the power plant while no report tool is active. */
  onPowerPlant(screen: { x: number; y: number }): void;
  /** Click on anything else while no report tool is active. */
  onEmptyClick(): void;
}

/**
 * Turns clicks on buildings into incident reports while a report tool is
 * active; otherwise clicking a station opens its unit card.
 */
export class BuildingInteraction {
  readonly highlight = new BuildingHighlight();
  private tool: IncidentType | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pressedAt: { x: number; y: number } | null = null;
  /** Clickable box around each stop's shelter and sign. */
  private readonly stopBoxes: { stop: BusStop; x: number; z: number; rotation: number; halfW: number }[];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly sim: Simulation,
    private readonly callbacks: InteractionCallbacks,
  ) {
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerdown', (e) => (this.pressedAt = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => this.highlight.hide());
    this.stopBoxes = sim.city.transit.stops.map((stop) => {
      const p = shelterPlacement(sim.city, stop);
      return { stop, x: p.center.x, z: p.center.z, rotation: p.rotation, halfW: p.halfLength + 0.6 };
    });
  }

  setTool(tool: IncidentType | null): void {
    this.tool = tool;
    this.canvas.style.cursor = tool ? 'crosshair' : '';
    this.highlight.hide();
  }

  private aim(e: PointerEvent): THREE.Ray {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray;
  }

  private pick(e: PointerEvent): Building | null {
    return pickBuilding(this.aim(e), this.sim.city.buildings);
  }

  /** Vehicle, train or bus stop under the cursor (they stand in front of buildings, so they win). */
  private pickTransit(e: PointerEvent): TransitPick | null {
    const ray = this.aim(e);
    const { sim } = this;
    let best: TransitPick | null = null;
    let bestDistance = Infinity;
    const consider = (d: number | null, pick: () => TransitPick) => {
      if (d !== null && d < bestDistance) {
        bestDistance = d;
        best = pick();
      }
    };
    for (const vehicle of sim.traffic.vehicles) {
      const height = vehicle.length > 7 ? 3.4 : 2;
      for (const body of vehicleBodies(vehicle)) {
        const d = rayBoxDistance(ray, body.pose.x, body.pose.z, body.pose.yaw, body.width / 2 + 0.3, body.length / 2 + 0.3, height);
        consider(d, () => {
          const subject = subjectForVehicle(sim, vehicle);
          return subject.kind === 'bus' ? { kind: 'bus', bus: subject.bus } : { kind: 'subject', subject };
        });
      }
    }
    // Utility vans on the driveway, off the road network.
    for (const crew of sim.power.crews) {
      if (crew.vehicle || !crew.move) continue;
      const d = rayBoxDistance(ray, crew.pose.x, crew.pose.z, crew.pose.yaw, 1.3, 3, 2.4);
      consider(d, () => ({ kind: 'subject', subject: { kind: 'crew', crew } }));
    }
    for (const train of sim.rail.trains) {
      for (const car of sim.rail.carBodies(train)) {
        const d = rayBoxDistance(ray, car.x, car.z, car.yaw, 1.7, car.length / 2, 4.2);
        consider(d, () => ({ kind: 'subject', subject: { kind: 'train', train } }));
      }
    }
    for (const box of this.stopBoxes) {
      const d = rayBoxDistance(ray, box.x, box.z, box.rotation, box.halfW, 1.2, 3);
      if (d !== null && d < bestDistance) {
        bestDistance = d;
        best = { kind: 'stop', stop: box.stop };
      }
    }
    return best;
  }

  private rejection(building: Building): string | null {
    if (isStation(building)) return 'Stations cannot be incident targets.';
    if (this.sim.dispatcher.activeIncidentAt(building.id)) return 'This building already has an active incident.';
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (e.buttons !== 0) return;
    const building = this.pick(e);
    if (!this.tool) {
      // Without a tool, only stations, buses and bus stops are interactive.
      if (this.pickTransit(e)) {
        this.highlight.hide();
        this.canvas.style.cursor = 'pointer';
      } else if (building && isClickable(building)) {
        this.highlight.show(building, STATION);
        this.canvas.style.cursor = 'pointer';
      } else {
        this.highlight.hide();
        this.canvas.style.cursor = '';
      }
      return;
    }
    if (!building) {
      this.highlight.hide();
      this.canvas.style.cursor = 'crosshair';
      return;
    }
    const invalid = this.rejection(building) !== null;
    this.highlight.show(building, invalid ? INVALID : VALID);
    this.canvas.style.cursor = invalid ? 'not-allowed' : 'pointer';
  }

  private onUp(e: PointerEvent): void {
    const pressed = this.pressedAt;
    this.pressedAt = null;
    if (!pressed || e.button !== 0) return;
    if (Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > CLICK_TOLERANCE) return;
    const building = this.pick(e);
    if (!this.tool) {
      const transit = this.pickTransit(e);
      const screen = { x: e.clientX, y: e.clientY };
      if (transit?.kind === 'bus') this.callbacks.onBus(transit.bus, screen);
      else if (transit?.kind === 'stop') this.callbacks.onStop(transit.stop, screen);
      else if (transit?.kind === 'subject') this.callbacks.onVehicle(transit.subject, screen);
      else if (building?.kind === 'power_plant') this.callbacks.onPowerPlant(screen);
      else if (building && isStation(building)) this.callbacks.onStation(building, { x: e.clientX, y: e.clientY });
      else this.callbacks.onEmptyClick();
      return;
    }
    if (!building) return;
    const problem = this.rejection(building);
    if (problem) this.callbacks.onRejected(problem);
    else this.callbacks.onReport(this.tool, building);
  }
}
