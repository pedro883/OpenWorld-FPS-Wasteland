import { Random } from '../core/random';
import {
  DIRECTOR,
  MISSION_TYPES,
  type MissionSpec,
  type MissionTypeDef,
} from './types';

export interface MissionPlace {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  radius: number;
}

export interface MissionRoad {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface MissionWorld {
  pois: MissionPlace[];
  roads: MissionRoad[];
  /** Half-width of the playable square, in metres. */
  halfExtent: number;
  /** Where the player started, so distance can price the job. */
  homeX: number;
  homeZ: number;
}

/** A spot a mission could occupy, plus how it should be labelled. */
interface Candidate {
  x: number;
  z: number;
  placeName: string;
}

function distance(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function poiCandidate(type: MissionTypeDef, world: MissionWorld, rng: Random): Candidate | null {
  const allowed = type.poiKinds?.length
    ? world.pois.filter((poi) => type.poiKinds!.includes(poi.kind))
    : world.pois;
  const poi = rng.pick(allowed.length ? allowed : world.pois);
  if (!poi) return null;
  // Offset inside the POI so two missions on the same place do not overlap.
  const angle = rng.range(0, Math.PI * 2);
  const radius = poi.radius * rng.range(0, 0.35);
  return {
    x: poi.x + Math.cos(angle) * radius,
    z: poi.z + Math.sin(angle) * radius,
    placeName: poi.name,
  };
}

function roadCandidate(world: MissionWorld, rng: Random): Candidate | null {
  const road = rng.pick(world.roads);
  if (!road) return null;
  // Away from the endpoints, so a convoy is caught in the open rather than
  // parked inside a POI that already has its own garrison.
  const t = rng.range(0.25, 0.75);
  return {
    x: road.ax + (road.bx - road.ax) * t,
    z: road.az + (road.bz - road.az) * t,
    placeName: 'Estrada',
  };
}

function wildernessCandidate(world: MissionWorld, rng: Random): Candidate {
  const limit = world.halfExtent * 0.82;
  return {
    x: rng.range(-limit, limit),
    z: rng.range(-limit, limit),
    placeName: 'Campo aberto',
  };
}

function candidateFor(type: MissionTypeDef, world: MissionWorld, rng: Random): Candidate | null {
  if (type.location === 'poi') return poiCandidate(type, world, rng);
  if (type.location === 'road') return roadCandidate(world, rng) ?? poiCandidate(type, world, rng);
  return wildernessCandidate(world, rng);
}

/**
 * Builds one mission.
 *
 * `taken` holds the missions already on the board: a new one is pushed away
 * from them, because three jobs stacked on the same hillside read as one long
 * fight rather than as three choices. When no spread-out spot turns up in a
 * handful of tries the last candidate is used anyway — a mission slightly too
 * close is better than an empty board.
 */
export function generateMission(
  rng: Random,
  world: MissionWorld,
  taken: readonly MissionSpec[] = [],
  typeFilter?: string,
): MissionSpec | null {
  const pool = typeFilter ? MISSION_TYPES.filter((t) => t.id === typeFilter) : MISSION_TYPES;
  const type = rng.pick(pool);
  if (!type) return null;

  let candidate: Candidate | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const next = candidateFor(type, world, rng);
    if (!next) continue;
    candidate = next;
    const clash = taken.some(
      (other) => distance(next.x, next.z, other.x, other.z) < DIRECTOR.minSpacingMeters,
    );
    if (!clash) break;
  }
  if (!candidate) return null;

  const fromHome = distance(candidate.x, candidate.z, world.homeX, world.homeZ) / 1000;
  const reward = Math.round(
    type.difficulty * DIRECTOR.rewardPerDifficulty + fromHome * DIRECTOR.distanceBonusPerKm,
  );

  return {
    id: `${type.id}-${rng.int(100000, 999999)}`,
    type: type.id,
    name: type.name,
    brief: type.brief,
    objective: type.objective,
    difficulty: type.difficulty,
    x: candidate.x,
    z: candidate.z,
    radiusMeters: type.radiusMeters,
    timerSeconds: type.timerSeconds,
    reward,
    lootTier: type.lootTier,
    lootCaches: type.lootCaches,
    enemyCount: rng.int(type.enemies.count[0], type.enemies.count[1]),
    enemySkill: type.enemies.skill,
    vehicles: type.vehicles ?? 0,
    progressSeconds: type.plantSeconds ?? type.holdSeconds ?? 0,
    placeName: candidate.placeName,
  };
}

/** Fills the board up to `count` missions, keeping the existing ones. */
export function fillBoard(
  rng: Random,
  world: MissionWorld,
  existing: readonly MissionSpec[],
  count: number,
): MissionSpec[] {
  const board = [...existing];
  let guard = 0;
  while (board.length < count && guard++ < count * 12) {
    const mission = generateMission(rng, world, board);
    if (!mission) break;
    board.push(mission);
  }
  return board;
}
