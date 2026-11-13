import * as THREE from 'three';
import { subPolyline } from '../sim/math/geometry';
import { type Vec2, add, normalize, rightOf, scale, sub, vec2 } from '../sim/math/vec2';
import { CROSSWALK_LENGTH, LANE_WIDTH, ROAD_WIDTH, STREET_CLEARANCE } from '../sim/world/constants';
import { approachDistance } from '../sim/world/roadGeometry';
import type { Park, RoadEdge, RoadNetwork, RoadNode } from '../sim/world/types';
import { GeometryBuilder } from './geometryBuilder';

/** Layer heights, low to high, so flat layers never z-fight. */
const Y = {
  park: 0.04,
  pond: 0.07,
  sidewalk: 0.12,
  asphalt: 0.16,
  marking: 0.2,
};

const COLORS = {
  park: new THREE.Color(0x86b562),
  pond: new THREE.Color(0x6aa6c8),
  pondEdge: new THREE.Color(0xc9c2b2),
  sidewalk: new THREE.Color(0xc4beb3),
  asphalt: new THREE.Color(0x454a50),
  marking: new THREE.Color(0xf2f2ee),
};

const DASH = 3;

export function createRoadsView(network: RoadNetwork, parks: readonly Park[]): THREE.Mesh {
  const b = new GeometryBuilder();

  for (const park of parks) {
    b.addGroundPolygon(park.polygon, Y.park, COLORS.park);
    b.addGroundPolygon(circle(park.pond.center, park.pond.radius + 1.2, 28), Y.pond - 0.01, COLORS.pondEdge);
    b.addGroundPolygon(circle(park.pond.center, park.pond.radius, 28), Y.pond, COLORS.pond);
  }

  for (const edge of network.edges) {
    addRibbon(b, edge.points, STREET_CLEARANCE, Y.sidewalk, COLORS.sidewalk);
    addRibbon(b, edge.points, ROAD_WIDTH / 2, Y.asphalt, COLORS.asphalt);
  }
  for (const node of network.nodes) {
    // Rounded corners: the sidewalk disc fills the outer notch, the asphalt disc the turning radius.
    b.addGroundPolygon(circle(node.pos, STREET_CLEARANCE * 1.42, 24), Y.sidewalk, COLORS.sidewalk);
    b.addGroundPolygon(circle(node.pos, (ROAD_WIDTH / 2) * 1.2, 24), Y.asphalt, COLORS.asphalt);
  }

  for (const edge of network.edges) addMarkings(b, edge, network.nodes[edge.from], network.nodes[edge.to]);

  const mesh = new THREE.Mesh(
    b.build(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'roads';
  return mesh;
}

function addMarkings(b: GeometryBuilder, edge: RoadEdge, from: RoadNode, to: RoadNode): void {
  const pts = edge.points;
  const start = from.clearance + (from.signalized ? CROSSWALK_LENGTH + 1.5 : 1);
  const end = edge.length - to.clearance - (to.signalized ? CROSSWALK_LENGTH + 1.5 : 1);

  // Dashed centre line.
  for (let s = start; s + DASH <= end; s += DASH * 2) {
    addRibbon(b, subPolyline(pts, s, s + DASH, 1), 0.08, Y.marking, COLORS.marking);
  }

  // Zebra crossing and stop line on the incoming lane at each signalised end.
  const addCrossing = (zebraStart: number, stopAt: number, incomingOffset: number) => {
    const zebra = subPolyline(pts, zebraStart, zebraStart + CROSSWALK_LENGTH, 1);
    for (let lat = -3; lat <= 3; lat += 1) {
      addRibbon(b, zebra, 0.25, Y.marking, COLORS.marking, lat);
    }
    addRibbon(b, subPolyline(pts, stopAt, stopAt + 0.4, 1), LANE_WIDTH / 2 - 0.2, Y.marking, COLORS.marking, incomingOffset);
  };
  if (from.signalized) {
    addCrossing(from.clearance, approachDistance(from) - 0.4, -LANE_WIDTH / 2);
  }
  if (to.signalized) {
    const zebraStart = edge.length - to.clearance - CROSSWALK_LENGTH;
    addCrossing(zebraStart, edge.length - approachDistance(to), LANE_WIDTH / 2);
  }
}

/** Flat strip of half-width `halfWidth` following `points`, shifted sideways by `offset`. */
function addRibbon(
  b: GeometryBuilder,
  points: readonly Vec2[],
  halfWidth: number,
  y: number,
  color: THREE.Color,
  offset = 0,
): void {
  const normals = points.map((_, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    return rightOf(normalize(sub(next, prev)));
  });
  const at = (i: number, lateral: number) => add(points[i], scale(normals[i], offset + lateral));
  for (let i = 0; i < points.length - 1; i++) {
    b.addGroundPolygon([at(i, -halfWidth), at(i, halfWidth), at(i + 1, halfWidth), at(i + 1, -halfWidth)], y, color);
  }
}

function circle(center: Vec2, radius: number, segments: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(vec2(center.x + Math.cos(a) * radius, center.z + Math.sin(a) * radius));
  }
  return out;
}
