import { type OBB, obbCorners } from './geometry';
import type { Vec2 } from './vec2';

export interface AABB {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * Uniform grid over the ground plane for "what is near here?" queries.
 * Items are stored in every cell their bounding box touches; queries return
 * each matching item once.
 */
export class SpatialGrid<T> {
  private readonly cells = new Map<number, T[]>();
  /** Incremented per query to de-duplicate items spanning several cells. */
  private stamp = 0;
  private readonly seen = new Map<T, number>();

  constructor(private readonly cellSize: number) {}

  insert(item: T, box: AABB): void {
    this.forCells(box, (key) => {
      const list = this.cells.get(key);
      if (list) list.push(item);
      else this.cells.set(key, [item]);
    });
  }

  /** All items whose boxes overlap `box` (possibly a few more; callers do the exact test). */
  query(box: AABB): T[] {
    const out: T[] = [];
    const stamp = ++this.stamp;
    this.forCells(box, (key) => {
      for (const item of this.cells.get(key) ?? []) {
        if (this.seen.get(item) === stamp) continue;
        this.seen.set(item, stamp);
        out.push(item);
      }
    });
    return out;
  }

  queryPoint(p: Vec2, radius: number): T[] {
    return this.query(around(p, radius));
  }

  private forCells(box: AABB, fn: (key: number) => void): void {
    const x0 = Math.floor(box.minX / this.cellSize);
    const x1 = Math.floor(box.maxX / this.cellSize);
    const z0 = Math.floor(box.minZ / this.cellSize);
    const z1 = Math.floor(box.maxZ / this.cellSize);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) fn(cellKey(x, z));
    }
  }
}

/** Packs two signed cell coordinates (|c| < 32768) into one number key. */
function cellKey(x: number, z: number): number {
  return (x + 32768) * 65536 + (z + 32768);
}

export function around(p: Vec2, radius: number): AABB {
  return { minX: p.x - radius, minZ: p.z - radius, maxX: p.x + radius, maxZ: p.z + radius };
}

export function pointsBox(points: readonly Vec2[], pad = 0): AABB {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

export function obbBox(box: OBB, pad = 0): AABB {
  return pointsBox(obbCorners(box), pad);
}
