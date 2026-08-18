import * as THREE from 'three';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { groups, Layer, SIGHT_BLOCKERS } from '../physics/layers';
import { isBodyOwner } from './types';
import type { ExplosionDef } from './arsenal';
import type { ExplosionEvent } from './ballistics';
import type { Zone } from '../entities/health';

interface Blast {
  mesh: THREE.Mesh;
  light: THREE.PointLight;
  age: number;
  life: number;
  radius: number;
}

/**
 * Area damage plus the visual. Damage falls off with distance and is cut by
 * anything solid in between, so cover genuinely protects — an explosion that
 * ignores walls turns every rocket into a guaranteed kill through geometry.
 */
export class ExplosionSystem {
  private readonly blasts: Blast[] = [];
  private readonly geometry = new THREE.SphereGeometry(1, 16, 12);

  onDamage:
    | ((entity: unknown, zone: Zone, amount: number, point: THREE.Vector3) => void)
    | null = null;
  /** Fired so AI can react to the noise even when unharmed. */
  onBlast: ((point: THREE.Vector3, radius: number) => void) | null = null;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
  ) {}

  readonly handle = (event: ExplosionEvent): void => {
    this.detonate(event.point, event.def, event.shooter);
  };

  detonate(point: THREE.Vector3, def: ExplosionDef, _shooter: unknown): void {
    this.spawnVisual(point, def.radiusMeters);
    this.onBlast?.(point.clone(), def.radiusMeters * 3);

    // One hitbox per zone means a body inside the radius reports several
    // colliders; damage the closest zone of each entity exactly once.
    const worst = new Map<
      unknown,
      { zone: Zone; distance: number; point: THREE.Vector3 }
    >();

    const shape = new RAPIER.Ball(def.radiusMeters);
    this.physics.world.intersectionsWithShape(
      point,
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      (collider) => {
        const owner = this.physics.ownerOf(collider);
        if (!isBodyOwner(owner)) return true;
        const t = collider.translation();
        const at = new THREE.Vector3(t.x, t.y, t.z);
        const distance = at.distanceTo(point);
        const current = worst.get(owner.entity);
        if (!current || distance < current.distance) {
          worst.set(owner.entity, { zone: owner.zone, distance, point: at });
        }
        return true;
      },
      undefined,
      groups(0xffff, Layer.HITBOX),
    );

    for (const [entity, hit] of worst) {
      const normalised = Math.min(1, hit.distance / def.radiusMeters);
      let amount = def.damage * Math.pow(1 - normalised, def.falloffPower);
      if (amount <= 0.5) continue;

      // Cover check from the blast centre to the body.
      if (!this.physics.hasLineOfSight(point, hit.point, SIGHT_BLOCKERS)) {
        amount *= 0.25;
      }

      const target = entity as {
        health: { applyDamage(zone: Zone, amount: number): { applied: number } };
        onDamaged(zone: Zone, amount: number, dir: THREE.Vector3): void;
      };
      const direction = hit.point.clone().sub(point).normalize();
      const result = target.health.applyDamage(hit.zone, amount);
      target.onDamaged(hit.zone, result.applied, direction);
      this.onDamage?.(entity, hit.zone, result.applied, hit.point);
    }
  }

  private spawnVisual(point: THREE.Vector3, radius: number): void {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffb257,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.copy(point);
    mesh.scale.setScalar(radius * 0.25);
    this.scene.add(mesh);

    const light = new THREE.PointLight(0xffa257, 0, radius * 3, 2);
    light.position.copy(point);
    this.scene.add(light);

    this.blasts.push({ mesh, light, age: 0, life: 0.45, radius });
  }

  update(dt: number): void {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const blast = this.blasts[i]!;
      blast.age += dt;
      const k = blast.age / blast.life;
      if (k >= 1) {
        this.scene.remove(blast.mesh);
        this.scene.remove(blast.light);
        (blast.mesh.material as THREE.Material).dispose();
        blast.light.dispose();
        this.blasts.splice(i, 1);
        continue;
      }
      // Fast expansion, slower fade — reads as a blast rather than a balloon.
      blast.mesh.scale.setScalar(blast.radius * (0.25 + 0.9 * Math.sqrt(k)));
      (blast.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k) ** 1.5;
      blast.light.intensity = 40 * (1 - k) ** 2;
    }
  }

  dispose(): void {
    for (const blast of this.blasts) {
      this.scene.remove(blast.mesh);
      this.scene.remove(blast.light);
      (blast.mesh.material as THREE.Material).dispose();
      blast.light.dispose();
    }
    this.blasts.length = 0;
    this.geometry.dispose();
  }
}
