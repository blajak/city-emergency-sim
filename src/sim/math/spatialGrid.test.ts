import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { type AABB, SpatialGrid } from './spatialGrid';

const overlaps = (a: AABB, b: AABB) => a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;

describe('SpatialGrid', () => {
  it('finds exactly the boxes a brute-force scan finds, each once', () => {
    const rng = createRng(4);
    const boxes: AABB[] = Array.from({ length: 500 }, () => {
      const x = rng.range(-500, 500);
      const z = rng.range(-500, 500);
      return { minX: x, minZ: z, maxX: x + rng.range(0.5, 60), maxZ: z + rng.range(0.5, 60) };
    });
    const grid = new SpatialGrid<AABB>(25);
    for (const b of boxes) grid.insert(b, b);

    for (let i = 0; i < 200; i++) {
      const x = rng.range(-550, 550);
      const z = rng.range(-550, 550);
      const q = { minX: x, minZ: z, maxX: x + rng.range(1, 80), maxZ: z + rng.range(1, 80) };
      const found = grid.query(q).filter((b) => overlaps(b, q));
      const expected = boxes.filter((b) => overlaps(b, q));
      expect(new Set(found)).toEqual(new Set(expected));
      expect(found.length).toBe(new Set(found).size);
    }
  });
});
