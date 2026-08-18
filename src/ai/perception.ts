import * as THREE from 'three';
import aiConfig from '../../config/ai.json';
import { SIGHT_BLOCKERS } from '../physics/layers';
import type { PhysicsWorld } from '../physics/world';
import type { Stance } from '../physics/characterController';

const cfg = aiConfig.perception;
const hearingCfg = aiConfig.hearing;

export type AwarenessState = 'unaware' | 'suspicious' | 'searching' | 'aware' | 'engaged';

export type SoundKind = keyof typeof hearingCfg.types;

export interface SoundEvent {
  kind: SoundKind;
  position: THREE.Vector3;
  /** Radius the source itself declares (a suppressor shrinks it). */
  radiusMeters: number;
  source: unknown;
}

/** What perception needs to know about a potential target. */
export interface PerceptionTarget {
  position: THREE.Vector3;
  eyePosition: THREE.Vector3;
  stance: Stance;
  speed: number;
  isSprinting: boolean;
  /** Set while the target's weapon is firing, which is very visible. */
  firing: boolean;
  firingSuppressed: boolean;
  isAlive: boolean;
}

export interface PerceptionResult {
  state: AwarenessState;
  meter: number;
  /** True when the target is visible *right now*. */
  hasLineOfSight: boolean;
  distance: number;
  /** Where the agent believes the target is; decays after contact is lost. */
  lastKnownPosition: THREE.Vector3 | null;
  lastKnownAge: number;
}

const DEG = Math.PI / 180;

/**
 * One agent's senses.
 *
 * Detection is a meter, not a boolean: a prone, stationary target at 300 m in
 * fog fills it slowly enough that the player can break contact, while someone
 * sprinting across open ground at noon is spotted almost at once. The same
 * meter drives every awareness state, so there is one number to debug.
 */
/** Anything that can attenuate a sight line, such as a smoke cloud. */
export interface VisionMedium {
  visionThrough(from: THREE.Vector3, to: THREE.Vector3): number;
}

export class Perception {
  private meter = 0;
  private state: AwarenessState = 'unaware';
  private readonly lastKnown = new THREE.Vector3();
  private hasLastKnown = false;
  private lastKnownAge = 0;
  private timeSinceSeen = Infinity;
  private visible = false;
  private distance = Infinity;

  /** Extra alertness from hearing, decays like the visual meter. */
  private heardBoost = 0;
  private readonly heardPosition = new THREE.Vector3();
  private hasHeard = false;

  constructor(
    private readonly physics: PhysicsWorld,
    /** Multiplier from the agent's skill level. */
    public skillMultiplier = 1,
    /** Smoke and similar; queried on every sight line. */
    private readonly medium: VisionMedium | null = null,
  ) {}

  get awareness(): AwarenessState {
    return this.state;
  }

  get meterValue(): number {
    return this.meter;
  }

  get seesTarget(): boolean {
    return this.visible;
  }

  get lastKnownTargetPosition(): THREE.Vector3 | null {
    return this.hasLastKnown ? this.lastKnown : null;
  }

  get investigatePoint(): THREE.Vector3 | null {
    if (this.hasLastKnown) return this.lastKnown;
    return this.hasHeard ? this.heardPosition : null;
  }

  /**
   * A sound the agent might notice. Walls do not block hearing, they muffle it,
   * so an interior firefight still draws attention from outside.
   */
  hear(event: SoundEvent, selfPosition: THREE.Vector3): boolean {
    const typeMultiplier = hearingCfg.types[event.kind] ?? 1;
    const radius = event.radiusMeters * typeMultiplier;
    const distance = selfPosition.distanceTo(event.position);
    if (distance > radius) return false;

    let strength = 1 - distance / Math.max(radius, 1e-3);
    if (!this.physics.hasLineOfSight(selfPosition, event.position, SIGHT_BLOCKERS)) {
      strength *= hearingCfg.wallAttenuation;
    }
    if (strength <= 0.02) return false;

    this.heardBoost = Math.min(100, this.heardBoost + hearingCfg.alertGain * strength);
    this.heardPosition.copy(event.position);
    this.hasHeard = true;
    return true;
  }

  /**
   * @param eye         the agent's eye position
   * @param forward     the agent's facing, unit length
   * @param visibility  0..1 from the day/night cycle and weather
   */
  update(
    dt: number,
    eye: THREE.Vector3,
    forward: THREE.Vector3,
    target: PerceptionTarget | null,
    visibility: number,
  ): PerceptionResult {
    this.timeSinceSeen += dt;
    if (this.hasLastKnown) this.lastKnownAge += dt;

    let gain = 0;
    this.visible = false;
    this.distance = Infinity;

    if (target && target.isAlive) {
      this.distance = eye.distanceTo(target.eyePosition);
      gain = this.visualGain(eye, forward, target, visibility);
      if (gain > 0) {
        this.visible = true;
        this.timeSinceSeen = 0;
        this.lastKnown.copy(target.position);
        this.hasLastKnown = true;
        this.lastKnownAge = 0;
      }
    }

    // Hearing feeds the same meter, so a shot in the dark still escalates.
    const heardContribution = this.heardBoost;
    this.heardBoost = Math.max(0, this.heardBoost - cfg.decayPerSecond * dt);

    if (gain > 0) {
      this.meter = Math.min(100, this.meter + gain * dt);
    } else {
      const decay = cfg.decayPerSecond * dt;
      this.meter = Math.max(heardContribution, this.meter - decay);
    }

    // Memory fades; once it is gone the agent has nowhere left to search.
    if (this.hasLastKnown && this.lastKnownAge > cfg.memory.lastKnownDecaySeconds) {
      this.hasLastKnown = false;
    }

    this.state = this.stateFor(this.meter);

    return {
      state: this.state,
      meter: this.meter,
      hasLineOfSight: this.visible,
      distance: this.distance,
      lastKnownPosition: this.hasLastKnown ? this.lastKnown : null,
      lastKnownAge: this.lastKnownAge,
    };
  }

  /** Detection rate per second, or 0 when the target cannot be seen at all. */
  private visualGain(
    eye: THREE.Vector3,
    forward: THREE.Vector3,
    target: PerceptionTarget,
    visibility: number,
  ): number {
    const toTarget = target.eyePosition.clone().sub(eye);
    const distance = toTarget.length();
    if (distance > cfg.maxRangeMeters) return 0;
    toTarget.divideScalar(Math.max(distance, 1e-6));

    const cosAngle = forward.dot(toTarget);
    const halfFov = Math.cos((cfg.fovDegrees / 2) * DEG);
    if (cosAngle < halfFov) return 0;

    if (!this.physics.hasLineOfSight(eye, target.eyePosition, SIGHT_BLOCKERS)) return 0;

    // Smoke does not block the ray, it thins what gets through: a thick cloud
    // drops detection to a crawl without making the target literally invisible.
    const through = this.medium ? this.medium.visionThrough(eye, target.eyePosition) : 1;
    if (through <= 0.05) return 0;

    const m = cfg.modifiers;
    let factor = 1;

    // Range: falls off with a power curve, but close contact always registers.
    if (distance > cfg.closeRangeMeters) {
      const t = (distance - cfg.closeRangeMeters) / (cfg.maxRangeMeters - cfg.closeRangeMeters);
      factor *= Math.max(0.02, 1 - Math.pow(t, m.rangeFalloffPower));
    }

    // Off-axis targets are noticed more slowly than ones dead ahead.
    const centreness = (cosAngle - halfFov) / Math.max(1 - halfFov, 1e-6);
    factor *= m.peripheralVision + (1 - m.peripheralVision) * centreness;

    factor *= m.stance[target.stance] ?? 1;

    if (target.firing) {
      factor *= target.firingSuppressed ? m.firingSuppressed : m.firingUnsuppressed;
    } else if (target.isSprinting) {
      factor *= m.sprinting;
    } else if (target.speed > 0.4) {
      factor *= m.moving;
    } else {
      // Holding still is the strongest thing a player can do to stay unseen.
      factor *= m.stationary;
    }

    factor *= Math.max(m.minVisibilityFactor, visibility);
    factor *= through;
    factor *= this.skillMultiplier;

    return cfg.baseGainPerSecond * factor;
  }

  private stateFor(meter: number): AwarenessState {
    const t = cfg.thresholds;
    if (meter >= t.engaged) return 'engaged';
    if (meter >= t.aware) return 'aware';
    if (meter >= t.searching) return 'searching';
    if (meter >= t.suspicious) return 'suspicious';
    return 'unaware';
  }

  /** Contact reported by a squadmate: believed, but not seen. */
  receiveContact(position: THREE.Vector3, errorMeters: number): void {
    this.lastKnown.copy(position);
    this.lastKnown.x += (Math.random() - 0.5) * errorMeters * 2;
    this.lastKnown.z += (Math.random() - 0.5) * errorMeters * 2;
    this.hasLastKnown = true;
    this.lastKnownAge = 0;
    this.meter = Math.max(this.meter, cfg.thresholds.aware);
    this.state = this.stateFor(this.meter);
  }

  get hasLostTarget(): boolean {
    return this.timeSinceSeen > cfg.memory.loseTargetSeconds;
  }

  reset(): void {
    this.meter = 0;
    this.state = 'unaware';
    this.hasLastKnown = false;
    this.hasHeard = false;
    this.heardBoost = 0;
    this.timeSinceSeen = Infinity;
    this.visible = false;
  }

  get debugText(): string {
    return `${this.state} ${this.meter.toFixed(0)}%${this.visible ? ' [visão]' : ''}`;
  }
}
