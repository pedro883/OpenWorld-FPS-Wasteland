import { Player as PlayerCfg } from '../core/config';
import { groups, Layer, WORLD_SOLID } from './layers';
import { RAPIER, type PhysicsWorld } from './world';

export type Stance = 'stand' | 'crouch' | 'prone';

export const STANCE_HEIGHT: Record<Stance, number> = {
  stand: PlayerCfg.capsule.standHeight,
  crouch: PlayerCfg.capsule.crouchHeight,
  prone: PlayerCfg.capsule.proneHeight,
};

export const STANCE_EYE: Record<Stance, number> = {
  stand: PlayerCfg.eyeOffset.stand,
  crouch: PlayerCfg.eyeOffset.crouch,
  prone: PlayerCfg.eyeOffset.prone,
};

export interface MoveResult {
  grounded: boolean;
  /** Movement actually applied after collision resolution, in metres. */
  moved: { x: number; y: number; z: number };
  /** True when the solver ate most of the requested motion (we hit a wall). */
  blocked: boolean;
}

/**
 * Kinematic capsule controller on top of Rapier's character controller.
 *
 * The body is kinematic so gameplay owns the motion; Rapier only resolves the
 * sweep. Positions here are *feet* positions — the capsule centre is derived —
 * because every gameplay rule (eye height, stance, ground snap) is about feet.
 */
export class CharacterController {
  private readonly controller: RAPIER.KinematicCharacterController;
  readonly body: RAPIER.RigidBody;
  collider: RAPIER.Collider;

  private stanceValue: Stance = 'stand';
  private readonly radius = PlayerCfg.capsule.radius;

  constructor(
    private readonly physics: PhysicsWorld,
    start: { x: number; y: number; z: number },
    private readonly membership: number = Layer.PLAYER,
  ) {
    this.controller = physics.world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle((PlayerCfg.maxSlopeDegrees * Math.PI) / 180);
    this.controller.setMinSlopeSlideAngle((PlayerCfg.maxSlopeDegrees * 0.75 * Math.PI) / 180);
    // Autostep is what lets the player mantle kerbs and low debris without a
    // dedicated vault move; the third argument allows stepping onto dynamics.
    this.controller.enableAutostep(PlayerCfg.autostepHeight, this.radius * 0.5, true);
    this.controller.enableSnapToGround(PlayerCfg.snapToGroundDistance);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);

    const height = STANCE_HEIGHT.stand;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        start.x,
        start.y + height / 2,
        start.z,
      ),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.capsule(this.halfHeightFor('stand'), this.radius).setCollisionGroups(
        groups(membership, 0xffff),
      ),
      this.body,
    );
  }

  private halfHeightFor(stance: Stance): number {
    return Math.max(0.01, STANCE_HEIGHT[stance] / 2 - this.radius);
  }

  get stance(): Stance {
    return this.stanceValue;
  }

  get height(): number {
    return STANCE_HEIGHT[this.stanceValue];
  }

  /** Feet position. */
  get position(): { x: number; y: number; z: number } {
    const t = this.body.translation();
    return { x: t.x, y: t.y - this.height / 2, z: t.z };
  }

  get eyePosition(): { x: number; y: number; z: number } {
    const p = this.position;
    return { x: p.x, y: p.y + STANCE_EYE[this.stanceValue], z: p.z };
  }

  setPosition(feet: { x: number; y: number; z: number }): void {
    this.body.setTranslation({ x: feet.x, y: feet.y + this.height / 2, z: feet.z }, true);
  }

  /**
   * Standing up needs headroom, so a taller stance is refused when something
   * is directly overhead. Returns the stance actually adopted.
   */
  trySetStance(next: Stance): Stance {
    if (next === this.stanceValue) return next;
    const growing = STANCE_HEIGHT[next] > STANCE_HEIGHT[this.stanceValue];
    if (growing && !this.hasHeadroom(STANCE_HEIGHT[next])) return this.stanceValue;

    const feet = this.position;
    const half = this.halfHeightFor(next);
    // setHalfHeight keeps the collider handle stable, which matters because the
    // physics world maps collider handles to gameplay owners.
    const capsule = this.collider as unknown as { setHalfHeight?: (h: number) => void };
    if (typeof capsule.setHalfHeight === 'function') {
      capsule.setHalfHeight(half);
    } else {
      this.physics.forget(this.collider);
      this.physics.world.removeCollider(this.collider, false);
      this.collider = this.physics.world.createCollider(
        RAPIER.ColliderDesc.capsule(half, this.radius).setCollisionGroups(
          groups(this.membership, 0xffff),
        ),
        this.body,
      );
    }
    this.stanceValue = next;
    this.setPosition(feet);
    return next;
  }

  private hasHeadroom(targetHeight: number): boolean {
    const feet = this.position;
    const from = { x: feet.x, y: feet.y + this.height - this.radius * 0.5, z: feet.z };
    const needed = targetHeight - this.height + this.radius;
    if (needed <= 0) return true;
    return (
      this.physics.raycast(from, { x: 0, y: 1, z: 0 }, needed, WORLD_SOLID, this.collider) === null
    );
  }

  /** Sweeps `delta` metres, resolving collisions, and moves the body there. */
  move(delta: { x: number; y: number; z: number }): MoveResult {
    this.controller.computeColliderMovement(this.collider, delta, undefined, undefined, (c) => {
      // Never collide with our own collider, and ignore triggers.
      return c.handle !== this.collider.handle && !c.isSensor();
    });
    const applied = this.controller.computedMovement();
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: t.x + applied.x,
      y: t.y + applied.y,
      z: t.z + applied.z,
    });

    const wanted = Math.hypot(delta.x, delta.z);
    const got = Math.hypot(applied.x, applied.z);
    return {
      grounded: this.controller.computedGrounded(),
      moved: { x: applied.x, y: applied.y, z: applied.z },
      blocked: wanted > 1e-4 && got < wanted * 0.35,
    };
  }

  dispose(): void {
    this.physics.forget(this.collider);
    this.physics.world.removeRigidBody(this.body);
    this.physics.world.removeCharacterController(this.controller);
  }
}
