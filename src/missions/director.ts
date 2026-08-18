import * as THREE from 'three';
import { Random } from '../core/random';
import { fillBoard, type MissionWorld } from './generator';
import { DIRECTOR, type MissionSpec, type MissionStatus } from './types';

export interface ActiveMission {
  spec: MissionSpec;
  status: MissionStatus;
  /** Seconds left before the job goes cold. */
  remaining: number;
  /** Enemies still standing; the eliminate objectives watch this. */
  enemiesAlive: number;
  /** Seconds banked towards a plant or a hold. */
  progress: number;
  /** True once the player has been inside the objective radius. */
  visited: boolean;
  /** Loot sources this mission put in the world, cleaned up when it ends. */
  cacheIds: string[];
}

export interface MissionEvents {
  onSpawn(mission: ActiveMission): void;
  onEnd(mission: ActiveMission): void;
  onCompleted(mission: ActiveMission): void;
}

/**
 * Keeps the mission board alive.
 *
 * The board holds between three and five jobs at once. One that is finished or
 * has gone cold is cleared, and after a short delay another appears somewhere
 * else — the map should never be empty, and it should never be the same map
 * twice. Nothing here spawns entities directly: the scene subscribes and does
 * that, so the director stays testable and has no idea what a Rapier body is.
 */
export class MissionDirector {
  private readonly active: ActiveMission[] = [];
  private readonly rng: Random;
  private respawnTimer = 0;

  constructor(
    seed: number,
    private readonly world: MissionWorld,
    private readonly events: MissionEvents,
  ) {
    this.rng = new Random(seed);
  }

  get missions(): readonly ActiveMission[] {
    return this.active;
  }

  get activeCount(): number {
    return this.active.filter((m) => m.status === 'active').length;
  }

  /** Opens the board with the minimum number of jobs. */
  start(): void {
    this.top(DIRECTOR.minActive);
  }

  private top(target: number): void {
    const specs = this.active.map((m) => m.spec);
    const filled = fillBoard(this.rng, this.world, specs, target);
    for (const spec of filled.slice(specs.length)) {
      const mission: ActiveMission = {
        spec,
        status: 'active',
        remaining: spec.timerSeconds,
        enemiesAlive: spec.enemyCount,
        progress: 0,
        visited: false,
        cacheIds: [],
      };
      this.active.push(mission);
      this.events.onSpawn(mission);
    }
  }

  find(id: string): ActiveMission | null {
    return this.active.find((m) => m.spec.id === id) ?? null;
  }

  /** The job whose objective the player is standing in, if any. */
  missionAt(position: THREE.Vector3): ActiveMission | null {
    for (const mission of this.active) {
      if (mission.status !== 'active') continue;
      const d = Math.hypot(position.x - mission.spec.x, position.z - mission.spec.z);
      if (d <= mission.spec.radiusMeters) return mission;
    }
    return null;
  }

  reportKill(missionId: string): void {
    const mission = this.find(missionId);
    if (!mission || mission.status !== 'active') return;
    mission.enemiesAlive = Math.max(0, mission.enemiesAlive - 1);
    const objective = mission.spec.objective;
    if ((objective === 'eliminate' || objective === 'assassinate') && mission.enemiesAlive === 0) {
      this.complete(mission);
    }
  }

  complete(mission: ActiveMission): void {
    if (mission.status !== 'active') return;
    mission.status = 'completed';
    this.events.onCompleted(mission);
    this.retire(mission);
  }

  fail(mission: ActiveMission, status: MissionStatus = 'failed'): void {
    if (mission.status !== 'active') return;
    mission.status = status;
    this.retire(mission);
  }

  private retire(mission: ActiveMission): void {
    this.events.onEnd(mission);
    const index = this.active.indexOf(mission);
    if (index >= 0) this.active.splice(index, 1);
    // A pause before the next job appears, so the board does not visibly churn.
    this.respawnTimer = Math.max(this.respawnTimer, DIRECTOR.respawnDelaySeconds);
  }

  /**
   * Advances timers and objectives.
   *
   * `playerPosition` drives the objectives that depend on presence — securing a
   * drop, planting a charge, holding a sector — because all three are really
   * the same question: is the player inside the circle right now?
   */
  update(dt: number, playerPosition: THREE.Vector3): void {
    for (const mission of [...this.active]) {
      if (mission.status !== 'active') continue;

      mission.remaining -= dt;
      if (mission.remaining <= 0) {
        this.fail(mission, 'expired');
        continue;
      }

      const inside =
        Math.hypot(playerPosition.x - mission.spec.x, playerPosition.z - mission.spec.z) <=
        mission.spec.radiusMeters;
      if (inside) mission.visited = true;

      switch (mission.spec.objective) {
        case 'secure':
          // The drop is secured once the area is clear and the player is on it.
          if (inside && mission.enemiesAlive === 0) this.complete(mission);
          break;
        case 'plant':
        case 'hold':
          // Leaving the circle stops the clock but does not reset the work.
          if (inside) {
            mission.progress += dt;
            if (mission.progress >= mission.spec.progressSeconds) this.complete(mission);
          }
          break;
        case 'escort':
          // Reaching the safe zone with the prisoner is checked by the scene,
          // which is the only thing that knows where the prisoner ended up.
          break;
        default:
          break;
      }
    }

    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.top(DIRECTOR.minActive);
    } else if (this.active.length < DIRECTOR.minActive) {
      this.top(DIRECTOR.minActive);
    }
  }

  /** One line per job for the HUD tracker. */
  trackerLines(playerPosition: THREE.Vector3): string[] {
    return this.active.map((mission) => {
      const distance = Math.hypot(
        playerPosition.x - mission.spec.x,
        playerPosition.z - mission.spec.z,
      );
      const minutes = Math.floor(mission.remaining / 60);
      const seconds = Math.floor(mission.remaining % 60);
      const clock = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      const detail =
        mission.spec.progressSeconds > 0 && mission.progress > 0
          ? ` ${Math.floor((mission.progress / mission.spec.progressSeconds) * 100)}%`
          : mission.enemiesAlive > 0
            ? ` ${mission.enemiesAlive} hostis`
            : ' área limpa';
      return `${mission.spec.name} · ${(distance / 1000).toFixed(1)} km · ${clock}${detail} · $${mission.spec.reward}`;
    });
  }
}
