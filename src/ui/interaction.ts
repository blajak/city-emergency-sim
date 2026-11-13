import * as THREE from 'three';
import type { IncidentType } from '../sim/dispatch/types';
import type { Simulation } from '../sim/Simulation';
import type { Building } from '../sim/world/types';
import { BuildingHighlight, pickBuilding } from '../render/picking';

/** Pointer travel (px) above which a press counts as a camera drag, not a click. */
const CLICK_TOLERANCE = 6;
const VALID = 0xff8a1f;
const INVALID = 0xe5484d;
const STATION = 0x2f6fe4;

function isStation(building: Building): boolean {
  return building.kind === 'fire_station' || building.kind === 'police_station';
}

export interface InteractionCallbacks {
  onReport(type: IncidentType, building: Building): void;
  onRejected(message: string): void;
  /** Click on a station while no report tool is active. */
  onStation(building: Building, screen: { x: number; y: number }): void;
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
  }

  setTool(tool: IncidentType | null): void {
    this.tool = tool;
    this.canvas.style.cursor = tool ? 'crosshair' : '';
    this.highlight.hide();
  }

  private pick(e: PointerEvent): Building | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return pickBuilding(this.raycaster.ray, this.sim.city.buildings);
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
      // Without a tool, only stations are interactive.
      if (building && isStation(building)) {
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
      if (building && isStation(building)) this.callbacks.onStation(building, { x: e.clientX, y: e.clientY });
      else this.callbacks.onEmptyClick();
      return;
    }
    if (!building) return;
    const problem = this.rejection(building);
    if (problem) this.callbacks.onRejected(problem);
    else this.callbacks.onReport(this.tool, building);
  }
}
