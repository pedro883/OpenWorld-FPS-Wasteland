import { describe, expect, it } from 'vitest';
import { Random, hashSeed } from '../src/core/random';
import { Inventory, itemDef } from '../src/entities/inventory';
import { lootTier, lootTierIds, lootValue, rollCorpseLoot, rollLoot } from '../src/loot/lootTable';

describe('gerador determinístico', () => {
  it('a mesma semente dá a mesma sequência', () => {
    const a = new Random(1234);
    const b = new Random(1234);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('sementes diferentes divergem', () => {
    expect(new Random(1).next()).not.toBe(new Random(2).next());
  });

  it('semente zero não trava o gerador', () => {
    // Zero is a fixed point of mulberry32 if it is allowed through as state.
    const rng = new Random(0);
    const values = new Set(Array.from({ length: 5 }, () => rng.next()));
    expect(values.size).toBe(5);
  });

  it('int respeita os dois extremos', () => {
    const rng = new Random(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(3, 5));
    expect([...seen].sort()).toEqual([3, 4, 5]);
  });

  it('peso zero nunca é sorteado', () => {
    const rng = new Random(7);
    const entries = [
      { id: 'nunca', weight: 0 },
      { id: 'sempre', weight: 5 },
    ];
    for (let i = 0; i < 200; i++) expect(rng.weighted(entries)?.id).toBe('sempre');
  });

  it('respeita a proporção dos pesos', () => {
    const rng = new Random(42);
    const entries = [
      { id: 'raro', weight: 1 },
      { id: 'comum', weight: 9 },
    ];
    let comuns = 0;
    for (let i = 0; i < 4000; i++) if (rng.weighted(entries)?.id === 'comum') comuns++;
    expect(comuns / 4000).toBeGreaterThan(0.85);
    expect(comuns / 4000).toBeLessThan(0.95);
  });

  it('hashSeed é estável e distingue nomes', () => {
    expect(hashSeed('vila')).toBe(hashSeed('vila'));
    expect(hashSeed('vila')).not.toBe(hashSeed('base'));
  });
});

describe('tabelas de loot', () => {
  it('todo item citado nas tabelas existe no catálogo', () => {
    for (const id of lootTierIds()) {
      for (const entry of lootTier(id)!.entries) {
        expect(itemDef(entry.item), `${id} → ${entry.item}`).not.toBeNull();
      }
    }
  });

  it('o mesmo contêiner sorteia sempre o mesmo conteúdo', () => {
    const a = rollLoot('militar', new Random(hashSeed('caixa-3')));
    const b = rollLoot('militar', new Random(hashSeed('caixa-3')));
    expect(a).toEqual(b);
  });

  it('contêineres diferentes sorteiam conteúdos diferentes', () => {
    const rolls = new Set<string>();
    for (let i = 0; i < 20; i++) {
      rolls.add(JSON.stringify(rollLoot('civil', new Random(hashSeed(`caixa-${i}`)))));
    }
    expect(rolls.size).toBeGreaterThan(10);
  });

  it('o tier militar vale mais que o civil', () => {
    const media = (tier: string) => {
      let total = 0;
      for (let i = 0; i < 300; i++) total += lootValue(rollLoot(tier, new Random(i)));
      return total / 300;
    };
    expect(media('militar')).toBeGreaterThan(media('policial'));
    expect(media('policial')).toBeGreaterThan(media('civil'));
  });

  it('um tier inexistente devolve vazio em vez de quebrar', () => {
    expect(rollLoot('inexistente', new Random(1))).toEqual({ items: [], money: 0 });
  });

  it('nunca devolve pilha de contagem zero', () => {
    for (let i = 0; i < 200; i++) {
      for (const stack of rollLoot('policial', new Random(i)).items) {
        expect(stack.count).toBeGreaterThan(0);
      }
    }
  });

  it('corpo de veterano rende mais que o de recruta', () => {
    const media = (skill: string) => {
      let total = 0;
      for (let i = 0; i < 300; i++) total += lootValue(rollCorpseLoot(skill, new Random(i)));
      return total / 300;
    };
    expect(media('veteran')).toBeGreaterThan(media('recruit'));
  });
});

describe('inventário por peso', () => {
  it('aceita o que cabe e recusa o resto', () => {
    const inv = new Inventory(2);
    // A rocket is 3.2 kg, so not one fits in a two-kilo bag.
    expect(inv.add('ammo_rocket', 1)).toBe(0);
    expect(inv.add('bandage', 100)).toBe(Math.floor(2 / itemDef('bandage')!.weightKg));
  });

  it('entrega parcialmente em vez de recusar a pilha inteira', () => {
    const inv = new Inventory(1);
    const cabem = Math.floor(1 / itemDef('ammo_9mm')!.weightKg);
    expect(inv.add('ammo_9mm', 50)).toBe(cabem);
    expect(inv.count('ammo_9mm')).toBe(cabem);
  });

  it('respeita o tamanho máximo da pilha', () => {
    const inv = new Inventory(500);
    inv.add('bandage', 20);
    const def = itemDef('bandage')!;
    for (const stack of inv.list()) expect(stack.count).toBeLessThanOrEqual(def.stack);
    expect(inv.count('bandage')).toBe(20);
  });

  it('a mochila aumenta a capacidade', () => {
    const inv = new Inventory(32);
    expect(inv.capacityKg).toBe(32);
    inv.add('backpack_large', 1);
    expect(inv.capacityKg).toBe(32 + itemDef('backpack_large')!.carryBonusKg!);
  });

  it('duas mochilas não somam: só uma vai nas costas', () => {
    const inv = new Inventory(32);
    inv.add('backpack_small', 1);
    inv.add('backpack_large', 1);
    expect(inv.capacityKg).toBe(32 + itemDef('backpack_large')!.carryBonusKg!);
  });

  it('remover devolve quanto saiu de verdade', () => {
    const inv = new Inventory(100);
    inv.add('scrap', 5);
    expect(inv.remove('scrap', 9)).toBe(5);
    expect(inv.count('scrap')).toBe(0);
    expect(inv.isEmpty).toBe(true);
  });

  it('o colete reduz o dano e o capacete só vale para a cabeça', () => {
    const inv = new Inventory(100);
    expect(inv.armourMultiplier('torso')).toBe(1);
    inv.add('vest_heavy', 1);
    expect(inv.armourMultiplier('torso')).toBeCloseTo(0.55);
    inv.clear();
    inv.add('helmet', 1);
    expect(inv.armourMultiplier('head')).toBeCloseTo(0.65);
    expect(inv.armourMultiplier('legLeft')).toBe(1);
  });

  it('sobrevive a um save com itens que não existem mais', () => {
    const inv = new Inventory(100);
    inv.load([{ id: 'item_que_sumiu', count: 3 }, { id: 'scrap', count: 2 }]);
    expect(inv.count('scrap')).toBe(2);
    expect(inv.list().length).toBe(1);
  });
});
