import economy from '../../config/economy.json';
import vehicleConfig from '../../config/vehicles.json';
import { weaponDef } from '../combat/arsenal';
import { Inventory, itemDef } from '../entities/inventory';
import type { PurchaseResult, Wallet } from './wallet';

export type OfferKind = 'weapon' | 'item' | 'vehicle';

export interface Offer {
  kind: OfferKind;
  id: string;
  name: string;
  price: number;
  /** Weight of one unit, so the shop can warn before the bag refuses it. */
  weightKg: number;
  detail: string;
}

const WEAPON_PRICES = economy.weaponPrices as Record<string, number>;
const VEHICLE_PRICES = economy.vehiclePrices as Record<string, number>;
const VEHICLE_TYPES = vehicleConfig.types as unknown as Record<string, { name: string }>;

function weaponOffer(id: string): Offer | null {
  const price = WEAPON_PRICES[id];
  if (price === undefined) return null;
  const def = weaponDef(id);
  return {
    kind: 'weapon',
    id,
    name: def.name ?? id,
    price,
    weightKg: 0,
    detail: def.slot ?? '',
  };
}

function itemOffer(id: string): Offer | null {
  const def = itemDef(id);
  if (!def) return null;
  return {
    kind: 'item',
    id,
    name: def.name,
    price: def.value,
    weightKg: def.weightKg,
    detail: `${def.weightKg.toFixed(2)} kg`,
  };
}

function vehicleOffer(id: string): Offer | null {
  const price = VEHICLE_PRICES[id];
  if (price === undefined) return null;
  return {
    kind: 'vehicle',
    id,
    name: VEHICLE_TYPES[id]?.name ?? id,
    price,
    weightKg: 0,
    detail: 'entregue na zona segura',
  };
}

/** Everything the arsenal has on the shelf, in the order it is shown. */
export function shopOffers(): Offer[] {
  const offers: Offer[] = [];
  for (const id of economy.stock.weapons) {
    const offer = weaponOffer(id);
    if (offer) offers.push(offer);
  }
  for (const id of economy.stock.items) {
    const offer = itemOffer(id);
    if (offer) offers.push(offer);
  }
  for (const id of economy.stock.vehicles) {
    const offer = vehicleOffer(id);
    if (offer) offers.push(offer);
  }
  return offers;
}

export function offerFor(kind: OfferKind, id: string): Offer | null {
  if (kind === 'weapon') return weaponOffer(id);
  if (kind === 'vehicle') return vehicleOffer(id);
  return itemOffer(id);
}

export interface ShopContext {
  wallet: Wallet;
  inventory: Inventory;
  /** Buying is only possible standing in the safe zone. */
  inSafeZone: boolean;
  ownsWeapon(id: string): boolean;
  grantWeapon(id: string): void;
  grantVehicle(id: string): boolean;
}

/**
 * Buys one unit.
 *
 * The order of the checks matters: nothing is charged until the goods are known
 * to fit, so a full bag can never eat the money.
 */
export function buy(ctx: ShopContext, kind: OfferKind, id: string): PurchaseResult {
  const offer = offerFor(kind, id);
  if (!offer) return 'indisponivel';
  if (!ctx.inSafeZone) return 'foraDaZona';
  if (!ctx.wallet.canAfford(offer.price)) return 'semDinheiro';

  if (kind === 'item') {
    const def = itemDef(id)!;
    if (ctx.inventory.freeKg < def.weightKg) return 'semEspaco';
    ctx.wallet.spend(offer.price);
    ctx.inventory.add(id, 1);
    return 'ok';
  }

  if (kind === 'weapon') {
    if (ctx.ownsWeapon(id)) return 'indisponivel';
    ctx.wallet.spend(offer.price);
    ctx.grantWeapon(id);
    return 'ok';
  }

  // Vehicles are delivered rather than carried, so they can fail on space too.
  ctx.wallet.spend(offer.price);
  if (!ctx.grantVehicle(id)) {
    ctx.wallet.earn(offer.price);
    return 'semEspaco';
  }
  return 'ok';
}

/** Sells one unit out of the bag, at a fraction of its value. */
export function sellItem(ctx: ShopContext, id: string, count = 1): number {
  const def = itemDef(id);
  if (!def || !ctx.inSafeZone) return 0;
  const sold = ctx.inventory.remove(id, count);
  if (sold <= 0) return 0;
  const paid = Math.round(def.value * economy.sellFraction) * sold;
  ctx.wallet.earn(paid);
  return paid;
}

/** Sells everything in the `valuable` category, which is what loot runs are for. */
export function sellAllValuables(ctx: ShopContext): number {
  let total = 0;
  for (const stack of [...ctx.inventory.list()]) {
    if (itemDef(stack.id)?.category === 'valuable') {
      total += sellItem(ctx, stack.id, stack.count);
    }
  }
  return total;
}

export const SELL_FRACTION = economy.sellFraction;
export const SAFE_ZONE = economy.safeZone;
