import { Player as PlayerCfg } from '../core/config';

export const ZONES = ['head', 'torso', 'armLeft', 'armRight', 'legLeft', 'legRight'] as const;
export type Zone = (typeof ZONES)[number];

/** Maps a glTF node name from the Kenney rig onto a damage zone. */
const NODE_TO_ZONE: Record<string, Zone> = {
  head: 'head',
  'head-mesh': 'head',
  torso: 'torso',
  'body-mesh': 'torso',
  root: 'torso',
  'arm-left': 'armLeft',
  'arm-right': 'armRight',
  'leg-left': 'legLeft',
  'leg-right': 'legRight',
};

export function zoneForNode(name: string): Zone {
  return NODE_TO_ZONE[name] ?? 'torso';
}

interface ZoneState {
  hp: number;
  max: number;
  multiplier: number;
  bleeding: boolean;
}

export interface DamageResult {
  applied: number;
  zone: Zone;
  killed: boolean;
  /** True when this hit took the zone out of action (broken limb / headshot). */
  disabled: boolean;
}

const cfg = PlayerCfg.health;

/**
 * Per-limb health. Head and torso are lethal; limbs degrade capability instead
 * of killing — a broken leg slows you, a broken arm ruins your aim, and heavy
 * hits open a bleed that drains the torso until bandaged.
 */
export class ZoneHealth {
  private readonly zones = {} as Record<Zone, ZoneState>;
  private bleedTimer = 0;
  alive = true;

  constructor(scale = 1) {
    for (const zone of ZONES) {
      const z = cfg.zones[zone];
      this.zones[zone] = {
        hp: z.max * scale,
        max: z.max * scale,
        multiplier: z.damageMultiplier,
        bleeding: false,
      };
    }
  }

  get(zone: Zone): Readonly<ZoneState> {
    return this.zones[zone];
  }

  fraction(zone: Zone): number {
    const z = this.zones[zone];
    return z.max > 0 ? z.hp / z.max : 0;
  }

  /** Overall condition, driven by the lethal zones. */
  get vitality(): number {
    return Math.min(this.fraction('head'), this.fraction('torso'));
  }

  get isBleeding(): boolean {
    return ZONES.some((z) => this.zones[z].bleeding);
  }

  get brokenLimbs(): Zone[] {
    return ZONES.filter((z) => z !== 'head' && z !== 'torso' && this.zones[z].hp <= 0);
  }

  /** Legs gone means crawling pace; one leg is a limp. */
  get speedMultiplier(): number {
    const broken = this.brokenLimbs.filter((z) => z === 'legLeft' || z === 'legRight').length;
    if (broken === 0) return 1;
    return broken === 1 ? cfg.brokenLegSpeedMultiplier : cfg.brokenLegSpeedMultiplier * 0.6;
  }

  /** A wounded arm makes the weapon wander. */
  get swayMultiplier(): number {
    const broken = this.brokenLimbs.filter((z) => z === 'armLeft' || z === 'armRight').length;
    return broken === 0 ? 1 : cfg.brokenArmSwayMultiplier ** broken;
  }

  applyDamage(zone: Zone, amount: number): DamageResult {
    if (!this.alive) return { applied: 0, zone, killed: false, disabled: false };

    const state = this.zones[zone];
    const applied = amount * state.multiplier;
    const wasUp = state.hp > 0;
    state.hp = Math.max(0, state.hp - applied);

    // Big hits open a bleed; the chance scales with how much of the zone went.
    const severity = Math.min(1, applied / state.max);
    if (!state.bleeding && Math.random() < severity * cfg.bleedChanceAtFullDamage) {
      state.bleeding = true;
    }

    if ((zone === 'head' || zone === 'torso') && state.hp <= 0) this.alive = false;

    return {
      applied,
      zone,
      killed: !this.alive,
      disabled: wasUp && state.hp <= 0,
    };
  }

  /** Bleeding drains the torso, so an untreated limb wound is still lethal. */
  update(dt: number): void {
    if (!this.alive) return;
    const bleeds = ZONES.filter((z) => this.zones[z].bleeding).length;
    if (!bleeds) return;
    this.bleedTimer += dt;
    const torso = this.zones.torso;
    torso.hp = Math.max(0, torso.hp - cfg.bleedDamagePerSecond * bleeds * dt);
    if (torso.hp <= 0) this.alive = false;
  }

  /** A bandage stops one bleed and restores part of the worst zone. */
  bandage(): boolean {
    const bleeding = ZONES.find((z) => this.zones[z].bleeding);
    if (bleeding) this.zones[bleeding].bleeding = false;

    let worst: Zone | null = null;
    for (const zone of ZONES) {
      const z = this.zones[zone];
      if (z.hp >= z.max) continue;
      if (!worst || this.fraction(zone) < this.fraction(worst)) worst = zone;
    }
    if (worst) {
      const z = this.zones[worst];
      z.hp = Math.min(z.max, z.hp + cfg.bandageHealPerZone);
    }
    return !!bleeding || !!worst;
  }

  reset(): void {
    for (const zone of ZONES) {
      const z = this.zones[zone];
      z.hp = z.max;
      z.bleeding = false;
    }
    this.alive = true;
    this.bleedTimer = 0;
  }

  get debugText(): string {
    const rows = ZONES.map((zone) => {
      const z = this.zones[zone];
      const bar = '#'.repeat(Math.round(this.fraction(zone) * 10)).padEnd(10, '.');
      return `${zone.padEnd(8)} ${bar} ${z.hp.toFixed(0).padStart(3)}${z.bleeding ? ' SANGRA' : ''}`;
    });
    return rows.join('\n');
  }
}
