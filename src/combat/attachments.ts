import attachmentConfig from '../../config/attachments.json';
import type { WeaponDef } from './arsenal';

export interface AttachmentDef {
  name: string;
  slot: string;
  model: string | null;
  mount?: number[];
  scale?: number;
  fitsClasses: string[];
  weightKg: number;

  adsFovDegrees?: number;
  adsSpeedMultiplier?: number;
  spreadAdsMultiplier?: number;
  spreadMultiplier?: number;
  spreadMovingMultiplier?: number;
  swayMultiplier?: number;
  recoilMultiplier?: number;
  noiseRadiusMultiplier?: number;
  muzzleVelocityMultiplier?: number;
  damageMultiplier?: number;
  reloadTimeMultiplier?: number;
  magazineBonus?: number;
  suppressed?: boolean;
}

const ATTACHMENTS = attachmentConfig.attachments as unknown as Record<string, AttachmentDef>;
const PRESETS = attachmentConfig.presets as unknown as Record<string, string[]>;

export function attachmentDef(id: string): AttachmentDef | null {
  return ATTACHMENTS[id] ?? null;
}

export function attachmentIds(): string[] {
  return Object.keys(ATTACHMENTS);
}

export function presetFor(weaponId: string): string[] {
  return PRESETS[weaponId] ?? [];
}

/** Attachments that physically fit a given weapon class. */
export function compatibleWith(weaponClass: string): AttachmentDef[] {
  return Object.values(ATTACHMENTS).filter((a) => a.fitsClasses.includes(weaponClass));
}

/**
 * Folds a set of attachments into a weapon definition.
 *
 * Every attachment changes real numbers — a suppressor cuts the noise radius to
 * 22%, which decides who walks over to look, and costs muzzle velocity and
 * damage for it. Returns a new definition; the base one is never mutated, so a
 * second weapon of the same type is unaffected.
 */
export function withAttachments(base: WeaponDef, ids: readonly string[]): WeaponDef {
  const applied = ids.map(attachmentDef).filter((a): a is AttachmentDef => a !== null);
  if (!applied.length) return base;

  const def: WeaponDef = {
    ...base,
    spread: { ...base.spread },
    recoil: { ...base.recoil },
    attachments: [...ids],
  };

  for (const a of applied) {
    if (a.slot && !a.fitsClasses.includes(base.class)) continue;

    if (a.adsFovDegrees !== undefined) def.adsFovDegrees = a.adsFovDegrees;
    if (a.spreadAdsMultiplier !== undefined) def.spread.adsMultiplier *= a.spreadAdsMultiplier;
    if (a.spreadMultiplier !== undefined) {
      def.spread.stand *= a.spreadMultiplier;
      def.spread.crouch *= a.spreadMultiplier;
      def.spread.prone *= a.spreadMultiplier;
    }
    if (a.spreadMovingMultiplier !== undefined) {
      def.spread.movingMultiplier *= a.spreadMovingMultiplier;
    }
    if (a.recoilMultiplier !== undefined) {
      def.recoil.verticalDegrees *= a.recoilMultiplier;
      def.recoil.horizontalDegrees *= a.recoilMultiplier;
    }
    if (a.noiseRadiusMultiplier !== undefined) {
      def.noiseRadiusMeters = Math.round(def.noiseRadiusMeters * a.noiseRadiusMultiplier);
    }
    if (a.muzzleVelocityMultiplier !== undefined) {
      def.muzzleVelocity = Math.round(def.muzzleVelocity * a.muzzleVelocityMultiplier);
    }
    if (a.damageMultiplier !== undefined) def.damage *= a.damageMultiplier;
    if (a.reloadTimeMultiplier !== undefined) {
      def.reloadTacticalSeconds *= a.reloadTimeMultiplier;
      def.reloadEmptySeconds *= a.reloadTimeMultiplier;
    }
    if (a.magazineBonus !== undefined) def.magazine += a.magazineBonus;
    if (a.suppressed) def.suppressed = true;
    def.weightKg += a.weightKg;
    if (a.swayMultiplier !== undefined) {
      def.attachmentSwayMultiplier = (def.attachmentSwayMultiplier ?? 1) * a.swayMultiplier;
    }
    if (a.adsSpeedMultiplier !== undefined) {
      def.attachmentAdsSpeed = (def.attachmentAdsSpeed ?? 1) * a.adsSpeedMultiplier;
    }
  }

  return def;
}

/** One-line summary for the HUD and the debug panel. */
export function describe(ids: readonly string[]): string {
  if (!ids.length) return 'sem acessórios';
  return ids
    .map((id) => attachmentDef(id)?.name ?? id)
    .join(' · ');
}
