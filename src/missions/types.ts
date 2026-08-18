import missionConfig from '../../config/missions.json';

export type MissionObjective = 'eliminate' | 'assassinate' | 'secure' | 'plant' | 'escort' | 'hold';
export type MissionLocationKind = 'poi' | 'road' | 'wilderness';
export type MissionStatus = 'active' | 'completed' | 'failed' | 'expired';

export interface MissionTypeDef {
  id: string;
  name: string;
  brief: string;
  /** 1–5; drives both the reward and how hard the garrison hits. */
  difficulty: number;
  location: MissionLocationKind;
  poiKinds?: string[];
  radiusMeters: number;
  timerSeconds: number;
  enemies: { count: [number, number]; skill: string };
  objective: MissionObjective;
  lootTier: string;
  lootCaches: number;
  vehicles?: number;
  plantSeconds?: number;
  holdSeconds?: number;
  waves?: number;
}

/** One generated mission, before anything of it exists in the world. */
export interface MissionSpec {
  id: string;
  type: string;
  name: string;
  brief: string;
  objective: MissionObjective;
  difficulty: number;
  x: number;
  z: number;
  radiusMeters: number;
  timerSeconds: number;
  reward: number;
  lootTier: string;
  lootCaches: number;
  enemyCount: number;
  enemySkill: string;
  vehicles: number;
  /** Seconds of planting or holding the objective asks for, when it does. */
  progressSeconds: number;
  /** Where the place is called, for the map and the tracker. */
  placeName: string;
}

export const DIRECTOR = missionConfig.director;

const RAW_TYPES = missionConfig.types as unknown as Record<string, Omit<MissionTypeDef, 'id'>>;

export const MISSION_TYPES: MissionTypeDef[] = Object.entries(RAW_TYPES).map(([id, def]) => ({
  id,
  ...def,
}));

export function missionType(id: string): MissionTypeDef | null {
  return MISSION_TYPES.find((type) => type.id === id) ?? null;
}
