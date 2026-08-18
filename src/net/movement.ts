import type { InputCommand } from './protocol.ts';

/**
 * The movement model both sides run.
 *
 * The single-player controller is a Rapier kinematic capsule, which the server
 * cannot reproduce without shipping a physics world and the whole map. This
 * model is the networked one instead, and it is deliberately the *same code* on
 * client and server: prediction that does not match authority produces a player
 * who is constantly snapped back, and matching it approximately is worse than
 * matching it exactly with a simpler model.
 *
 * What it validates: speed, gravity, jumping and the ground. What it does not:
 * collision against buildings, which stay client-side. A player can therefore
 * walk through a wall in multiplayer — an honest limit of not running the full
 * physics server-side, written here rather than discovered later.
 */

export interface NetPlayerBody {
  x: number;
  y: number;
  z: number;
  vy: number;
  yaw: number;
  pitch: number;
  crouched: boolean;
  grounded: boolean;
}

export interface MovementTuning {
  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  jumpVelocity: number;
  gravity: number;
  eyeHeight: number;
  crouchEyeHeight: number;
}

export const NET_MOVEMENT: MovementTuning = {
  walkSpeed: 4.2,
  sprintSpeed: 6.6,
  crouchSpeed: 2.1,
  jumpVelocity: 5.2,
  gravity: -19.6,
  eyeHeight: 1.65,
  crouchEyeHeight: 1.05,
};

/** Ground height at a point; the terrain is a pure function of the seed. */
export type GroundSampler = (x: number, z: number) => number;

export function createBody(x: number, y: number, z: number): NetPlayerBody {
  return { x, y, z, vy: 0, yaw: 0, pitch: 0, crouched: false, grounded: true };
}

/**
 * Advances one command. Pure: same body plus same command gives the same
 * result, which is what lets the client replay its unacknowledged inputs after
 * a correction and land exactly where the server will.
 */
export function stepMovement(
  body: NetPlayerBody,
  cmd: InputCommand,
  ground: GroundSampler,
  tuning: MovementTuning = NET_MOVEMENT,
): void {
  const dt = Math.max(0, Math.min(0.05, cmd.dt));
  if (dt === 0) return;

  body.yaw = cmd.yaw;
  body.pitch = cmd.pitch;
  body.crouched = cmd.crouch;

  const speed = cmd.crouch
    ? tuning.crouchSpeed
    : cmd.sprint && cmd.forward > 0
      ? tuning.sprintSpeed
      : tuning.walkSpeed;

  // Normalising the intent stops diagonal movement being faster than straight.
  const length = Math.hypot(cmd.forward, cmd.strafe);
  const scale = length > 1 ? 1 / length : 1;
  const forward = cmd.forward * scale;
  const strafe = cmd.strafe * scale;

  const sin = Math.sin(cmd.yaw);
  const cos = Math.cos(cmd.yaw);
  // Forward is -Z rotated by yaw, matching the single-player camera.
  body.x += (-sin * forward + cos * strafe) * speed * dt;
  body.z += (-cos * forward - sin * strafe) * speed * dt;

  if (cmd.jump && body.grounded) {
    body.vy = tuning.jumpVelocity;
    body.grounded = false;
  }

  body.vy += tuning.gravity * dt;
  body.y += body.vy * dt;

  const floor = ground(body.x, body.z);
  if (body.y <= floor) {
    body.y = floor;
    body.vy = 0;
    body.grounded = true;
  } else {
    body.grounded = false;
  }
}

export function eyeHeightOf(body: NetPlayerBody, tuning: MovementTuning = NET_MOVEMENT): number {
  return body.crouched ? tuning.crouchEyeHeight : tuning.eyeHeight;
}

/**
 * How far apart two bodies are.
 *
 * Reconciliation uses this to decide whether a correction is worth applying:
 * snapping the camera for a millimetre of floating-point drift is far more
 * visible than the drift itself.
 */
export function positionError(a: NetPlayerBody, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
