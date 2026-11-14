import type * as THREE from 'three';
import type { Simulation } from '../sim/Simulation';

const REFRESH_MS = 500;

/** Small performance read-out, enabled with `?debug`. */
export class DebugOverlay {
  private readonly el: HTMLElement;
  private frames = 0;
  private frameTime = 0;
  private last = performance.now();

  constructor(
    container: HTMLElement,
    private readonly sim: Simulation,
    private readonly renderer: THREE.WebGLRenderer,
  ) {
    this.el = document.createElement('pre');
    this.el.className = 'debug-overlay';
    container.appendChild(this.el);
  }

  /** Call once per frame with the frame's wall-clock duration. */
  update(frameMs: number): void {
    this.frames++;
    this.frameTime += frameMs;
    const now = performance.now();
    if (now - this.last < REFRESH_MS) return;
    const fps = (this.frames * 1000) / (now - this.last);
    const { calls, triangles } = this.renderer.info.render;
    const { city, traffic } = this.sim;
    this.el.textContent = [
      `FPS        ${fps.toFixed(0)}`,
      `frame      ${(this.frameTime / this.frames).toFixed(1)} ms`,
      `sim step   ${this.sim.stepMs.toFixed(2)} ms`,
      `draw calls ${calls}`,
      `triangles  ${(triangles / 1000).toFixed(0)}k`,
      `vehicles   ${traffic.vehicles.length}`,
      `buildings  ${city.buildings.length}`,
      `streets    ${city.roads.edges.length}`,
      `scale      ${city.scale}×`,
    ].join('\n');
    this.frames = 0;
    this.frameTime = 0;
    this.last = now;
  }
}
