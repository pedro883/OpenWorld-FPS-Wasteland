import { describe, expect, it } from 'vitest';
import { Inventory, itemDef } from '../src/entities/inventory';
import { buy, offerFor, sellAllValuables, sellItem, shopOffers, type ShopContext } from '../src/economy/shop';
import { Wallet } from '../src/economy/wallet';

function context(overrides: Partial<ShopContext> = {}): ShopContext {
  const owned = new Set<string>();
  return {
    wallet: new Wallet(1000, 200),
    inventory: new Inventory(100),
    inSafeZone: true,
    ownsWeapon: (id) => owned.has(id),
    grantWeapon: (id) => void owned.add(id),
    grantVehicle: () => true,
    ...overrides,
  };
}

describe('carteira', () => {
  it('morrer leva o bolso e deixa o banco', () => {
    const wallet = new Wallet(800, 350);
    expect(wallet.die()).toBe(350);
    expect(wallet.carried).toBe(0);
    expect(wallet.bank).toBe(800);
  });

  it('depositar move o bolso para o banco', () => {
    const wallet = new Wallet(100, 250);
    expect(wallet.deposit()).toBe(250);
    expect(wallet.bank).toBe(350);
    expect(wallet.carried).toBe(0);
  });

  it('não deposita mais do que se está carregando', () => {
    const wallet = new Wallet(0, 40);
    expect(wallet.deposit(999)).toBe(40);
    expect(wallet.bank).toBe(40);
  });

  it('gasta primeiro o que está em risco', () => {
    // Spending the pocket first is what the player would do by hand.
    const wallet = new Wallet(1000, 300);
    expect(wallet.spend(500)).toBe(true);
    expect(wallet.carried).toBe(0);
    expect(wallet.bank).toBe(800);
  });

  it('recusa a compra que não cabe no total', () => {
    const wallet = new Wallet(100, 50);
    expect(wallet.spend(200)).toBe(false);
    expect(wallet.total).toBe(150);
  });

  it('ganho entra no bolso e conta para as estatísticas', () => {
    const wallet = new Wallet(0, 0);
    wallet.earn(120);
    expect(wallet.carried).toBe(120);
    expect(wallet.bank).toBe(0);
    expect(wallet.earned).toBe(120);
  });
});

describe('arsenal', () => {
  it('todo item e arma do estoque tem preço', () => {
    for (const offer of shopOffers()) {
      expect(offer.price, offer.id).toBeGreaterThan(0);
      expect(offer.name.length, offer.id).toBeGreaterThan(0);
    }
  });

  it('compra debita e entrega', () => {
    const ctx = context();
    const antes = ctx.wallet.total;
    expect(buy(ctx, 'item', 'bandage')).toBe('ok');
    expect(ctx.inventory.count('bandage')).toBe(1);
    expect(ctx.wallet.total).toBe(antes - itemDef('bandage')!.value);
  });

  it('não vende fora da zona segura', () => {
    const ctx = context({ inSafeZone: false });
    expect(buy(ctx, 'item', 'bandage')).toBe('foraDaZona');
    expect(ctx.inventory.count('bandage')).toBe(0);
  });

  it('sem dinheiro não compra nem debita', () => {
    const ctx = context({ wallet: new Wallet(0, 0) });
    expect(buy(ctx, 'weapon', 'sniper_tr8')).toBe('semDinheiro');
    expect(ctx.wallet.total).toBe(0);
  });

  it('mochila cheia não engole o dinheiro', () => {
    // Nothing is charged until the goods are known to fit.
    const ctx = context({ inventory: new Inventory(0.5) });
    const antes = ctx.wallet.total;
    expect(buy(ctx, 'item', 'jerrycan')).toBe('semEspaco');
    expect(ctx.wallet.total).toBe(antes);
  });

  it('não vende a mesma arma duas vezes', () => {
    const ctx = context({ wallet: new Wallet(9000, 0) });
    expect(buy(ctx, 'weapon', 'rifle_m4x')).toBe('ok');
    expect(buy(ctx, 'weapon', 'rifle_m4x')).toBe('indisponivel');
  });

  it('veículo que não pôde ser entregue devolve o dinheiro', () => {
    const ctx = context({ wallet: new Wallet(9000, 0), grantVehicle: () => false });
    const antes = ctx.wallet.total;
    expect(buy(ctx, 'vehicle', 'hatch')).toBe('semEspaco');
    expect(ctx.wallet.total).toBe(antes);
  });

  it('vender rende menos do que comprar custou', () => {
    const ctx = context();
    ctx.inventory.add('gold_watch', 1);
    const pago = sellItem(ctx, 'gold_watch', 1);
    expect(pago).toBeGreaterThan(0);
    expect(pago).toBeLessThan(itemDef('gold_watch')!.value);
    expect(ctx.inventory.count('gold_watch')).toBe(0);
  });

  it('vender tudo esvazia só os itens de valor', () => {
    const ctx = context();
    ctx.inventory.add('gold_watch', 2);
    ctx.inventory.add('scrap', 3);
    ctx.inventory.add('bandage', 2);
    expect(sellAllValuables(ctx)).toBeGreaterThan(0);
    expect(ctx.inventory.count('gold_watch')).toBe(0);
    expect(ctx.inventory.count('scrap')).toBe(0);
    expect(ctx.inventory.count('bandage')).toBe(2);
  });

  it('não vende o que não se tem', () => {
    const ctx = context();
    expect(sellItem(ctx, 'gold_watch', 1)).toBe(0);
  });

  it('oferta desconhecida não quebra a loja', () => {
    expect(offerFor('item', 'nao_existe')).toBeNull();
    expect(buy(context(), 'weapon', 'nao_existe')).toBe('indisponivel');
  });
});
