import * as THREE from 'three';
import type { Dispatcher } from '../sim/dispatch/dispatcher';
import type { Incident, IncidentId } from '../sim/dispatch/types';
import { createRng } from '../sim/math/rng';
import type { City } from '../sim/world/types';
import { roofTop } from './buildingsView';

const MAX_SMOKE = 700;
const MAX_WATER = 500;
const SMOKE_LIFE = 7;
const WATER_FLIGHT = 0.9;
const WIND = new THREE.Vector3(1.4, 0, 0.7);
const FLAME_COLORS = [0xff4b1f, 0xff7a1a, 0xffa424, 0xffd04a];
/** Seconds for a reported fire to grow to full size. */
const GROW_TIME = 6;

interface FireEffect {
  group: THREE.Group;
  flames: THREE.Mesh[];
  light: THREE.PointLight;
  origin: THREE.Vector3;
  spread: { x: number; z: number; rotation: number };
  smokeDebt: number;
  waterDebt: number;
  seed: number;
}

interface Particle {
  alive: boolean;
  age: number;
  life: number;
  start: THREE.Vector3;
  end: THREE.Vector3;
  velocity: THREE.Vector3;
}

/**
 * Visual effects for active incidents: flames, smoke and glow on burning
 * buildings, and a water stream from engines working on scene.
 */
export class IncidentsView {
  readonly group = new THREE.Group();
  private readonly fires = new Map<IncidentId, FireEffect>();
  private readonly crimes = new Map<IncidentId, THREE.Sprite>();
  private readonly crimeTexture = createCrimeTexture();
  private readonly flameGeometry = new THREE.ConeGeometry(1, 1, 5).translate(0, 0.5, 0);
  private readonly smoke: THREE.InstancedMesh;
  private readonly water: THREE.InstancedMesh;
  private readonly smokeParticles: Particle[] = [];
  private readonly waterParticles: Particle[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly tmp = new THREE.Vector3();
  private lastTime: number | null = null;

  constructor(private readonly city: City) {
    this.group.name = 'incidents';
    this.smoke = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 1),
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.55, depthWrite: false, roughness: 1, flatShading: true }),
      MAX_SMOKE,
    );
    this.water = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.16, 6, 4),
      new THREE.MeshBasicMaterial({ color: 0xd8efff, transparent: true, opacity: 0.85 }),
      MAX_WATER,
    );
    for (const mesh of [this.smoke, this.water]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.group.add(mesh);
    }
    for (let i = 0; i < MAX_SMOKE; i++) this.smokeParticles.push(newParticle());
    for (let i = 0; i < MAX_WATER; i++) this.waterParticles.push(newParticle());
  }

  /** `time` is simulation time, so effects freeze when the sim is paused. */
  update(dispatcher: Dispatcher, time: number): void {
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    this.lastTime = time;

    const active = new Set<IncidentId>();
    for (const incident of dispatcher.incidents) {
      if (incident.type !== 'fire' || incident.status === 'resolved') continue;
      active.add(incident.id);
      const fire = this.fires.get(incident.id) ?? this.createFire(incident);
      const intensity = fireIntensity(incident, time);
      this.animateFire(fire, intensity, time);
      fire.smokeDebt += dt * 7 * intensity;
      while (fire.smokeDebt >= 1) {
        fire.smokeDebt -= 1;
        this.emitSmoke(fire, intensity);
      }

      const unit = dispatcher.unit(incident.unitId);
      if (incident.status === 'on_scene' && unit) {
        fire.waterDebt += dt * 45;
        const v = unit.vehicle.pose;
        const nozzle = new THREE.Vector3(v.x, 3.6, v.z);
        while (fire.waterDebt >= 1) {
          fire.waterDebt -= 1;
          this.emitWater(nozzle, fire.origin);
        }
      }
    }
    for (const [id, fire] of this.fires) {
      if (active.has(id)) continue;
      this.group.remove(fire.group);
      fire.light.dispose();
      this.fires.delete(id);
    }

    const activeCrimes = new Set<IncidentId>();
    for (const incident of dispatcher.incidents) {
      if (incident.type !== 'crime' || incident.status === 'resolved') continue;
      activeCrimes.add(incident.id);
      const marker = this.crimes.get(incident.id) ?? this.createCrimeMarker(incident);
      // Bob up and down; alternate red / blue like a beacon.
      const top = marker.userData.top as number;
      marker.position.y = top + 3.5 + Math.sin(time * 2.4) * 0.6;
      marker.material.color.setHex(Math.floor(time * 2.5) % 2 === 0 ? 0xffffff : 0xff9a9a);
      const pulse = incident.status === 'on_scene' ? 1 - (incident.workDone / incident.duration) * 0.35 : 1;
      marker.scale.setScalar(5 * pulse);
    }
    for (const [id, marker] of this.crimes) {
      if (activeCrimes.has(id)) continue;
      this.group.remove(marker);
      marker.material.dispose();
      this.crimes.delete(id);
    }

    this.updateSmoke(dt);
    this.updateWater(dt);
  }

  private createCrimeMarker(incident: Incident): THREE.Sprite {
    const building = this.city.buildings[incident.buildingId];
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.crimeTexture, depthTest: false }));
    sprite.renderOrder = 10;
    sprite.position.set(building.footprint.center.x, 0, building.footprint.center.z);
    sprite.userData.top = roofTop(building);
    this.crimes.set(incident.id, sprite);
    this.group.add(sprite);
    return sprite;
  }

  private createFire(incident: Incident): FireEffect {
    const building = this.city.buildings[incident.buildingId];
    const { center, halfW, halfD, rotation } = building.footprint;
    const origin = new THREE.Vector3(center.x, roofTop(building), center.z);
    const group = new THREE.Group();
    group.position.copy(origin);
    group.rotation.y = rotation;

    const rng = createRng(incident.id * 977 + 3);
    const flames: THREE.Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const flame = new THREE.Mesh(
        this.flameGeometry,
        new THREE.MeshBasicMaterial({ color: rng.pick(FLAME_COLORS), transparent: true, opacity: 0.92 }),
      );
      flame.position.set(rng.range(-halfW * 0.55, halfW * 0.55), -0.3, rng.range(-halfD * 0.5, halfD * 0.5));
      flame.userData.base = rng.range(2.2, 4.5);
      flame.userData.phase = rng.range(0, Math.PI * 2);
      flames.push(flame);
      group.add(flame);
    }
    const light = new THREE.PointLight(0xff7a2a, 0, 28, 2);
    light.position.set(0, 3, 0);
    group.add(light);
    this.group.add(group);

    const fire: FireEffect = {
      group,
      flames,
      light,
      origin: origin.clone().add(new THREE.Vector3(0, 1.5, 0)),
      spread: { x: halfW * 0.5, z: halfD * 0.5, rotation },
      smokeDebt: 0,
      waterDebt: 0,
      seed: incident.id,
    };
    this.fires.set(incident.id, fire);
    return fire;
  }

  private animateFire(fire: FireEffect, intensity: number, time: number): void {
    for (const flame of fire.flames) {
      const { base, phase } = flame.userData as { base: number; phase: number };
      const flicker = 0.75 + 0.25 * Math.sin(time * 11 + phase) + 0.12 * Math.sin(time * 23 + phase * 2);
      const h = base * intensity * flicker;
      const w = (0.9 + 0.25 * Math.sin(time * 7 + phase)) * Math.max(0.25, intensity);
      flame.scale.set(w, Math.max(0.01, h), w);
      flame.visible = intensity > 0.02;
    }
    fire.light.intensity = 220 * intensity * (0.85 + 0.15 * Math.sin(time * 17 + fire.seed));
  }

  private emitSmoke(fire: FireEffect, intensity: number): void {
    const p = this.smokeParticles.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    p.age = 0;
    p.life = SMOKE_LIFE * (0.7 + Math.random() * 0.6);
    const local = new THREE.Vector3((Math.random() * 2 - 1) * fire.spread.x, 0, (Math.random() * 2 - 1) * fire.spread.z);
    local.applyAxisAngle(new THREE.Vector3(0, 1, 0), fire.spread.rotation);
    p.start.copy(fire.origin).add(local);
    p.velocity.set((Math.random() - 0.5) * 0.8, 2.6 + intensity * 1.5, (Math.random() - 0.5) * 0.8).add(WIND);
  }

  private emitWater(from: THREE.Vector3, to: THREE.Vector3): void {
    const p = this.waterParticles.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    p.age = 0;
    p.life = WATER_FLIGHT;
    p.start.copy(from);
    p.end.copy(to).add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 1.5, (Math.random() - 0.5) * 3));
  }

  private updateSmoke(dt: number): void {
    let n = 0;
    const color = new THREE.Color();
    for (const p of this.smokeParticles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      const t = p.age / p.life;
      this.tmp.copy(p.start).addScaledVector(p.velocity, p.age);
      const size = (1 + t * 4) * (t > 0.8 ? (1 - t) / 0.2 : 1);
      this.matrix.makeScale(size, size, size).setPosition(this.tmp);
      this.smoke.setMatrixAt(n, this.matrix);
      this.smoke.setColorAt(n, color.setScalar(0.18 + t * 0.45));
      n++;
    }
    this.smoke.count = n;
    this.smoke.instanceMatrix.needsUpdate = true;
    if (this.smoke.instanceColor) this.smoke.instanceColor.needsUpdate = true;
  }

  private updateWater(dt: number): void {
    let n = 0;
    for (const p of this.waterParticles) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      const t = p.age / p.life;
      this.tmp.lerpVectors(p.start, p.end, t);
      this.tmp.y += 5 * t * (1 - t) * 4 * 0.5;
      this.matrix.makeTranslation(this.tmp.x, this.tmp.y, this.tmp.z);
      this.water.setMatrixAt(n, this.matrix);
      n++;
    }
    this.water.count = n;
    this.water.instanceMatrix.needsUpdate = true;
  }
}

/** 0..1: grows after the call, shrinks while being extinguished. */
function fireIntensity(incident: Incident, time: number): number {
  const growth = Math.min(1, 0.35 + (time - incident.reportedAt) / GROW_TIME);
  if (incident.status !== 'on_scene') return growth;
  const progress = incident.workDone / incident.duration;
  return growth * Math.max(0.05, 1 - progress * 0.95);
}

/** Round badge with a shield and exclamation mark. */
function createCrimeTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(64, 64, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2f55c8';
  ctx.beginPath();
  ctx.arc(64, 64, 55, 0, Math.PI * 2);
  ctx.fill();
  // Shield.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(64, 26);
  ctx.lineTo(94, 37);
  ctx.lineTo(94, 62);
  ctx.quadraticCurveTo(92, 88, 64, 102);
  ctx.quadraticCurveTo(36, 88, 34, 62);
  ctx.lineTo(34, 37);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#d93636';
  ctx.fillRect(59, 40, 10, 32);
  ctx.fillRect(59, 79, 10, 10);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function newParticle(): Particle {
  return {
    alive: false,
    age: 0,
    life: 1,
    start: new THREE.Vector3(),
    end: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
  };
}
