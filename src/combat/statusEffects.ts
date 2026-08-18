import * as THREE from 'three';
import type { ZoneHealth } from '../entities/health';

export interface SmokeCloud {
  position: THREE.Vector3;
  radius: number;
  remaining: number;
  total: number;
  blocksVisionFactor: number;
  mesh: THREE.Mesh;
}

interface Burn {
  health: ZoneHealth;
  damagePerSecond: number;
  remaining: number;
}

interface FlashState {
  blind: number;
  deaf: number;
}

/**
 * Smoke, flash and burn — the non-lethal half of the arsenal.
 *
 * Smoke is queried by AI perception, not just drawn: a cloud that looks opaque
 * but that enemies see straight through is worse than no cloud at all, because
 * it teaches the player a rule the game does not honour.
 */
export class StatusEffects {
  private readonly clouds: SmokeCloud[] = [];
  private readonly burns = new Map<ZoneHealth, Burn>();
  private readonly flashed = new Map<unknown, FlashState>();
  private readonly geometry = new THREE.SphereGeometry(1, 14, 10);

  constructor(private readonly scene: THREE.Scene) {}

  // ---- Smoke ------------------------------------------------------------

  spawnSmoke(
    position: THREE.Vector3,
    radius: number,
    seconds: number,
    blocksVisionFactor: number,
  ): void {
    const material = new THREE.MeshBasicMaterial({
      color: 0xb9bcc0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(radius * 0.3);
    this.scene.add(mesh);
    this.clouds.push({
      position: position.clone(),
      radius,
      remaining: seconds,
      total: seconds,
      blocksVisionFactor,
      mesh,
    });
  }

  /**
   * How much of a sight line survives the smoke, 0..1. Tests the segment
   * against each cloud sphere rather than only the endpoints, because the
   * interesting case is a cloud sitting *between* two people.
   */
  visionThrough(from: THREE.Vector3, to: THREE.Vector3): number {
    if (!this.clouds.length) return 1;
    const segment = to.clone().sub(from);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 1e-6) return 1;

    let factor = 1;
    const relative = new THREE.Vector3();
    for (const cloud of this.clouds) {
      relative.copy(cloud.position).sub(from);
      const t = Math.max(0, Math.min(1, relative.dot(segment) / lengthSq));
      const closest = segment.clone().multiplyScalar(t).sub(relative);
      const distance = closest.length();
      if (distance >= cloud.radius) continue;
      // Denser towards the middle of the cloud, and fading as it disperses.
      const depth = 1 - distance / cloud.radius;
      const life = Math.min(1, cloud.remaining / (cloud.total * 0.25));
      factor *= 1 - cloud.blocksVisionFactor * depth * life;
    }
    return Math.max(0, factor);
  }

  // ---- Flash ------------------------------------------------------------

  /** Applies blindness scaled by distance and by whether the target was looking. */
  applyFlash(
    entity: unknown,
    entityEye: THREE.Vector3,
    entityForward: THREE.Vector3,
    blastPoint: THREE.Vector3,
    radius: number,
    blindSeconds: number,
    deafSeconds: number,
    hasLineOfSight: boolean,
  ): void {
    const toBlast = blastPoint.clone().sub(entityEye);
    const distance = toBlast.length();
    if (distance > radius) return;

    const proximity = 1 - distance / radius;
    // Facing away, or with something in between, saves most of your sight.
    const facing = Math.max(0, entityForward.dot(toBlast.normalize()));
    const exposure = hasLineOfSight ? 0.35 + 0.65 * facing : 0.12;

    const state = this.flashed.get(entity) ?? { blind: 0, deaf: 0 };
    state.blind = Math.max(state.blind, blindSeconds * proximity * exposure);
    state.deaf = Math.max(state.deaf, deafSeconds * proximity * exposure);
    this.flashed.set(entity, state);
  }

  /** 0..1 blindness for an entity, for the HUD or for AI accuracy. */
  blindnessOf(entity: unknown): number {
    const state = this.flashed.get(entity);
    if (!state) return 0;
    return Math.min(1, state.blind / 2);
  }

  deafnessOf(entity: unknown): number {
    const state = this.flashed.get(entity);
    if (!state) return 0;
    return Math.min(1, state.deaf / 3);
  }

  // ---- Burn -------------------------------------------------------------

  applyBurn(health: ZoneHealth, damagePerSecond: number, seconds: number): void {
    const existing = this.burns.get(health);
    if (existing) {
      // Re-igniting refreshes the timer rather than stacking ticks.
      existing.remaining = Math.max(existing.remaining, seconds);
      existing.damagePerSecond = Math.max(existing.damagePerSecond, damagePerSecond);
      return;
    }
    this.burns.set(health, { health, damagePerSecond, remaining: seconds });
  }

  isBurning(health: ZoneHealth): boolean {
    return this.burns.has(health);
  }

  // ---- Tick -------------------------------------------------------------

  update(dt: number): void {
    for (let i = this.clouds.length - 1; i >= 0; i--) {
      const cloud = this.clouds[i]!;
      cloud.remaining -= dt;
      if (cloud.remaining <= 0) {
        this.scene.remove(cloud.mesh);
        (cloud.mesh.material as THREE.Material).dispose();
        this.clouds.splice(i, 1);
        continue;
      }
      const age = 1 - cloud.remaining / cloud.total;
      // Billows out fast, then thins for the rest of its life.
      const grow = Math.min(1, age * 6);
      cloud.mesh.scale.setScalar(cloud.radius * (0.3 + 0.7 * grow));
      const fade = Math.min(1, cloud.remaining / (cloud.total * 0.3));
      (cloud.mesh.material as THREE.MeshBasicMaterial).opacity = 0.72 * grow * fade;
    }

    for (const [key, burn] of this.burns) {
      burn.remaining -= dt;
      burn.health.applyDamage('torso', burn.damagePerSecond * dt);
      if (burn.remaining <= 0 || !burn.health.alive) this.burns.delete(key);
    }

    for (const [key, state] of this.flashed) {
      state.blind = Math.max(0, state.blind - dt);
      state.deaf = Math.max(0, state.deaf - dt);
      if (state.blind <= 0 && state.deaf <= 0) this.flashed.delete(key);
    }
  }

  get activeSmoke(): readonly SmokeCloud[] {
    return this.clouds;
  }

  get debugText(): string {
    return `fumaça ${this.clouds.length} · queimando ${this.burns.size} · ofuscados ${this.flashed.size}`;
  }

  dispose(): void {
    for (const cloud of this.clouds) {
      this.scene.remove(cloud.mesh);
      (cloud.mesh.material as THREE.Material).dispose();
    }
    this.clouds.length = 0;
    this.burns.clear();
    this.flashed.clear();
    this.geometry.dispose();
  }
}
