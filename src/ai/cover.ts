import * as THREE from 'three';
import aiConfig from '../../config/ai.json';
import { SIGHT_BLOCKERS } from '../physics/layers';
import type { PhysicsWorld } from '../physics/world';
import type { Terrain } from '../world/terrain';

const cfg = aiConfig.cover;
const navCfg = aiConfig.navigation;

export interface CoverPoint {
  position: THREE.Vector3;
  /** 0..1 — how well the spot hides the agent from the threat. */
  concealment: number;
  /** True when the agent can shoot back by standing or leaning out. */
  canReturnFire: boolean;
  /** Posture the cover works at. */
  posture: 'crouch' | 'prone' | 'stand';
  score: number;
}

const MAX_SLOPE = navCfg.maxSlopeDegrees * (Math.PI / 180);

/**
 * Cover found at runtime rather than baked per chunk.
 *
 * The world streams and its props are scattered procedurally, so a precomputed
 * cover graph would have to be regenerated per chunk anyway. Sampling rings
 * around the agent and testing actual line of sight against the threat costs a
 * handful of raycasts, runs only when the agent asks for it, and — unlike a
 * baked graph — is automatically correct about where the *current* threat is.
 */
export class CoverFinder {
  private readonly scratch = new THREE.Vector3();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly terrain: Terrain,
  ) {}

  /**
   * Best cover near `from` against a threat at `threat`.
   * `preferredRange` biases the search towards a useful firing distance.
   */
  find(
    from: THREE.Vector3,
    threat: THREE.Vector3,
    preferredRange: number,
    coverSkill: number,
    /**
     * When true, spots the agent cannot shoot from are rejected outright.
     * Fully concealed cover is only useful while retreating — during a firefight
     * it turns the agent into a statue that hides and never fires back.
     */
    requireReturnFire = true,
  ): CoverPoint | null {
    const threatEye = this.scratch.set(threat.x, threat.y + 1.62, threat.z).clone();
    let best: CoverPoint | null = null;

    for (const radius of cfg.sampleRings) {
      if (radius > cfg.maxSearchMeters) break;
      for (let i = 0; i < cfg.samplesPerRing; i++) {
        // Offset each ring so samples do not line up into spokes.
        const angle = ((i + radius * 0.37) / cfg.samplesPerRing) * Math.PI * 2;
        const x = from.x + Math.cos(angle) * radius;
        const z = from.z + Math.sin(angle) * radius;

        const y = this.terrain.heightAt(x, z);
        if (y < this.terrain.params.waterLevel + 0.4) continue;
        if (this.terrain.slopeAt(x, z) > MAX_SLOPE) continue;

        const candidate = this.evaluate(
          new THREE.Vector3(x, y, z),
          threatEye,
          from,
          preferredRange,
        );
        if (!candidate) continue;
        if (requireReturnFire && !candidate.canReturnFire) continue;
        if (!best || candidate.score > best.score) best = candidate;
      }
    }

    // A poor skill level settles for worse cover, and sometimes for none.
    if (best && best.score < cfg.minScoreToMove * (2 - coverSkill)) return null;
    return best;
  }

  private evaluate(
    point: THREE.Vector3,
    threatEye: THREE.Vector3,
    agentPosition: THREE.Vector3,
    preferredRange: number,
  ): CoverPoint | null {
    const standEye = point.clone().setY(point.y + cfg.standCoverHeightMeters);
    const crouchEye = point.clone().setY(point.y + cfg.crouchCoverHeightMeters);
    const proneEye = point.clone().setY(point.y + 0.4);

    const standExposed = this.physics.hasLineOfSight(threatEye, standEye, SIGHT_BLOCKERS);
    const crouchExposed = this.physics.hasLineOfSight(threatEye, crouchEye, SIGHT_BLOCKERS);
    const proneExposed = this.physics.hasLineOfSight(threatEye, proneEye, SIGHT_BLOCKERS);

    let posture: CoverPoint['posture'];
    let concealment: number;
    let canReturnFire: boolean;

    if (!crouchExposed && standExposed) {
      // The sweet spot: hidden while crouched, able to shoot by standing.
      posture = 'crouch';
      concealment = 0.85;
      canReturnFire = true;
    } else if (!proneExposed && crouchExposed) {
      posture = 'prone';
      concealment = 0.7;
      canReturnFire = true;
    } else if (!standExposed) {
      // Fully hidden — safe, but useless for shooting back.
      posture = 'stand';
      concealment = 1;
      canReturnFire = false;
    } else {
      return null;
    }

    const distanceToThreat = point.distanceTo(threatEye);
    const rangeError = Math.abs(distanceToThreat - preferredRange) / Math.max(preferredRange, 1);
    const travel = point.distanceTo(agentPosition);

    // Concealment dominates; then being at a useful range; then not walking far.
    const score =
      concealment * 1.0 +
      (canReturnFire ? 0.45 : 0) -
      Math.min(1, rangeError) * 0.4 -
      Math.min(1, travel / cfg.maxSearchMeters) * 0.35;

    return { position: point, concealment, canReturnFire, posture, score };
  }

  /** True when the agent at `position` is currently hidden from `threat`. */
  isCovered(position: THREE.Vector3, threat: THREE.Vector3, eyeHeight: number): boolean {
    const threatEye = new THREE.Vector3(threat.x, threat.y + 1.62, threat.z);
    const eye = new THREE.Vector3(position.x, position.y + eyeHeight, position.z);
    return !this.physics.hasLineOfSight(threatEye, eye, SIGHT_BLOCKERS);
  }
}
