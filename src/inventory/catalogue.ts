import itemConfig from '../../config/items.json';
import type { ItemBase } from './types';

/**
 * The one item catalogue.
 *
 * There were briefly two — the weight inventory's and the grid's — with
 * different ids for the same objects. Two names for one thing is guaranteed
 * debt: loot tables, the shop and every save already referenced the first set,
 * so the grid fields were folded into it rather than the other way round.
 */
const RAW = itemConfig.items as unknown as Record<string, Omit<ItemBase, 'id'>>;

const BASES = new Map<string, ItemBase>(
  Object.entries(RAW).map(([id, def]) => [
    id,
    {
      ...def,
      id,
      // Anything authored before the grid existed defaults to one cell rather
      // than to zero, which would make it unplaceable and invisible.
      width: def.width ?? 1,
      height: def.height ?? 1,
      tags: def.tags ?? [],
    },
  ]),
);

export function itemBase(id: string): ItemBase | null {
  return BASES.get(id) ?? null;
}

export function allBases(): ItemBase[] {
  return [...BASES.values()];
}

export function basesWithTag(tag: string): ItemBase[] {
  return allBases().filter((base) => base.tags.includes(tag as never));
}

/** Resolver shaped for `Grid` and `InventorySystem`. */
export const resolveBase = (id: string): ItemBase | null => itemBase(id);
