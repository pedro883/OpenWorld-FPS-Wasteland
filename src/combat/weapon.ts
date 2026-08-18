import * as THREE from 'three';
import weaponConfig from '../../config/weapons.json';
import ballisticsCfg from '../../config/ballistics.json';
import type { BallisticsSystem } from './ballistics';
import type { Stance } from '../physics/characterController';
import type { RAPIER } from '../physics/world';

export interface WeaponDef {
  name: string;
  class: string;
  model: string;
  caliber: string;
  damage: number;
  damageFalloff: Array<[number, number]>;
  muzzleVelocity: number;
  penetration: number;
  rpm: number;
  fireModes: string[];
  burstCount: number;
  magazine: number;
  reloadTacticalSeconds: number;
  reloadEmptySeconds: number;
  zeroMeters: number;
  noiseRadiusMeters: number;
  weightKg: number;
  spread: {
    stand: number;
    crouch: number;
    prone: number;
    adsMultiplier: number;
    movingMultiplier: number;
    jumpingMultiplier: number;
    perShotDegrees: number;
    maxDegrees: number;
  };
  recoil: {
    verticalPattern: number[];
    horizontalPattern: number[];
    verticalDegrees: number;
    horizontalDegrees: number;
    recoverySeconds: number;
    recoveryFraction: number;
    viewKick: number;
    adsMultiplier: number;
  };
}

export interface ShooterState {
  stance: Stance;
  moving: boolean;
  grounded: boolean;
  ads: boolean;
  swayMultiplier: number;
  /**
   * The shooter's own collider. The muzzle sits inside their body, so without
   * this every round resolves against the shooter at distance zero.
   */
  ignore?: RAPIER.Collider;
}

export interface RecoilImpulse {
  pitch: number;
  yaw: number;
}

export function weaponDef(id: string): WeaponDef {
  const def = (weaponConfig.weapons as unknown as Record<string, WeaponDef>)[id];
  if (!def) throw new Error(`arma desconhecida em config/weapons.json: ${id}`);
  return def;
}

export function weaponIds(): string[] {
  return Object.keys(weaponConfig.weapons);
}

const DEG = Math.PI / 180;

/**
 * Weapon state machine: fire modes, cadence, dispersion, a memorisable recoil
 * pattern and two reload timings. Every number comes from config/weapons.json —
 * this class only sequences them.
 */
export class Weapon {
  readonly def: WeaponDef;
  ammo: number;
  reserve: number;
  fireModeIndex = 0;

  private cooldown = 0;
  private reloadTimer = 0;
  private reloadWasEmpty = false;
  private burstRemaining = 0;
  private triggerHeld = false;
  private triggerWasHeld = false;
  /** Index into the recoil pattern; resets once the muzzle settles. */
  private shotIndex = 0;
  private settleTimer = 0;
  private bloom = 0;

  constructor(
    id: string,
    private readonly ballistics: BallisticsSystem,
    private readonly owner: unknown,
    reserveMagazines = 6,
  ) {
    this.def = weaponDef(id);
    this.ammo = this.def.magazine;
    this.reserve = this.def.magazine * reserveMagazines;
  }

  get fireMode(): string {
    return this.def.fireModes[this.fireModeIndex] ?? 'single';
  }

  get isReloading(): boolean {
    return this.reloadTimer > 0;
  }

  get reloadProgress(): number {
    if (this.reloadTimer <= 0) return 1;
    const total = this.reloadWasEmpty
      ? this.def.reloadEmptySeconds
      : this.def.reloadTacticalSeconds;
    return 1 - this.reloadTimer / total;
  }

  cycleFireMode(): string {
    this.fireModeIndex = (this.fireModeIndex + 1) % this.def.fireModes.length;
    return this.fireMode;
  }

  setTrigger(held: boolean): void {
    this.triggerHeld = held;
  }

  /**
   * Cone half-angle in degrees. Posture, aiming, motion and accumulated bloom
   * all fold in here, and the shooter's own instability (fatigue, wounded arm)
   * multiplies the result.
   */
  spreadDegrees(state: ShooterState): number {
    const s = this.def.spread;
    let spread = s[state.stance];
    if (state.ads) spread *= s.adsMultiplier;
    if (state.moving) spread *= s.movingMultiplier;
    if (!state.grounded) spread *= s.jumpingMultiplier;
    spread = (spread + this.bloom) * state.swayMultiplier;
    return Math.min(spread, s.maxDegrees);
  }

  /** Aim point after dispersion, as a unit vector. */
  private disperse(direction: THREE.Vector3, spreadDeg: number): THREE.Vector3 {
    if (spreadDeg <= 0) return direction.clone();
    // Uniform over the cone's solid angle, so the centre is not over-weighted.
    const maxCos = Math.cos(spreadDeg * DEG);
    const cosTheta = maxCos + (1 - maxCos) * Math.random();
    const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
    const phi = Math.random() * Math.PI * 2;

    const forward = direction.clone().normalize();
    const helper =
      Math.abs(forward.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, helper).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    return forward
      .multiplyScalar(cosTheta)
      .addScaledVector(right, sinTheta * Math.cos(phi))
      .addScaledVector(up, sinTheta * Math.sin(phi))
      .normalize();
  }

  update(dt: number): void {
    if (this.reloadTimer > 0) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) this.finishReload();
    }
    this.cooldown = Math.max(0, this.cooldown - dt);

    const recover = weaponConfig.defaults.spreadRecoverPerSecond * dt;
    this.bloom = Math.max(0, this.bloom - recover);

    this.settleTimer += dt;
    if (this.settleTimer > this.def.recoil.recoverySeconds * 2.5) this.shotIndex = 0;

    this.triggerWasHeld = this.triggerHeld;
  }

  /** True when the trigger state allows a shot this instant. */
  private triggerAllows(): boolean {
    switch (this.fireMode) {
      case 'auto':
        return this.triggerHeld;
      case 'burst':
        if (this.burstRemaining > 0) return true;
        return this.triggerHeld && !this.triggerWasHeld;
      default:
        return this.triggerHeld && !this.triggerWasHeld;
    }
  }

  /**
   * Fires if cadence, ammo and fire mode allow. Returns the recoil impulse to
   * apply to the view, or null when nothing was fired.
   */
  tryFire(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    state: ShooterState,
  ): RecoilImpulse | null {
    if (this.reloadTimer > 0 || this.cooldown > 0) return null;
    if (!this.triggerAllows()) return null;
    if (this.ammo <= 0) {
      this.burstRemaining = 0;
      return null;
    }

    const spread = this.spreadDegrees(state);
    const aim = this.disperse(direction, spread);

    const fired = this.ballistics.fire({
      origin: origin.clone(),
      direction: aim,
      muzzleVelocity: this.def.muzzleVelocity,
      damage: this.def.damage,
      falloff: this.def.damageFalloff,
      penetration: this.def.penetration,
      shooter: this.owner,
      tracer: this.shotIndex % ballisticsCfg.tracer.everyNthShot === 0,
      ignore: state.ignore,
    });
    if (!fired) return null;

    this.ammo--;
    this.cooldown = 60 / this.def.rpm;
    this.bloom = Math.min(
      this.def.spread.maxDegrees,
      this.bloom + this.def.spread.perShotDegrees,
    );

    if (this.fireMode === 'burst') {
      this.burstRemaining =
        this.burstRemaining > 0 ? this.burstRemaining - 1 : this.def.burstCount - 1;
    }

    const recoil = this.recoilForShot(state.ads);
    this.shotIndex++;
    this.settleTimer = 0;
    return recoil;
  }

  /** Deterministic per-shot kick, so the pattern can be learned and countered. */
  private recoilForShot(ads: boolean): RecoilImpulse {
    const r = this.def.recoil;
    const i = Math.min(this.shotIndex, r.verticalPattern.length - 1);
    const scale = ads ? r.adsMultiplier : 1;
    return {
      pitch: r.verticalPattern[i]! * r.verticalDegrees * scale * DEG,
      yaw: r.horizontalPattern[i]! * r.horizontalDegrees * scale * DEG,
    };
  }

  reload(): boolean {
    if (this.reloadTimer > 0 || this.reserve <= 0 || this.ammo >= this.def.magazine) return false;
    this.reloadWasEmpty = this.ammo === 0;
    this.reloadTimer = this.reloadWasEmpty
      ? this.def.reloadEmptySeconds
      : this.def.reloadTacticalSeconds;
    this.burstRemaining = 0;
    return true;
  }

  private finishReload(): void {
    // A tactical reload keeps the round in the chamber; an empty one does not.
    const capacity = this.def.magazine + (this.reloadWasEmpty ? 0 : this.ammo > 0 ? 1 : 0);
    const wanted = Math.min(capacity, this.def.magazine + 1) - this.ammo;
    const taken = Math.min(wanted, this.reserve);
    this.ammo += taken;
    this.reserve -= taken;
    this.reloadTimer = 0;
  }

  get debugText(): string {
    return [
      `${this.def.name}`,
      `munição ${this.ammo}/${this.def.magazine}  reserva ${this.reserve}`,
      `modo ${this.fireMode}  bloom ${this.bloom.toFixed(2)}°  tiro #${this.shotIndex}`,
      this.isReloading ? `recarregando ${(this.reloadProgress * 100).toFixed(0)}%` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
