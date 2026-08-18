import * as THREE from 'three';
import weaponConfig from '../../config/weapons.json';
import ballisticsCfg from '../../config/ballistics.json';
import type { BallisticsSystem } from './ballistics';
import type { Stance } from '../physics/characterController';
import type { RAPIER } from '../physics/world';
import { AmmoPouch, weaponDef, type WeaponDef } from './arsenal';
import { describe as describeAttachments, presetFor, withAttachments } from './attachments';

export type { WeaponDef } from './arsenal';
export { weaponDef, allWeaponIds } from './arsenal';

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
  /** Rounds actually launched — shotguns fire a whole pellet cloud per shot. */
  projectiles: number;
}

const DEG = Math.PI / 180;

/**
 * Weapon state machine: fire modes, cadence, dispersion, a memorisable recoil
 * pattern, reloads and the projectile kind. Every number comes from
 * config/weapons.json — this class only sequences them.
 */
export class Weapon {
  readonly def: WeaponDef;
  ammo: number;
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
  /** Bolt/pump cycling, which blocks firing but is not a reload. */
  private cycleTimer = 0;

  constructor(
    id: string,
    private readonly ballistics: BallisticsSystem,
    private readonly owner: unknown,
    private readonly pouch: AmmoPouch,
    attachments?: readonly string[],
  ) {
    // Attachments are folded into a copy of the definition, so two rifles with
    // different optics really are different weapons in every number.
    this.def = withAttachments(weaponDef(id), attachments ?? presetFor(id));
    this.ammo = Math.min(this.def.magazine, this.pouch.take(this.def, this.def.magazine));
  }

  get id(): string {
    return this.def.id;
  }

  get reserve(): number {
    return this.pouch.reserve(this.def);
  }

  get fireMode(): string {
    return this.def.fireModes[this.fireModeIndex] ?? 'single';
  }

  get isReloading(): boolean {
    return this.reloadTimer > 0;
  }

  get isCycling(): boolean {
    return this.cycleTimer > 0;
  }

  get reloadProgress(): number {
    if (this.reloadTimer <= 0) return 1;
    const total = this.reloadWasEmpty
      ? this.def.reloadEmptySeconds
      : this.def.reloadTacticalSeconds;
    return total > 0 ? 1 - this.reloadTimer / total : 1;
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
    this.cycleTimer = Math.max(0, this.cycleTimer - dt);

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
    if (this.reloadTimer > 0 || this.cooldown > 0 || this.cycleTimer > 0) return null;
    if (!this.triggerAllows()) return null;
    if (this.ammo <= 0) {
      this.burstRemaining = 0;
      return null;
    }

    const spread = this.spreadDegrees(state);
    const launched = this.launch(origin, direction, spread, state);
    if (launched === 0) return null;

    this.ammo--;
    this.cooldown = 60 / this.def.rpm;
    // A bolt or pump gun must cycle before the next shot, on top of cadence.
    this.cycleTimer = this.def.boltActionSeconds;
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
    return { ...recoil, projectiles: launched };
  }

  /** Emits the projectiles for one trigger event. Returns how many left the barrel. */
  private launch(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    spread: number,
    state: ShooterState,
  ): number {
    const def = this.def;

    if (def.projectile === 'melee') {
      const hit = this.ballistics.instantHit(
        origin,
        direction.clone().normalize(),
        def.reachMeters,
        def.damage,
        this.owner,
        state.ignore,
      );
      // A swing always costs the animation, whether or not it connected.
      return hit ? 1 : 1;
    }

    const count = Math.max(1, def.pellets);
    let launched = 0;
    for (let i = 0; i < count; i++) {
      // Pellets get their own tight cone on top of the weapon's dispersion.
      const cone = count > 1 ? spread + def.pelletSpreadDegrees : spread;
      const aim = this.disperse(direction, cone);
      const ok = this.ballistics.fire({
        origin: origin.clone(),
        direction: aim,
        muzzleVelocity: def.muzzleVelocity,
        damage: def.damage,
        falloff: def.damageFalloff,
        penetration: def.penetration,
        shooter: this.owner,
        tracer: count === 1 && this.shotIndex % ballisticsCfg.tracer.everyNthShot === 0,
        ignore: state.ignore,
        explosion: def.explosion,
        kind: def.projectile,
        fuseSeconds: def.projectile === 'thrown' ? def.fuseSeconds : 0,
        model: def.projectile === 'thrown' || def.projectile === 'rocket' ? def.model : null,
        special:
          def.smoke || def.flash || def.burn
            ? { smoke: def.smoke, flash: def.flash, burn: def.burn }
            : null,
      });
      if (ok) launched++;
    }
    return launched;
  }

  /** Deterministic per-shot kick, so the pattern can be learned and countered. */
  private recoilForShot(ads: boolean): { pitch: number; yaw: number } {
    const r = this.def.recoil;
    const i = Math.min(this.shotIndex, r.verticalPattern.length - 1);
    const scale = ads ? r.adsMultiplier : 1;
    return {
      pitch: r.verticalPattern[i]! * r.verticalDegrees * scale * DEG,
      yaw: r.horizontalPattern[i]! * r.horizontalDegrees * scale * DEG,
    };
  }

  reload(): boolean {
    if (this.reloadTimer > 0) return false;
    if (this.ammo >= this.def.magazine) return false;
    if (this.reserve <= 0) return false;
    this.reloadWasEmpty = this.ammo === 0;
    // Shell-fed guns top up one round at a time and can be interrupted.
    this.reloadTimer = this.reloadWasEmpty
      ? this.def.reloadEmptySeconds
      : this.def.reloadTacticalSeconds;
    this.burstRemaining = 0;
    return true;
  }

  /** Aborts a shell-by-shell reload so the player can fire what is loaded. */
  cancelReload(): boolean {
    if (this.reloadTimer <= 0 || !this.def.reloadPerShell) return false;
    this.reloadTimer = 0;
    return true;
  }

  private finishReload(): void {
    const def = this.def;
    if (def.reloadPerShell) {
      // One shell per cycle; re-arm the timer until the tube is full or dry.
      const taken = this.pouch.take(def, 1);
      this.ammo = Math.min(def.magazine, this.ammo + taken);
      this.reloadTimer = 0;
      if (taken > 0 && this.ammo < def.magazine && this.reserve > 0) {
        this.reloadWasEmpty = false;
        this.reloadTimer = def.reloadTacticalSeconds;
      }
      return;
    }
    const wanted = def.magazine - this.ammo;
    this.ammo += this.pouch.take(def, wanted);
    this.reloadTimer = 0;
  }

  /** Called when the weapon is holstered, so a partial reload does not persist. */
  onHolster(): void {
    this.reloadTimer = 0;
    this.cycleTimer = 0;
    this.burstRemaining = 0;
    this.triggerHeld = false;
    this.triggerWasHeld = false;
    this.shotIndex = 0;
    this.bloom = 0;
  }

  get debugText(): string {
    return [
      `${this.def.name}  [${this.def.class}]`,
      `  ${describeAttachments(this.def.attachments ?? [])}`,
      `munição ${this.ammo}/${this.def.magazine}  reserva ${this.reserve}`,
      `modo ${this.fireMode}  bloom ${this.bloom.toFixed(2)}°  tiro #${this.shotIndex}`,
      this.isReloading ? `recarregando ${(this.reloadProgress * 100).toFixed(0)}%` : '',
      this.isCycling ? 'ferrolho' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
}
