import * as THREE from 'three';
import { groups, Layer } from '../physics/layers';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { Zone } from './health';
import type { Damageable } from '../combat/types';

/**
 * Hitbox layout for a 1.8 m humanoid on the Mini Characters rig.
 * Half-extents in metres; `y` is the centre height above the feet.
 */
export const HUMANOID_ZONES: Array<{
  zone: Zone;
  half: [number, number, number];
  y: number;
  x: number;
}> = [
  { zone: 'head', half: [0.11, 0.12, 0.11], y: 1.64, x: 0 },
  { zone: 'torso', half: [0.19, 0.29, 0.12], y: 1.14, x: 0 },
  { zone: 'armLeft', half: [0.07, 0.26, 0.08], y: 1.16, x: -0.27 },
  { zone: 'armRight', half: [0.07, 0.26, 0.08], y: 1.16, x: 0.27 },
  { zone: 'legLeft', half: [0.08, 0.42, 0.09], y: 0.43, x: -0.1 },
  { zone: 'legRight', half: [0.08, 0.42, 0.09], y: 0.43, x: 0.1 },
];

const STAND_HEIGHT = 1.8;

/**
 * The six damage zones of one humanoid, as sensor colliders on the HITBOX
 * layer. Sensors so they never push anything around, and on their own layer so
 * bullets resolve against them instead of the coarse movement capsule.
 *
 * Attaching them to an existing rigid body (the player's) keeps them in sync
 * for free; a standalone body is used for NPCs that are moved directly.
 */
export class HitboxSet {
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly ownBody: RAPIER.RigidBody | null = null;
  private readonly baseOffsets: Array<{ x: number; y: number }> = [];

  constructor(
    private readonly physics: PhysicsWorld,
    owner: Damageable,
    options: { attachTo?: RAPIER.RigidBody; position?: THREE.Vector3; material?: string } = {},
  ) {
    let body = options.attachTo ?? null;
    if (!body) {
      const p = options.position ?? new THREE.Vector3();
      body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z),
      );
      this.ownBody = body;
    }

    for (const box of HUMANOID_ZONES) {
      const desc = RAPIER.ColliderDesc.cuboid(box.half[0], box.half[1], box.half[2])
        .setSensor(true)
        .setTranslation(box.x, box.y, 0)
        .setCollisionGroups(groups(Layer.HITBOX, Layer.HITBOX));
      const collider = physics.world.createCollider(desc, body);
      physics.own(collider, {
        kind: 'body',
        entity: owner,
        zone: box.zone,
        material: options.material ?? 'flesh',
      });
      this.colliders.push(collider);
      this.baseOffsets.push({ x: box.x, y: box.y });
    }
  }

  /** Moves the standalone body (NPC case). No-op when attached to another. */
  setPosition(position: THREE.Vector3, yaw = 0): void {
    if (!this.ownBody) return;
    this.ownBody.setNextKinematicTranslation(position);
    const half = yaw / 2;
    this.ownBody.setNextKinematicRotation({
      x: 0,
      y: Math.sin(half),
      z: 0,
      w: Math.cos(half),
    });
  }

  /**
   * Squashes the zones towards the ground as the body crouches or goes prone,
   * so a prone target really is a smaller target.
   */
  setStanceHeight(height: number): void {
    const scale = height / STAND_HEIGHT;
    for (let i = 0; i < this.colliders.length; i++) {
      const base = this.baseOffsets[i]!;
      this.colliders[i]!.setTranslationWrtParent({
        x: base.x,
        y: base.y * scale,
        z: 0,
      });
    }
  }

  has(collider: RAPIER.Collider): boolean {
    return this.colliders.some((c) => c.handle === collider.handle);
  }

  get first(): RAPIER.Collider | undefined {
    return this.colliders[0];
  }

  dispose(): void {
    for (const collider of this.colliders) {
      this.physics.forget(collider);
      this.physics.world.removeCollider(collider, false);
    }
    this.colliders.length = 0;
    if (this.ownBody) this.physics.world.removeRigidBody(this.ownBody);
  }
}
