import lootConfig from '../../config/loot.json';
import { Random } from '../core/random';
import { itemDef, type ItemStack } from '../entities/inventory';

export interface LootEntry {
  item: string;
  weight: number;
  min: number;
  max: number;
}

export interface LootTier {
  name: string;
  rolls: [number, number];
  money: [number, number];
  entries: LootEntry[];
}

export interface LootRoll {
  items: ItemStack[];
  money: number;
}

const TIERS = lootConfig.tiers as unknown as Record<string, LootTier>;
const CORPSE = lootConfig.corpse as unknown as {
  rolls: [number, number];
  money: [number, number];
  tierBySkill: Record<string, string>;
};

export function lootTierIds(): string[] {
  return Object.keys(TIERS);
}

export function lootTier(id: string): LootTier | null {
  return TIERS[id] ?? null;
}

/**
 * Rolls a container's contents.
 *
 * The roll is a pure function of the generator, so a given container seeded
 * from its own id always holds the same thing — reopening it, or reloading the
 * save, cannot re-roll it into something better.
 */
export function rollLoot(tierId: string, rng: Random, rollsOverride?: [number, number]): LootRoll {
  const tier = TIERS[tierId];
  if (!tier) return { items: [], money: 0 };

  const [minRolls, maxRolls] = rollsOverride ?? tier.rolls;
  const rolls = rng.int(minRolls, maxRolls);
  const byItem = new Map<string, number>();

  for (let i = 0; i < rolls; i++) {
    const entry = rng.weighted(tier.entries);
    // A table that names an item the catalogue dropped should thin out, not
    // crash: the line is skipped and the roll is simply lost.
    if (!entry || !itemDef(entry.item)) continue;
    const count = rng.int(entry.min, entry.max);
    if (count <= 0) continue;
    byItem.set(entry.item, (byItem.get(entry.item) ?? 0) + count);
  }

  const [minMoney, maxMoney] = tier.money;
  return {
    items: [...byItem].map(([id, count]) => ({ id, count })),
    money: rng.int(minMoney, maxMoney),
  };
}

/** What an NPC of a given skill leaves behind. */
export function rollCorpseLoot(skill: string, rng: Random): LootRoll {
  const tierId = CORPSE.tierBySkill[skill] ?? 'civil';
  const roll = rollLoot(tierId, rng, CORPSE.rolls);
  const [minMoney, maxMoney] = CORPSE.money;
  return { items: roll.items, money: rng.int(minMoney, maxMoney) };
}

/** Total sale value of a roll, used to price mission rewards. */
export function lootValue(roll: LootRoll): number {
  let total = roll.money;
  for (const stack of roll.items) total += (itemDef(stack.id)?.value ?? 0) * stack.count;
  return total;
}
