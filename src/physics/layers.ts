/**
 * Rapier packs collision filtering into one u32: the high 16 bits are the
 * groups a collider belongs to, the low 16 bits are the groups it interacts
 * with. `groups()` builds that word so call sites never do the shifting.
 */
export const Layer = {
  TERRAIN: 1 << 0,
  STATIC: 1 << 1,
  PLAYER: 1 << 2,
  NPC: 1 << 3,
  VEHICLE: 1 << 4,
  PROJECTILE: 1 << 5,
  DEBRIS: 1 << 6,
  TRIGGER: 1 << 7,
  /**
   * Per-zone damage boxes. Kept separate from PLAYER/NPC so that bullets test
   * the precise hitboxes and pass straight through the coarse movement capsule
   * — otherwise the capsule always wins the raycast and every hit is a torso.
   */
  HITBOX: 1 << 8,
} as const;

export type LayerMask = number;

export function groups(membership: LayerMask, filter: LayerMask): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const WORLD_SOLID = Layer.TERRAIN | Layer.STATIC;
/** What a bullet is allowed to hit: world geometry, damage zones, vehicles. */
export const BULLET_FILTER = WORLD_SOLID | Layer.HITBOX | Layer.VEHICLE;
/** What blocks line of sight for AI perception. */
export const SIGHT_BLOCKERS = WORLD_SOLID | Layer.VEHICLE;
