import * as THREE from 'three';
import cfg from '../../config/ballistics.json';
import { Pool } from '../core/pool';
import { BULLET_FILTER } from '../physics/layers';
import type { RAPIER } from '../physics/world';
import type { PhysicsWorld, RayHit } from '../physics/world';
import { isBodyOwner, materialDef, ownerMaterial } from './types';
import type { ExplosionDef, ProjectileKind } from './arsenal';

export interface ShotSpec {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  muzzleVelocity: number;
  damage: number;
  /** Piecewise-linear [metres, multiplier] curve. */
  falloff: Array<[number, number]>;
  /** Concrete-equivalent metres the round can chew through. */
  penetration: number;
  shooter: unknown;
  tracer: boolean;
  /** The shooter's own collider, so a muzzle inside the body cannot self-hit. */
  ignore?: RAPIER.Collider;
  /** Detonation payload; rockets explode on contact, thrown ones on fuse. */
  explosion?: ExplosionDef | null;
  kind?: ProjectileKind;
  /** Seconds until a thrown projectile detonates regardless of contact. */
  fuseSeconds?: number;
  /** Model id to render in flight (rockets and grenades are visible). */
  model?: string | null;
  /** Non-lethal payload: smoke, flash and burn come from the weapon def. */
  special?: SpecialPayload | null;
}

export interface SpecialPayload {
  smoke?: { radiusMeters: number; seconds: number; blocksVisionFactor: number } | null;
  flash?: { radiusMeters: number; blindSeconds: number; deafSeconds: number } | null;
  burn?: { damagePerSecond: number; seconds: number } | null;
}

export interface ImpactEvent {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  material: string;
  /** True when the round went through rather than stopping. */
  penetrated: boolean;
  ricocheted: boolean;
}

export interface ExplosionEvent {
  point: THREE.Vector3;
  def: ExplosionDef;
  shooter: unknown;
}

export interface SpecialEvent {
  point: THREE.Vector3;
  payload: SpecialPayload;
  shooter: unknown;
}

export interface DamageEvent {
  entity: unknown;
  zone: string;
  amount: number;
  distance: number;
  point: THREE.Vector3;
  direction: THREE.Vector3;
  shooter: unknown;
  /** Carried so a flamethrower hit can set the target alight. */
  special: SpecialPayload | null;
}

interface Projectile {
  active: boolean;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  vel: THREE.Vector3;
  damage: number;
  falloff: Array<[number, number]>;
  penetration: number;
  travelled: number;
  age: number;
  bounces: number;
  shooter: unknown;
  tracer: boolean;
  ignore: RAPIER.Collider | undefined;
  explosion: ExplosionDef | null;
  kind: ProjectileKind;
  fuse: number;
  model: string | null;
  special: SpecialPayload | null;
}

/** Linear interpolation over the weapon's [distance, multiplier] table. */
export function falloffAt(curve: Array<[number, number]>, distance: number): number {
  if (!curve.length) return 1;
  const first = curve[0]!;
  if (distance <= first[0]) return first[1];
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (distance <= b[0]) {
      const t = (distance - a[0]) / Math.max(b[0] - a[0], 1e-6);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return curve[curve.length - 1]![1];
}

/**
 * Physical projectiles, not hitscan.
 *
 * Each round carries finite speed, gravity and quadratic drag, and every fixed
 * step is swept as a segment against the world — a bullet that moves 15 m per
 * tick must not skip a 10 cm wall. Penetration spends an energy budget against
 * the real thickness of what was hit (found with an exit ray), and shallow
 * angles against hard materials ricochet.
 */
export class BallisticsSystem {
  private readonly pool: Pool<Projectile>;
  private readonly gravity: number;

  onImpact: ((e: ImpactEvent) => void) | null = null;
  onDamage: ((e: DamageEvent) => void) | null = null;
  /** Called with the segment of every round, for AI suppression. */
  onPass: ((from: THREE.Vector3, to: THREE.Vector3, shooter: unknown) => void) | null = null;
  onExplosion: ((e: ExplosionEvent) => void) | null = null;
  onSpecial: ((e: SpecialEvent) => void) | null = null;

  constructor(
    private readonly physics: PhysicsWorld,
    gravity: number,
  ) {
    this.gravity = gravity * cfg.gravityScale;
    this.pool = new Pool<Projectile>(
      () => ({
        active: false,
        pos: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        damage: 0,
        falloff: [],
        penetration: 0,
        travelled: 0,
        age: 0,
        bounces: 0,
        shooter: null,
        tracer: false,
        ignore: undefined,
        explosion: null,
        kind: 'bullet' as ProjectileKind,
        fuse: 0,
        model: null,
        special: null,
      }),
      (p) => {
        p.active = false;
        p.shooter = null;
        p.ignore = undefined;
        p.explosion = null;
        p.model = null;
        p.special = null;
        p.falloff = [];
      },
      cfg.maxProjectiles,
    );
  }

  get activeCount(): number {
    return this.pool.activeCount;
  }

  fire(spec: ShotSpec): boolean {
    const slot = this.pool.acquire();
    if (!slot) return false;
    const p = slot.item;
    p.active = true;
    p.pos.copy(spec.origin);
    p.prev.copy(spec.origin);
    p.vel.copy(spec.direction).normalize().multiplyScalar(spec.muzzleVelocity);
    p.damage = spec.damage;
    p.falloff = spec.falloff;
    p.penetration = spec.penetration;
    p.travelled = 0;
    p.age = 0;
    p.bounces = 0;
    p.shooter = spec.shooter;
    p.tracer = spec.tracer;
    p.ignore = spec.ignore;
    p.explosion = spec.explosion ?? null;
    p.kind = spec.kind ?? 'bullet';
    p.fuse = spec.fuseSeconds ?? 0;
    p.model = spec.model ?? null;
    p.special = spec.special ?? null;
    return true;
  }

  update(dt: number): void {
    for (const handle of [...this.pool.active()]) {
      const p = this.pool.get(handle);
      if (!p || !p.active) continue;
      if (!this.step(p, dt)) this.pool.release(handle);
    }
  }

  /** Returns false when the round is spent. */
  private step(p: Projectile, dt: number): boolean {
    p.age += dt;
    // A thrown charge detonates on its fuse wherever it happens to be.
    if (p.fuse > 0 && p.age >= p.fuse) {
      this.detonate(p, p.pos);
      return false;
    }
    if (p.age > cfg.maxFlightSeconds) {
      if (p.kind === 'thrown') this.detonate(p, p.pos);
      return false;
    }

    // Quadratic drag: a = -k |v| v. At rifle speeds this is the dominant loss,
    // and it is what makes time-of-flight grow non-linearly with range.
    const speed = p.vel.length();
    const dragAccel = cfg.airDrag * speed * speed;
    p.vel.addScaledVector(p.vel, (-dragAccel / Math.max(speed, 1e-6)) * dt);
    p.vel.y += this.gravity * dt;

    p.prev.copy(p.pos);
    const stepLength = p.vel.length() * dt;
    if (stepLength < 1e-6) return false;

    const dir = p.vel.clone().divideScalar(p.vel.length());
    let remaining = stepLength;
    let from = p.prev.clone();
    let guard = 0;

    // A single tick can cross several thin surfaces; loop until the step is
    // consumed rather than resolving only the first hit.
    while (remaining > 1e-5 && guard++ < 6) {
      const hit = this.physics.raycast(from, dir, remaining, BULLET_FILTER, p.ignore);
      if (!hit) {
        p.pos.copy(from).addScaledVector(dir, remaining);
        p.travelled += remaining;
        this.onPass?.(p.prev, p.pos, p.shooter);
        return true;
      }

      p.travelled += hit.distance;
      const outcome = this.resolveHit(p, hit, dir, from);
      if (outcome.stop) {
        p.pos.copy(hit.point);
        this.onPass?.(p.prev, p.pos, p.shooter);
        return false;
      }

      remaining -= hit.distance + outcome.advance;
      from = outcome.continueFrom;
      if (outcome.newDirection) {
        dir.copy(outcome.newDirection);
        p.vel.copy(dir).multiplyScalar(p.vel.length() * (1 - cfg.ricochet.energyLoss));
      }
    }

    p.pos.copy(from);
    this.onPass?.(p.prev, p.pos, p.shooter);
    return true;
  }

  private resolveHit(
    p: Projectile,
    hit: RayHit,
    dir: THREE.Vector3,
    _from: THREE.Vector3,
  ): {
    stop: boolean;
    advance: number;
    continueFrom: THREE.Vector3;
    newDirection?: THREE.Vector3;
  } {
    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    const owner = hit.userData;
    const materialName = ownerMaterial(owner);
    const material = materialDef(materialName);
    const damage = p.damage * falloffAt(p.falloff, p.travelled);

    if (p.kind === 'rocket' && (p.explosion || p.special)) {
      this.detonate(p, point);
      return { stop: true, advance: 0, continueFrom: point };
    }

    if (p.kind === 'thrown') {
      // Grenades bounce and keep their fuse; they never stop on contact.
      const bounced = dir.clone().reflect(normal).normalize();
      p.vel.copy(bounced).multiplyScalar(p.vel.length() * 0.42);
      this.onImpact?.({ point, normal, material: materialName, penetrated: false, ricocheted: true });
      return {
        stop: false,
        advance: 0.03,
        continueFrom: point.clone().addScaledVector(bounced, 0.03),
        newDirection: bounced,
      };
    }

    if (isBodyOwner(owner)) {
      const result = owner.entity.health.applyDamage(owner.zone, damage);
      owner.entity.onDamaged(owner.zone, result.applied, dir);
      this.onDamage?.({
        entity: owner.entity,
        zone: owner.zone,
        amount: result.applied,
        distance: p.travelled,
        point,
        direction: dir.clone(),
        shooter: p.shooter,
        special: p.special,
      });
      this.onImpact?.({ point, normal, material: 'flesh', penetrated: false, ricocheted: false });
      // Rounds stop in the body unless they had a lot of budget left.
      if (p.penetration < 0.6) {
        return { stop: true, advance: 0, continueFrom: point };
      }
      p.penetration -= 0.6;
      p.damage *= material.exitDamageFactor;
      return { stop: false, advance: 0.02, continueFrom: point.clone().addScaledVector(dir, 0.02) };
    }

    // Grazing angle measured against the *surface*, not the normal.
    const cosIncidence = Math.abs(dir.dot(normal));
    const grazeDegrees = Math.asin(Math.min(1, cosIncidence)) * (180 / Math.PI);
    if (
      material.ricochetAngle > 0 &&
      grazeDegrees <= material.ricochetAngle &&
      p.bounces < cfg.ricochet.maxBounces
    ) {
      p.bounces++;
      const reflected = dir.clone().reflect(normal).normalize();
      // Scatter, so ricochets are not perfectly predictable mirrors.
      const spread = (cfg.ricochet.spreadDegrees * Math.PI) / 180;
      reflected.applyAxisAngle(
        new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        (Math.random() - 0.5) * spread,
      );
      this.onImpact?.({ point, normal, material: materialName, penetrated: false, ricocheted: true });
      return {
        stop: false,
        advance: 0.02,
        continueFrom: point.clone().addScaledVector(reflected, 0.02),
        newDirection: reflected,
      };
    }

    const thickness = this.thicknessThrough(hit, point, dir);
    const cost = thickness * material.hardness;
    if (cost > p.penetration) {
      this.onImpact?.({ point, normal, material: materialName, penetrated: false, ricocheted: false });
      return { stop: true, advance: 0, continueFrom: point };
    }

    p.penetration -= cost;
    p.damage *= material.exitDamageFactor;
    this.onImpact?.({ point, normal, material: materialName, penetrated: true, ricocheted: false });
    const exit = point.clone().addScaledVector(dir, thickness + 0.01);
    return { stop: false, advance: thickness + 0.01, continueFrom: exit };
  }

  /**
   * Distance from entry to exit through the collider that was hit. Cast from
   * just inside with `solid = false`, which reports where the ray leaves the
   * shape rather than immediately returning zero.
   */
  private thicknessThrough(hit: RayHit, point: THREE.Vector3, dir: THREE.Vector3): number {
    const MAX = 2.0;
    const inside = point.clone().addScaledVector(dir, 0.005);
    const exit = this.physics.raycastCollider(hit.collider, inside, dir, MAX);
    return exit === null ? MAX : Math.min(MAX, exit + 0.005);
  }

  /** Emits the explosion event; the explosion system applies area damage. */
  private detonate(p: Projectile, at: THREE.Vector3): void {
    if (p.explosion) {
      this.onExplosion?.({ point: at.clone(), def: p.explosion, shooter: p.shooter });
    }
    // Smoke and flash detonate through the same path as high explosive.
    if (p.special && (p.special.smoke || p.special.flash)) {
      this.onSpecial?.({ point: at.clone(), payload: p.special, shooter: p.shooter });
    }
  }

  /**
   * Immediate raycast strike for melee. Shares the collider-owner resolution
   * with projectiles, so a knife hits the same damage zones a bullet does.
   */
  instantHit(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    range: number,
    damage: number,
    shooter: unknown,
    ignore?: RAPIER.Collider,
  ): boolean {
    const hit = this.physics.raycast(origin, direction, range, BULLET_FILTER, ignore);
    if (!hit) return false;
    const point = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
    const normal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    const owner = hit.userData;
    if (isBodyOwner(owner)) {
      const result = owner.entity.health.applyDamage(owner.zone, damage);
      owner.entity.onDamaged(owner.zone, result.applied, direction);
      this.onDamage?.({
        entity: owner.entity,
        zone: owner.zone,
        amount: result.applied,
        distance: hit.distance,
        point,
        direction: direction.clone(),
        shooter,
        special: null,
      });
    }
    this.onImpact?.({
      point,
      normal,
      material: ownerMaterial(owner),
      penetrated: false,
      ricocheted: false,
    });
    return true;
  }

  clear(): void {
    this.pool.releaseAll();
  }

  /** Snapshot for the debug overlay and for the tracer renderer. */
  forEachActive(fn: (pos: THREE.Vector3, prev: THREE.Vector3, tracer: boolean) => void): void {
    for (const handle of this.pool.active()) {
      const p = this.pool.get(handle);
      if (p?.active) fn(p.pos, p.prev, p.tracer);
    }
  }
}
