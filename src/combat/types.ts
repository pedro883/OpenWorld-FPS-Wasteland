import type * as THREE from 'three';
import ballisticsConfig from '../../config/ballistics.json';
import type { Zone } from '../entities/health';
import type { ZoneHealth } from '../entities/health';

export type MaterialName = keyof typeof ballisticsConfig.materials & string;

export interface MaterialDef {
  hardness: number;
  ricochetAngle: number;
  exitDamageFactor: number;
  decal: string;
}

const table = ballisticsConfig.materials as unknown as Record<string, MaterialDef>;

export function materialDef(name: string): MaterialDef {
  return table[name] ?? table.concrete!;
}

/** Anything a bullet can wound. */
export interface Damageable {
  readonly health: ZoneHealth;
  readonly isAlive: boolean;
  /** Feet position in world space. Named to avoid clashing with entity getters. */
  worldPosition(out: THREE.Vector3): THREE.Vector3;
  onDamaged(zone: Zone, amount: number, fromDirection: THREE.Vector3): void;
}

/**
 * What a collider represents to the combat system. Registered on the physics
 * world so a raycast hit resolves straight to gameplay meaning without any
 * scene-graph lookup.
 */
export type ColliderOwner =
  | { kind: 'surface'; material: string }
  | { kind: 'body'; entity: Damageable; zone: Zone; material?: string };

export function isBodyOwner(
  owner: unknown,
): owner is Extract<ColliderOwner, { kind: 'body' }> {
  return !!owner && typeof owner === 'object' && (owner as ColliderOwner).kind === 'body';
}

export function ownerMaterial(owner: unknown): string {
  if (!owner || typeof owner !== 'object') return 'concrete';
  const o = owner as ColliderOwner;
  if (o.kind === 'body') return o.material ?? 'flesh';
  return o.material;
}

export interface ShotEvent {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** Metres from the muzzle where the sound is centred, for AI hearing. */
  noiseRadius: number;
  suppressed: boolean;
}
