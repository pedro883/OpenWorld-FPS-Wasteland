import weaponConfig from '../../config/weapons.json';

export type ProjectileKind = 'bullet' | 'rocket' | 'thrown' | 'flame' | 'melee';

export interface ExplosionDef {
  radiusMeters: number;
  damage: number;
  falloffPower: number;
  impulse: number;
  vehicleMultiplier: number;
}

export interface SpreadDef {
  stand: number;
  crouch: number;
  prone: number;
  adsMultiplier: number;
  movingMultiplier: number;
  jumpingMultiplier: number;
  perShotDegrees: number;
  maxDegrees: number;
}

export interface RecoilDef {
  verticalPattern: number[];
  horizontalPattern: number[];
  verticalDegrees: number;
  horizontalDegrees: number;
  recoverySeconds: number;
  recoveryFraction: number;
  viewKick: number;
  adsMultiplier: number;
}

export interface WeaponDef {
  id: string;
  name: string;
  class: string;
  model: string;
  ammo: string;
  slot: string;
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
  spread: SpreadDef;
  recoil: RecoilDef;
  projectile: ProjectileKind;
  pellets: number;
  pelletSpreadDegrees: number;
  suppressed: boolean;
  reloadPerShell: boolean;
  boltActionSeconds: number;
  adsFovDegrees: number | null;
  carried: number | null;
  fuseSeconds: number;
  throwSpeed: number;
  reachMeters: number;
  backstabMultiplier: number;
  explosion: ExplosionDef | null;
  smoke: { radiusMeters: number; seconds: number; blocksVisionFactor: number } | null;
  flash: { radiusMeters: number; blindSeconds: number; deafSeconds: number } | null;
  burn: { damagePerSecond: number; seconds: number } | null;
  underbarrel: string | null;
  viewmodel: Record<string, unknown> | null;
  /** Hotbar icon id, resolved from the model id. */
  icon: string;
  /** Attachment ids fitted to this instance. */
  attachments?: string[];
  /** Extra aim instability from optics, folded in by the viewmodel. */
  attachmentSwayMultiplier?: number;
  /** How much faster or slower the weapon comes up when aiming. */
  attachmentAdsSpeed?: number;
}

export interface AmmoTypeDef {
  name: string;
  startingReserve: number;
  maxReserve: number;
  icon: string;
}

const RAW_WEAPONS = weaponConfig.weapons as unknown as Record<string, Record<string, unknown>>;
const CLASS_DEFAULTS = weaponConfig.classDefaults as unknown as Record<
  string,
  Record<string, unknown>
>;
export const AMMO_TYPES = weaponConfig.ammoTypes as unknown as Record<string, AmmoTypeDef>;
export const LOADOUT = weaponConfig.loadout;
export const WEAPON_DEFAULTS = weaponConfig.defaults;

const cache = new Map<string, WeaponDef>();

/**
 * Resolves a weapon by layering its overrides on top of its class defaults.
 * Fifteen weapons that each repeated a full spread and recoil block would be
 * unmaintainable; the class layer is what keeps the config readable.
 */
export function weaponDef(id: string): WeaponDef {
  const cached = cache.get(id);
  if (cached) return cached;

  const raw = RAW_WEAPONS[id];
  if (!raw) throw new Error(`arma desconhecida em config/weapons.json: ${id}`);
  const base = CLASS_DEFAULTS[raw.class as string] ?? {};
  const merged = { ...base, ...raw } as Record<string, unknown>;
  // Nested blocks merge one level deep so a weapon can tweak a single number.
  merged.spread = { ...(base.spread as object), ...((raw.spread as object) ?? {}) };
  merged.recoil = { ...(base.recoil as object), ...((raw.recoil as object) ?? {}) };

  const model = merged.model as string;
  const def: WeaponDef = {
    id,
    name: merged.name as string,
    class: merged.class as string,
    model,
    ammo: merged.ammo as string,
    slot: (merged.slot as string) ?? 'primary',
    damage: (merged.damage as number) ?? 0,
    damageFalloff: (merged.damageFalloff as Array<[number, number]>) ?? [[0, 1]],
    muzzleVelocity: (merged.muzzleVelocity as number) ?? 400,
    penetration: (merged.penetration as number) ?? 0,
    rpm: (merged.rpm as number) ?? 300,
    fireModes: (merged.fireModes as string[]) ?? ['single'],
    burstCount: (merged.burstCount as number) ?? 3,
    magazine: (merged.magazine as number) ?? 1,
    reloadTacticalSeconds: (merged.reloadTacticalSeconds as number) ?? 2,
    reloadEmptySeconds: (merged.reloadEmptySeconds as number) ?? 2.6,
    zeroMeters: (merged.zeroMeters as number) ?? 100,
    noiseRadiusMeters: (merged.noiseRadiusMeters as number) ?? 200,
    weightKg: (merged.weightKg as number) ?? 3,
    spread: merged.spread as SpreadDef,
    recoil: merged.recoil as RecoilDef,
    projectile: (merged.projectile as ProjectileKind) ?? 'bullet',
    pellets: (merged.pellets as number) ?? 1,
    pelletSpreadDegrees: (merged.pelletSpreadDegrees as number) ?? 0,
    suppressed: (merged.suppressed as boolean) ?? false,
    reloadPerShell: (merged.reloadPerShell as boolean) ?? false,
    boltActionSeconds: (merged.boltActionSeconds as number) ?? 0,
    adsFovDegrees: (merged.adsFovDegrees as number) ?? null,
    carried: (merged.carried as number) ?? null,
    fuseSeconds: (merged.fuseSeconds as number) ?? 3,
    throwSpeed: (merged.throwSpeed as number) ?? 18,
    reachMeters: (merged.reachMeters as number) ?? 2,
    backstabMultiplier: (merged.backstabMultiplier as number) ?? 1,
    explosion: (merged.explosion as ExplosionDef) ?? null,
    smoke: (merged.smoke as WeaponDef['smoke']) ?? null,
    flash: (merged.flash as WeaponDef['flash']) ?? null,
    burn: (merged.burn as WeaponDef['burn']) ?? null,
    underbarrel: (merged.underbarrel as string) ?? null,
    viewmodel: (merged.viewmodel as Record<string, unknown>) ?? null,
    // Some variants share a silhouette with their base model and have no sprite
    // of their own (sniperSand reuses sniper); config names the fallback.
    icon: (merged.icon as string) ?? model,
  };
  cache.set(id, def);
  return def;
}

export function allWeaponIds(): string[] {
  return Object.keys(RAW_WEAPONS);
}

/**
 * Reserve ammunition, pooled by calibre. Two 9 mm weapons share one pool, which
 * is what makes picking up a second SMG meaningful rather than free.
 */
export class AmmoPouch {
  private readonly reserves = new Map<string, number>();
  /** Thrown weapons carry discrete counts rather than a calibre pool. */
  private readonly carried = new Map<string, number>();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.reserves.clear();
    for (const [id, type] of Object.entries(AMMO_TYPES)) {
      this.reserves.set(id, type.startingReserve);
    }
    this.carried.clear();
    for (const id of allWeaponIds()) {
      const def = weaponDef(id);
      if (def.carried !== null) this.carried.set(id, def.carried);
    }
  }

  reserve(def: WeaponDef): number {
    if (def.carried !== null) return this.carried.get(def.id) ?? 0;
    return this.reserves.get(def.ammo) ?? 0;
  }

  /** Removes up to `wanted` rounds, returning how many were actually available. */
  take(def: WeaponDef, wanted: number): number {
    const available = this.reserve(def);
    const taken = Math.max(0, Math.min(wanted, available));
    if (taken === 0) return 0;
    if (def.carried !== null) this.carried.set(def.id, available - taken);
    else this.reserves.set(def.ammo, available - taken);
    return taken;
  }

  add(def: WeaponDef, amount: number): number {
    if (def.carried !== null) {
      const next = (this.carried.get(def.id) ?? 0) + amount;
      this.carried.set(def.id, next);
      return next;
    }
    const type = AMMO_TYPES[def.ammo];
    const capacity = type?.maxReserve ?? 0;
    const next = Math.min(capacity, (this.reserves.get(def.ammo) ?? 0) + amount);
    this.reserves.set(def.ammo, next);
    return next;
  }

  refillAll(): void {
    this.reset();
  }

  get debugText(): string {
    return [...this.reserves.entries()]
      .filter(([id]) => id !== 'none')
      .map(([id, n]) => `${AMMO_TYPES[id]?.name ?? id}: ${n}`)
      .join('  ');
  }
}
