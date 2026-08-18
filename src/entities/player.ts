import * as THREE from 'three';
import { Player as Cfg, World as WorldCfg } from '../core/config';
import { input, MOUSE_RIGHT } from '../core/input';
import { CharacterController, STANCE_EYE, type Stance } from '../physics/characterController';
import type { PhysicsWorld } from '../physics/world';
import { ZoneHealth, type Zone } from './health';
import { HitboxSet } from './hitboxes';
import type { Damageable } from '../combat/types';

const UP = new THREE.Vector3(0, 1, 0);
const stamCfg = Cfg.stamina;

export interface PlayerInput {
  forward: number;
  strafe: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  prone: boolean;
  ads: boolean;
}

/** Reads the keyboard into an intent struct so bots can drive the same code. */
export function readPlayerInput(): PlayerInput {
  const pad = input.padMove;
  // Keyboard and stick are summed, then clamped: whichever the player reaches
  // for works, and holding both does not double the speed.
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  return {
    forward: clamp(Number(input.actionDown('forward')) - Number(input.actionDown('back')) + pad.forward),
    strafe: clamp(Number(input.actionDown('right')) - Number(input.actionDown('left')) + pad.strafe),
    sprint: input.actionDown('sprint'),
    jump: input.actionPressed('jump'),
    crouch: input.actionPressed('crouch'),
    prone: input.actionPressed('prone'),
    ads: input.isMouseDown(MOUSE_RIGHT) || input.padAds,
  };
}

export class Player implements Damageable {
  readonly controller: CharacterController;
  readonly health = new ZoneHealth();
  readonly hitboxes: HitboxSet;
  /** Direction of the most recent hit, for the directional damage indicator. */
  lastHitDirection: THREE.Vector3 | null = null;

  yaw = 0;
  pitch = 0;
  stamina = stamCfg.max;
  ads = false;

  /** Horizontal velocity in m/s; vertical is tracked separately. */
  private readonly velocity = new THREE.Vector3();
  private verticalVelocity = 0;
  private grounded = false;
  private staminaIdle = 0;
  private exhausted = false;
  private jumpQueued = false;
  private stanceQueued: Stance | null = null;
  private bobPhase = 0;

  /** Feet position before and after the last fixed step, for interpolation. */
  private readonly prevFeet = new THREE.Vector3();
  private readonly currFeet = new THREE.Vector3();
  private prevEye = STANCE_EYE.stand;
  private currEye = STANCE_EYE.stand;

  private readonly swayTarget = new THREE.Vector2();
  private readonly sway = new THREE.Vector2();

  constructor(physics: PhysicsWorld, start: THREE.Vector3) {
    this.controller = new CharacterController(physics, start);
    physics.own(this.controller.collider, this);
    // Damage zones ride the same rigid body, so they follow for free.
    this.hitboxes = new HitboxSet(physics, this, { attachTo: this.controller.body });
    this.prevFeet.copy(start);
    this.currFeet.copy(start);
  }

  get isAlive(): boolean {
    return this.health.alive;
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.currFeet);
  }

  onDamaged(_zone: Zone, _amount: number, fromDirection: THREE.Vector3): void {
    this.lastHitDirection = fromDirection.clone();
  }

  get position(): THREE.Vector3 {
    return this.currFeet;
  }

  get stance(): Stance {
    return this.controller.stance;
  }

  get isGrounded(): boolean {
    return this.grounded;
  }

  get speed(): number {
    return this.velocity.length();
  }

  get isExhausted(): boolean {
    return this.exhausted;
  }

  /** Mouse look runs per frame, not per tick, so aiming never feels stepped. */
  applyLook(sensitivity = Cfg.camera.sensitivity, invertY = false): void {
    // The stick keeps working with the pointer unlocked; the mouse does not.
    const dx = (input.locked ? input.mouseDX : 0) + input.padLookX;
    const dy = ((input.locked ? input.mouseDY : 0) + input.padLookY) * (invertY ? -1 : 1);
    if (dx === 0 && dy === 0 && !input.locked) return;
    const scale = this.ads ? 0.55 : 1;
    this.yaw -= dx * sensitivity * scale;
    this.pitch -= dy * sensitivity * scale;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    this.swayTarget.set(
      THREE.MathUtils.clamp(-dx * 0.0015, -1, 1),
      THREE.MathUtils.clamp(-dy * 0.0015, -1, 1),
    );
  }

  /** Latches edge-triggered intents so a multi-step frame can't double them. */
  queueIntents(intent: PlayerInput): void {
    if (intent.jump) this.jumpQueued = true;
    if (intent.crouch) {
      this.stanceQueued = this.controller.stance === 'crouch' ? 'stand' : 'crouch';
    }
    if (intent.prone) {
      this.stanceQueued = this.controller.stance === 'prone' ? 'stand' : 'prone';
    }
  }

  fixed(dt: number, intent: PlayerInput): void {
    this.health.update(dt);
    if (!this.health.alive) {
      this.velocity.set(0, 0, 0);
      return;
    }

    this.ads = intent.ads && this.controller.stance !== 'prone';

    if (this.stanceQueued) {
      this.controller.trySetStance(this.stanceQueued);
      this.stanceQueued = null;
      // A prone target must actually be a smaller target.
      this.hitboxes.setStanceHeight(this.controller.height);
    }

    const targetSpeed = this.targetSpeed(intent);
    const wish = this.wishDirection(intent);

    // Ground acceleration is stiff so the player stops on a dime; air control
    // is deliberately weak so jumps commit to a direction.
    const accel = this.grounded ? Cfg.acceleration.ground : Cfg.acceleration.air;
    const desired = wish.multiplyScalar(targetSpeed);
    if (desired.lengthSq() > 0) {
      this.velocity.lerp(desired, Math.min(1, accel * dt * 0.1));
      const over = this.velocity.length() - targetSpeed;
      if (over > 0) this.velocity.setLength(targetSpeed);
    } else if (this.grounded) {
      const drop = Cfg.acceleration.friction * dt;
      const len = this.velocity.length();
      this.velocity.multiplyScalar(len > drop ? (len - drop) / len : 0);
    }

    if (this.jumpQueued) {
      this.jumpQueued = false;
      if (this.grounded && this.controller.stance === 'stand' && this.stamina > stamCfg.jumpCost) {
        this.verticalVelocity = Cfg.jumpVelocity;
        this.stamina -= stamCfg.jumpCost;
        this.staminaIdle = 0;
        this.grounded = false;
      }
    }

    this.verticalVelocity += WorldCfg.gravity * dt;
    // Terminal velocity keeps a long fall from tunnelling through terrain.
    this.verticalVelocity = Math.max(this.verticalVelocity, -60);

    const result = this.controller.move({
      x: this.velocity.x * dt,
      y: this.verticalVelocity * dt,
      z: this.velocity.z * dt,
    });

    const wasGrounded = this.grounded;
    this.grounded = result.grounded;
    if (this.grounded && this.verticalVelocity < 0) {
      this.verticalVelocity = 0;
    } else if (!wasGrounded && this.verticalVelocity > 0 && result.moved.y < 1e-4) {
      // Head hit a ceiling; kill the upward motion instead of hovering.
      this.verticalVelocity = 0;
    }
    // Deliberately *not* feeding the solver's result back into `velocity`.
    // Rapier already clamps the applied movement; overwriting the intent with
    // it collapses the velocity on every contact, and the next tick then asks
    // for a sub-millimetre sweep — too little horizontal motion for autostep to
    // lift the capsule, so the player parks against a 20 cm step forever.

    this.updateStamina(dt, intent);

    this.prevFeet.copy(this.currFeet);
    const feet = this.controller.position;
    this.currFeet.set(feet.x, feet.y, feet.z);
    this.prevEye = this.currEye;
    this.currEye = STANCE_EYE[this.controller.stance];

    if (this.grounded) {
      this.bobPhase += (this.speed / Math.max(Cfg.speed.walk, 0.01)) * Cfg.camera.bobFrequency * dt;
    }
  }

  private targetSpeed(intent: PlayerInput): number {
    const stance = this.controller.stance;
    let speed: number;
    if (stance === 'prone') speed = Cfg.speed.prone;
    else if (stance === 'crouch') speed = Cfg.speed.crouch;
    else if (intent.sprint && !this.exhausted && !this.ads && intent.forward > 0) {
      speed = Cfg.speed.sprint;
    } else speed = Cfg.speed.walk;

    if (this.ads) speed = Math.min(speed, Cfg.speed.ads);
    return speed * this.health.speedMultiplier;
  }

  private wishDirection(intent: PlayerInput): THREE.Vector3 {
    const dir = new THREE.Vector3();
    if (!intent.forward && !intent.strafe) return dir;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3().crossVectors(forward, UP).normalize();
    dir.addScaledVector(forward, intent.forward).addScaledVector(right, intent.strafe);
    return dir.normalize();
  }

  private updateStamina(dt: number, intent: PlayerInput): void {
    const sprinting =
      intent.sprint && this.grounded && intent.forward > 0 && this.speed > Cfg.speed.walk * 0.9;

    if (sprinting) {
      this.stamina -= stamCfg.sprintDrainPerSecond * dt;
      this.staminaIdle = 0;
    } else {
      this.staminaIdle += dt;
      if (this.staminaIdle >= stamCfg.regenDelaySeconds) {
        this.stamina += stamCfg.regenPerSecond * dt;
      }
    }
    this.stamina = THREE.MathUtils.clamp(this.stamina, 0, stamCfg.max);

    // Hysteresis: once exhausted you must recover past the threshold to sprint
    // again, otherwise sprint stutters on and off at the boundary.
    if (this.stamina <= 0) this.exhausted = true;
    else if (this.stamina > stamCfg.exhaustedThreshold) this.exhausted = false;
  }

  /** Total aim instability: low stamina and wounded arms both widen it. */
  get swayMultiplier(): number {
    const fatigue =
      1 + (1 - this.stamina / stamCfg.max) * (stamCfg.swayMultiplierAtZero - 1);
    return fatigue * this.health.swayMultiplier * (this.ads ? 0.35 : 1);
  }

  /** Positions the camera between the last two fixed states. */
  updateCamera(camera: THREE.PerspectiveCamera, alpha: number, dt: number): void {
    const feet = new THREE.Vector3().lerpVectors(this.prevFeet, this.currFeet, alpha);
    const eye = THREE.MathUtils.lerp(this.prevEye, this.currEye, alpha);

    this.sway.lerp(this.swayTarget, Math.min(1, Cfg.camera.swaySmoothing * dt));
    this.swayTarget.multiplyScalar(Math.max(0, 1 - 6 * dt));

    const bobAmount =
      this.grounded && this.speed > 0.4
        ? Cfg.camera.bobAmplitude * Math.min(1, this.speed / Cfg.speed.sprint) * this.swayMultiplier
        : 0;
    const bobY = Math.sin(this.bobPhase * 2) * bobAmount;
    const bobX = Math.cos(this.bobPhase) * bobAmount * 0.6;

    camera.position.set(feet.x + bobX, feet.y + eye + bobY, feet.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw + this.sway.x * Cfg.camera.swayAmount);
    camera.rotateX(this.pitch + this.sway.y * Cfg.camera.swayAmount);
    // A slight roll while strafing sells the weight of the body.
    camera.rotateZ(-this.sway.x * Cfg.camera.swayAmount * 0.5);

    const targetFov = this.ads ? Cfg.camera.adsFovDegrees : Cfg.camera.fovDegrees;
    if (Math.abs(camera.fov - targetFov) > 0.01) {
      const k = Math.min(1, dt / Cfg.camera.adsTransitionSeconds);
      camera.fov += (targetFov - camera.fov) * k;
      camera.updateProjectionMatrix();
    }
  }

  /** Moves the player without touching health — used when leaving a vehicle. */
  respawnKeepingHealth(at: THREE.Vector3): void {
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.controller.setPosition(at);
    this.prevFeet.copy(at);
    this.currFeet.copy(at);
  }

  respawn(at: THREE.Vector3): void {
    this.health.reset();
    this.stamina = stamCfg.max;
    this.velocity.set(0, 0, 0);
    this.verticalVelocity = 0;
    this.controller.trySetStance('stand');
    this.controller.setPosition(at);
    this.prevFeet.copy(at);
    this.currFeet.copy(at);
  }

  get debugText(): string {
    const p = this.currFeet;
    return [
      `pos    ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`,
      `postura ${this.stance}${this.grounded ? '' : ' (no ar)'}${this.ads ? ' ADS' : ''}`,
      `veloc  ${this.speed.toFixed(2)} m/s`,
      `stamina ${this.stamina.toFixed(0)}${this.exhausted ? ' EXAUSTO' : ''}`,
      `sway   x${this.swayMultiplier.toFixed(2)}`,
    ].join('\n');
  }

  dispose(): void {
    this.hitboxes.dispose();
    this.controller.dispose();
  }
}
