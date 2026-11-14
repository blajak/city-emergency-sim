import { polylineLength } from '../math/geometry';
import { type Vec2, add, lerp, normalize, rightOf, scale, sub, vec2 } from '../math/vec2';
import { STREET_CLEARANCE } from './constants';
import type { Block, CityLayout } from './roadNetwork';
import { railRow } from './roadNetwork';
import type { Bounds } from './types';

/**
 * Railway layout:
 * - a double-track passenger line across the city (one track per direction),
 *   ending in tunnels at both map edges, with two stations;
 * - in bigger cities, a separate freight track from a freight hub at the east
 *   end of the line, along the corridor and then south on a branch to a
 *   freight terminal in the industrial south-east. Freight trains shuttle on it.
 * The tracks never cross each other, only streets (at level crossings).
 */

export type TrackKind = 'eastbound' | 'westbound' | 'freight';

export interface Track {
  id: number;
  kind: TrackKind;
  /** Centre line in the direction of travel (freight: hub → terminal). */
  points: Vec2[];
  length: number;
}

export type RailSiteKind = 'train_station' | 'freight_hub' | 'freight_terminal';

export interface RailSite {
  kind: RailSiteKind;
  name: string;
  block: Block;
  /** Bordering street the main building faces. */
  front: 'north' | 'south' | 'east' | 'west';
}

export interface RailPlan {
  tracks: Track[];
  sites: RailSite[];
  /** Strips kept free of buildings, trees and lamps. */
  corridors: { points: Vec2[]; halfWidth: number }[];
}

/** Distance of each passenger track from the corridor centre line. */
export const TRACK_OFFSET = 2.25;
/** Distance of the freight track from the corridor centre line (south side). */
export const FREIGHT_OFFSET = 6.75;
const FREIGHT_CURVE_RADIUS = 14;
/** Keeps buffers and parked trains away from streets at the ends of the freight line. */
const BUFFER_SETBACK = STREET_CLEARANCE + 4;

export function planRail(layout: CityLayout, bounds: Bounds): RailPlan {
  const { cols, rows } = layout.grid;
  const rr = railRow(rows);
  const blockAt = (r: number, c: number) => layout.blocks.find((b) => b.r === r && b.c === c);
  const centre = clipX(extendToX(layout.railCorridor, bounds.minX, bounds.maxX), bounds.minX, bounds.maxX);

  const eastbound = offsetPolyline(centre, TRACK_OFFSET);
  const westbound = offsetPolyline(centre, -TRACK_OFFSET).reverse();
  const tracks: Track[] = [
    { id: 0, kind: 'eastbound', points: eastbound, length: polylineLength(eastbound) },
    { id: 1, kind: 'westbound', points: westbound, length: polylineLength(westbound) },
  ];
  const corridors = [{ points: centre, halfWidth: 6 }];
  const sites: RailSite[] = [];

  // Two stations: one west of centre, one in the middle of town (on regular blocks).
  const regularColumn = (target: number, avoid: number[]) => {
    const candidates = layout.blocks.filter((b) => b.r === rr && b.regular && !avoid.includes(b.c));
    candidates.sort((a, b) => Math.abs(a.c - target) - Math.abs(b.c - target));
    return candidates[0]?.c ?? target;
  };
  const west = regularColumn(Math.round((cols - 2) * 0.28), [cols - 2, cols - 4]);
  const stationColumns = [west, regularColumn(Math.round((cols - 2) * 0.55), [west, west - 1, west + 1, cols - 2, cols - 4])];
  const names = ['West Station', 'Central Station'];
  stationColumns.forEach((c, i) => {
    const block = blockAt(rr, c);
    if (block && (i === 0 || c !== stationColumns[0])) sites.push({ kind: 'train_station', name: names[i], block, front: 'north' });
  });

  // Freight line for bigger cities.
  const branchColumn = cols - 4;
  const terminalRow = rows - 2;
  const hubBlock = blockAt(rr, cols - 2);
  const terminalBlock = blockAt(terminalRow, branchColumn);
  if (cols >= 9 && terminalRow - rr >= 2 && hubBlock && terminalBlock && !stationColumns.includes(cols - 2)) {
    const freight = freightLine(layout, centre, rr, branchColumn, terminalRow, hubBlock);
    tracks.push({ id: 2, kind: 'freight', points: freight, length: polylineLength(freight) });
    corridors.push({ points: freight, halfWidth: 4.5 });
    sites.push({ kind: 'freight_hub', name: 'Freight Hub', block: hubBlock, front: 'north' });
    sites.push({ kind: 'freight_terminal', name: 'Dockside Freight Terminal', block: terminalBlock, front: 'east' });
  }
  return { tracks, sites, corridors };
}

/**
 * Hub buffer (east) → west along the corridor's south side → curve south →
 * down the middle of a column of blocks → terminal buffer.
 */
function freightLine(layout: CityLayout, centre: Vec2[], rr: number, column: number, terminalRow: number, hub: Block): Vec2[] {
  const { nodeAt } = layout;
  const south = offsetPolyline(centre, FREIGHT_OFFSET);
  const branchX = (r: number) => lerp(nodeAt(r, column).pos, nodeAt(r, column + 1).pos, 0.5);
  const firstCrossing = branchX(rr + 1);
  const hubEastX = Math.min(hub.corners[1].x, hub.corners[2].x) - BUFFER_SETBACK;
  const turnX = firstCrossing.x + FREIGHT_CURVE_RADIUS;

  // Along the corridor (westwards), from the hub buffer to the start of the curve.
  const along = clipX(south, turnX, hubEastX).reverse();
  const start = along[along.length - 1];
  const points: Vec2[] = [...along];

  // Quarter circle from heading west to heading south.
  const centreOfTurn = vec2(start.x, start.z + FREIGHT_CURVE_RADIUS);
  for (let i = 1; i <= 8; i++) {
    const a = -Math.PI / 2 - (i / 8) * (Math.PI / 2);
    points.push(vec2(centreOfTurn.x + Math.cos(a) * FREIGHT_CURVE_RADIUS, centreOfTurn.z + Math.sin(a) * FREIGHT_CURVE_RADIUS));
  }

  // South through the column of blocks, crossing each street at its middle.
  for (let r = rr + 1; r <= terminalRow; r++) points.push(branchX(r));
  const lastStreet = branchX(terminalRow + 1);
  points.push(vec2(lastStreet.x, lastStreet.z - BUFFER_SETBACK));
  return points;
}

/** Offsets a polyline sideways (positive = right of the direction of travel). */
export function offsetPolyline(points: readonly Vec2[], lateral: number): Vec2[] {
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    return add(p, scale(rightOf(normalize(sub(next, prev))), lateral));
  });
}

/** Prolongs both ends of a west→east polyline along their direction until they reach the x range edges. */
function extendToX(points: readonly Vec2[], minX: number, maxX: number): Vec2[] {
  const out = [...points];
  const first = out[0];
  const dirStart = normalize(sub(first, out[1]));
  if (first.x > minX && dirStart.x < 0) out.unshift(add(first, scale(dirStart, (first.x - minX) / -dirStart.x + 1)));
  const last = out[out.length - 1];
  const dirEnd = normalize(sub(last, out[out.length - 2]));
  if (last.x < maxX && dirEnd.x > 0) out.push(add(last, scale(dirEnd, (maxX - last.x) / dirEnd.x + 1)));
  return out;
}

/** Cuts a west→east polyline to the x range, interpolating the end points. */
function clipX(points: readonly Vec2[], minX: number, maxX: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1];
    if (prev) {
      for (const edge of [minX, maxX]) {
        if ((prev.x - edge) * (p.x - edge) < 0) out.push(lerp(prev, p, (edge - prev.x) / (p.x - prev.x)));
      }
    }
    if (p.x >= minX && p.x <= maxX) out.push(p);
  }
  return out;
}
