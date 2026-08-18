import itemConfig from '../../config/items.json';
import playerConfig from '../../config/player.json';

export type ItemCategory = 'ammo' | 'medical' | 'gear' | 'tool' | 'attachment' | 'valuable';

export interface ItemDef {
  id: string;
  name: string;
  category: ItemCategory;
  weightKg: number;
  value: number;
  stack: number;
  /** Ammo: which calibre this feeds, and how many rounds one unit is worth. */
  ammo?: string;
  rounds?: number;
  stopsBleeding?: boolean;
  healsZone?: number;
  /** Gear: extra carrying capacity, and damage soaked as a fraction. */
  carryBonusKg?: number;
  armour?: number;
  armourZones?: string[];
  fuelLitres?: number;
  repairs?: number;
  opensLocked?: boolean;
  attachment?: string;
}

export interface ItemStack {
  id: string;
  count: number;
}

const RAW = itemConfig.items as unknown as Record<string, Omit<ItemDef, 'id'>>;
const ITEMS = new Map<string, ItemDef>(
  Object.entries(RAW).map(([id, def]) => [id, { id, ...def }]),
);

export function itemDef(id: string): ItemDef | null {
  return ITEMS.get(id) ?? null;
}

export function allItemIds(): string[] {
  return [...ITEMS.keys()];
}

export function itemsOfCategory(category: ItemCategory): ItemDef[] {
  return [...ITEMS.values()].filter((item) => item.category === category);
}

/**
 * What the player is carrying, bounded by weight rather than by slot count.
 *
 * Weight is the whole point: a jerrycan is 15 kg and a rocket is 3, so hauling
 * fuel back to a vehicle genuinely costs the ammo you did not bring. Capacity
 * is the base load plus whatever backpack is in the bag.
 */
export class Inventory {
  private readonly stacks: ItemStack[] = [];

  constructor(private readonly baseCapacityKg = playerConfig.inventory.maxWeightKg) {}

  get capacityKg(): number {
    let bonus = 0;
    for (const stack of this.stacks) {
      const def = itemDef(stack.id);
      // Only one pack actually rides the back, so they do not stack up.
      if (def?.carryBonusKg) bonus = Math.max(bonus, def.carryBonusKg);
    }
    return this.baseCapacityKg + bonus;
  }

  get weightKg(): number {
    let total = 0;
    for (const stack of this.stacks) {
      total += (itemDef(stack.id)?.weightKg ?? 0) * stack.count;
    }
    return total;
  }

  get freeKg(): number {
    return Math.max(0, this.capacityKg - this.weightKg);
  }

  get isEmpty(): boolean {
    return this.stacks.length === 0;
  }

  list(): readonly ItemStack[] {
    return this.stacks;
  }

  count(id: string): number {
    let total = 0;
    for (const stack of this.stacks) if (stack.id === id) total += stack.count;
    return total;
  }

  has(id: string, count = 1): boolean {
    return this.count(id) >= count;
  }

  /**
   * Adds what fits and returns how many units actually went in.
   *
   * Partial success is deliberate: a container holding forty rounds when you
   * have room for ten should hand over the ten and leave the rest behind,
   * rather than refusing the whole pile.
   */
  add(id: string, count = 1): number {
    const def = itemDef(id);
    if (!def || count <= 0) return 0;
    const room = def.weightKg > 0 ? Math.floor(this.freeKg / def.weightKg) : count;
    let remaining = Math.min(count, room);
    const added = remaining;
    if (remaining <= 0) return 0;

    for (const stack of this.stacks) {
      if (stack.id !== id || stack.count >= def.stack) continue;
      const fits = Math.min(remaining, def.stack - stack.count);
      stack.count += fits;
      remaining -= fits;
      if (remaining <= 0) return added;
    }
    while (remaining > 0) {
      const size = Math.min(remaining, def.stack);
      this.stacks.push({ id, count: size });
      remaining -= size;
    }
    return added;
  }

  /** Removes up to `count` units, returning how many were actually taken. */
  remove(id: string, count = 1): number {
    let remaining = count;
    for (let i = this.stacks.length - 1; i >= 0 && remaining > 0; i--) {
      const stack = this.stacks[i]!;
      if (stack.id !== id) continue;
      const taken = Math.min(stack.count, remaining);
      stack.count -= taken;
      remaining -= taken;
      if (stack.count <= 0) this.stacks.splice(i, 1);
    }
    return count - remaining;
  }

  /** Damage multiplier for a zone, from whatever armour is being carried. */
  armourMultiplier(zone: string): number {
    let best = 0;
    for (const stack of this.stacks) {
      const def = itemDef(stack.id);
      if (!def?.armour) continue;
      if (def.armourZones && !def.armourZones.includes(zone)) continue;
      best = Math.max(best, def.armour);
    }
    return 1 - best;
  }

  /** Total sale value of everything carried, for the death screen. */
  get value(): number {
    let total = 0;
    for (const stack of this.stacks) total += (itemDef(stack.id)?.value ?? 0) * stack.count;
    return total;
  }

  clear(): void {
    this.stacks.length = 0;
  }

  toJSON(): ItemStack[] {
    return this.stacks.map((stack) => ({ ...stack }));
  }

  /** Restores a saved bag, skipping items that no longer exist in the catalogue. */
  load(stacks: readonly ItemStack[]): void {
    this.stacks.length = 0;
    for (const stack of stacks) {
      if (itemDef(stack.id) && stack.count > 0) this.stacks.push({ ...stack });
    }
  }
}
