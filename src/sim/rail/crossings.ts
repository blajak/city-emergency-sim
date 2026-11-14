import { intersectPolylines, projectOnPolyline, samplePolyline } from '../math/geometry';
import type { Vec2 } from '../math/vec2';
import type { LaneGraph, SegmentId } from '../traffic/laneGraph';
import type { Track } from '../world/rail';
import type { RoadNetwork } from '../world/types';

/**
 * Half width of the danger zone across a track, m: half a train (1.6) plus
 * half a road vehicle (1.0) plus margin. Widened for streets crossing at an angle.
 */
const ZONE_HALF_WIDTH = 3.2;
/** Barrier stands this far before the danger zone, m. */
const BARRIER_SETBACK = 2.5;
/** Track crossings closer than this along a street belong to one level crossing, m. */
const GROUP_DISTANCE = 20;

export type CrossingState = 'open' | 'warning' | 'closed';

/** A level crossing as seen from one lane. */
export interface LaneCrossing {
  crossing: LevelCrossing;
  laneId: SegmentId;
  /** Where vehicles stop (barrier), along the lane. */
  stopS: number;
  /** Danger zone (tracks) along the lane. */
  startS: number;
  endS: number;
}

export interface LevelCrossing {
  id: number;
  edgeId: number;
  /** Where the street crosses the tracks (centre of the crossing). */
  point: Vec2;
  /** Position of the crossing along each track it spans. */
  tracks: { trackId: number; s: number }[];
  lanes: LaneCrossing[];
  state: CrossingState;
  /** Seconds in the current state. */
  timer: number;
  /** 0 = barriers up, 1 = barriers down (for rendering). */
  barrier: number;
  /** A road vehicle is inside the danger zone. */
  occupied: boolean;
}

/** Finds every place a street crosses the railway and maps it onto lanes. */
export function findLevelCrossings(network: RoadNetwork, graph: LaneGraph, tracks: readonly Track[]): LevelCrossing[] {
  const crossings: LevelCrossing[] = [];
  for (const edge of network.edges) {
    const hits = tracks.flatMap((track) =>
      intersectPolylines(edge.points, track.points).map((hit) => ({ track, edgeS: hit.sa, trackS: hit.sb, point: hit.point })),
    );
    hits.sort((a, b) => a.edgeS - b.edgeS);
    // Group neighbouring tracks (e.g. a double track) into one crossing.
    const groups: (typeof hits)[] = [];
    for (const hit of hits) {
      const last = groups[groups.length - 1];
      if (last && hit.edgeS - last[last.length - 1].edgeS < GROUP_DISTANCE) last.push(hit);
      else groups.push([hit]);
    }
    for (const group of groups) {
      const crossing: LevelCrossing = {
        id: crossings.length,
        edgeId: edge.id,
        point: group[Math.floor(group.length / 2)].point,
        tracks: group.map((h) => ({ trackId: h.track.id, s: h.trackS })),
        lanes: [],
        state: 'open',
        timer: 0,
        barrier: 0,
        occupied: false,
      };
      for (const lane of graph.lanes.filter((l) => l.edgeId === edge.id)) {
        const spans = group.map((h) => {
          const s = projectOnPolyline(lane.points, h.point);
          const laneDir = samplePolyline(lane.points, s).dir;
          const trackDir = samplePolyline(h.track.points, h.trackS).dir;
          const sin = Math.abs(laneDir.x * trackDir.z - laneDir.z * trackDir.x);
          const half = ZONE_HALF_WIDTH / Math.max(sin, 0.3);
          return [s - half, s + half];
        });
        const startS = Math.min(...spans.map((x) => x[0]));
        const endS = Math.max(...spans.map((x) => x[1]));
        crossing.lanes.push({ crossing, laneId: lane.id, stopS: startS - BARRIER_SETBACK, startS, endS });
      }
      crossings.push(crossing);
    }
  }
  return crossings;
}

export function crossingsByLane(crossings: readonly LevelCrossing[]): Map<SegmentId, LaneCrossing[]> {
  const map = new Map<SegmentId, LaneCrossing[]>();
  for (const crossing of crossings) {
    for (const lc of crossing.lanes) {
      const list = map.get(lc.laneId) ?? [];
      list.push(lc);
      list.sort((a, b) => a.stopS - b.stopS);
      map.set(lc.laneId, list);
    }
  }
  return map;
}
