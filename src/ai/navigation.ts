import * as THREE from 'three';
import aiConfig from '../../config/ai.json';
import { WORLD_SOLID } from '../physics/layers';
import type { PhysicsWorld } from '../physics/world';
import type { Terrain } from '../world/terrain';

const cfg = aiConfig.navigation;
const MAX_SLOPE = cfg.maxSlopeDegrees * (Math.PI / 180);

export interface SteerResult {
  /** Unit direction to move, or zero when the agent should stand still. */
  direction: THREE.Vector3;
  arrived: boolean;
  /** True when the agent is wedged and the caller should pick a new goal. */
  blocked: boolean;
}

/**
 * Navigation over the streamed heightfield.
 *
 * **Deviation from the spec:** this is steering with terrain and obstacle
 * probes, not a Recast navmesh. The world is procedural and streamed in 128 m
 * chunks, so a navmesh would have to be rebuilt per chunk at runtime — the risk
 * flagged in the plan. The ground here is a heightfield that is walkable
 * everywhere except steep slopes and water, which the slope test covers
 * directly; the only genuine obstacles are POI buildings and scattered props,
 * and those are handled by forward probes. Baked navmeshes remain the right
 * answer for building interiors, which is where this will be revisited.
 */
export class Navigator {
  private readonly probeDirs: THREE.Vector3[] = [];
  private stuckTimer = 0;
  private readonly lastPosition = new THREE.Vector3();
  private detourSign = 1;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly terrain: Terrain,
  ) {
    // Fan of probes: straight ahead plus increasing angles either side.
    for (const degrees of [0, 22, -22, 45, -45, 70, -70]) {
      const a = degrees * (Math.PI / 180);
      this.probeDirs.push(new THREE.Vector3(Math.sin(a), 0, Math.cos(a)));
    }
  }

  /** True when an agent can stand at this spot. */
  isWalkable(x: number, z: number): boolean {
    const y = this.terrain.heightAt(x, z);
    if (y < this.terrain.params.waterLevel + 0.3) return false;
    return this.terrain.slopeAt(x, z) <= MAX_SLOPE;
  }

  groundHeight(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  /**
   * Direction to move from `position` towards `goal`, avoiding obstacles and
   * squadmates. `neighbours` are other agents to keep separation from.
   */
  steer(
    dt: number,
    position: THREE.Vector3,
    goal: THREE.Vector3,
    neighbours: readonly THREE.Vector3[],
  ): SteerResult {
    const toGoal = new THREE.Vector3(goal.x - position.x, 0, goal.z - position.z);
    const distance = toGoal.length();
    if (distance <= cfg.arriveRadiusMeters) {
      this.stuckTimer = 0;
      return { direction: new THREE.Vector3(), arrived: true, blocked: false };
    }
    toGoal.divideScalar(distance);

    const desired = this.avoidObstacles(position, toGoal);

    // Separation, so a squad does not merge into one body while advancing.
    for (const other of neighbours) {
      const dx = position.x - other.x;
      const dz = position.z - other.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-3 && d < cfg.separationMeters) {
        const push = (cfg.separationMeters - d) / cfg.separationMeters;
        desired.x += (dx / d) * push * cfg.avoidanceStrength;
        desired.z += (dz / d) * push * cfg.avoidanceStrength;
      }
    }

    if (desired.lengthSq() < 1e-6) {
      return { direction: new THREE.Vector3(), arrived: false, blocked: true };
    }
    desired.normalize();

    // Stuck detection: moving less than a crawl while wanting to move means
    // the steering has wedged against geometry and the goal must change.
    const moved = position.distanceTo(this.lastPosition);
    this.lastPosition.copy(position);
    this.stuckTimer = moved < 0.05 * dt * 60 ? this.stuckTimer + dt : 0;
    const blocked = this.stuckTimer > 1.2;
    if (blocked) {
      this.stuckTimer = 0;
      // Alternate the detour side so an agent does not oscillate in a corner.
      this.detourSign = -this.detourSign;
    }

    return { direction: desired, arrived: false, blocked };
  }

  /** Picks the probe direction closest to the goal that is actually clear. */
  private avoidObstacles(position: THREE.Vector3, toGoal: THREE.Vector3): THREE.Vector3 {
    const origin = {
      x: position.x,
      y: position.y + 0.9,
      z: position.z,
    };
    const goalYaw = Math.atan2(toGoal.x, toGoal.z);

    let best: THREE.Vector3 | null = null;
    let bestPenalty = Infinity;

    for (let i = 0; i < this.probeDirs.length; i++) {
      const base = this.probeDirs[i]!;
      // Rotate the fan so index 0 always points at the goal.
      const dir = new THREE.Vector3(
        Math.sin(goalYaw) * base.z + Math.cos(goalYaw) * base.x,
        0,
        Math.cos(goalYaw) * base.z - Math.sin(goalYaw) * base.x,
      ).normalize();

      const ahead = {
        x: position.x + dir.x * cfg.stepAheadMeters,
        z: position.z + dir.z * cfg.stepAheadMeters,
      };
      if (!this.isWalkable(ahead.x, ahead.z)) continue;

      const hit = this.physics.raycast(origin, dir, cfg.obstacleProbeMeters, WORLD_SOLID);
      if (hit) continue;

      // Prefer the smallest deviation from the goal direction.
      const penalty = i * (i % 2 === 0 ? 1 : 1.05);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = dir;
      }
    }

    if (best) return best.clone();
    // Everything blocked: slide sideways rather than grind into the wall.
    return new THREE.Vector3(toGoal.z * this.detourSign, 0, -toGoal.x * this.detourSign);
  }

  /**
   * A reachable point roughly `distance` metres from `origin` in the direction
   * of `bearing`, used for patrol goals and flank positions.
   */
  findReachablePoint(
    origin: THREE.Vector3,
    bearing: number,
    distance: number,
    attempts = 8,
  ): THREE.Vector3 | null {
    for (let i = 0; i < attempts; i++) {
      const spread = (i / attempts) * Math.PI;
      const angle = bearing + (i % 2 === 0 ? spread : -spread) * 0.5;
      const d = distance * (1 - (i / attempts) * 0.4);
      const x = origin.x + Math.sin(angle) * d;
      const z = origin.z + Math.cos(angle) * d;
      if (this.isWalkable(x, z)) {
        return new THREE.Vector3(x, this.terrain.heightAt(x, z), z);
      }
    }
    return null;
  }
}
