import { describe, expect, it } from 'vitest';
import { InventorySystem } from '../src/inventory/inventorySystem';
import type { ContainerDef, ItemBase, ItemInstance } from '../src/inventory/types';

const BASES: Record<string, ItemBase> = {
  rifle: {
    id: 'rifle', name: 'Fuzil', width: 4, height: 2, weightKg: 3.4, value: 1200,
    tags: ['weapon'], equipSlots: ['primary'],
    attachmentSlots: [
      { type: 'optic', accepts: ['attachment'] },
      { type: 'magazine', accepts: ['magazine'] },
    ],
  },
  pistol: { id: 'pistol', name: 'Pistola', width: 2, height: 1, weightKg: 0.9, value: 300, tags: ['pistol', 'weapon'], equipSlots: ['holster'] },
  optic: { id: 'optic', name: 'Luneta', width: 2, height: 1, weightKg: 0.5, value: 400, tags: ['attachment'] },
  mag: { id: 'mag', name: 'Carregador', width: 1, height: 2, weightKg: 0.4, value: 90, tags: ['magazine'], capacity: 30 },
  ammo: { id: 'ammo', name: 'Munição', width: 1, height: 1, weightKg: 0.012, value: 2, tags: ['ammo'] },
  grenade: { id: 'grenade', name: 'Granada', width: 1, height: 1, weightKg: 0.4, value: 120, tags: ['throwable'] },
  helmet: { id: 'helmet', name: 'Capacete', width: 2, height: 2, weightKg: 1.4, value: 500, tags: ['helmet'], equipSlots: ['helmet'] },
  backpack: {
    id: 'backpack', name: 'Mochila', width: 3, height: 3, weightKg: 1.2, value: 300,
    tags: ['backpack', 'container'], equipSlots: ['backpack'],
    container: { width: 6, height: 6 },
  },
};

const resolve = (id: string): ItemBase | null => BASES[id] ?? null;

let counter = 0;
function make(sys: InventorySystem, baseId: string, quantity = 1): ItemInstance {
  const instance: ItemInstance = {
    uuid: `i${++counter}`,
    baseId,
    containerId: null,
    x: 0,
    y: 0,
    rotation: 0,
    equippedSlot: null,
    quantity,
    durability: 100,
    extra: {},
  };
  sys.track(instance);
  return instance;
}

function def(overrides: Partial<ContainerDef>): ContainerDef {
  return { id: 'c', kind: 'stash', name: '', width: 10, height: 8, ownerId: null, ...overrides };
}

function setup() {
  const sys = new InventorySystem(resolve);
  sys.createContainer(def({ id: 'mochila', kind: 'player', ownerId: 'p1' }));
  return sys;
}

describe('mover entre contêineres', () => {
  it('sai de um e entra no outro, sem ficar nos dois', () => {
    const sys = setup();
    sys.createContainer(def({ id: 'caixa', kind: 'crate' }));
    const rifle = make(sys, 'rifle');
    expect(sys.moveInto(rifle.uuid, 'mochila').ok).toBe(true);
    expect(sys.container('mochila')!.count).toBe(1);

    expect(sys.moveInto(rifle.uuid, 'caixa').ok).toBe(true);
    expect(sys.container('mochila')!.count).toBe(0);
    expect(sys.container('caixa')!.count).toBe(1);
    expect(rifle.containerId).toBe('caixa');
  });

  it('contêiner inexistente é recusado', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    expect(sys.moveInto(rifle.uuid, 'nao_existe').reason).toBe('semContainer');
  });

  it('caixa especializada recusa o que não é do tipo', () => {
    const sys = setup();
    sys.createContainer(def({ id: 'municao', kind: 'crate', accepts: ['ammo', 'magazine'] }));
    expect(sys.moveInto(make(sys, 'mag').uuid, 'municao').ok).toBe(true);
    expect(sys.moveInto(make(sys, 'rifle').uuid, 'municao').reason).toBe('tipoNaoAceito');
  });
});

describe('equipamento', () => {
  it('equipa no slot que o item declara', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    sys.moveInto(rifle.uuid, 'mochila');
    expect(sys.equip('p1', rifle.uuid, 'primary').ok).toBe(true);
    expect(sys.equippedIn('p1', 'primary')?.uuid).toBe(rifle.uuid);
    // Leaving the grid is part of equipping, or the item is in two places.
    expect(sys.container('mochila')!.count).toBe(0);
  });

  it('recusa o slot que o item não declara', () => {
    const sys = setup();
    const helmet = make(sys, 'helmet');
    expect(sys.equip('p1', helmet.uuid, 'primary').reason).toBe('slotInvalido');
    expect(sys.equip('p1', helmet.uuid, 'helmet').ok).toBe(true);
  });

  it('não empilha dois itens no mesmo slot', () => {
    const sys = setup();
    const a = make(sys, 'rifle');
    const b = make(sys, 'rifle');
    expect(sys.equip('p1', a.uuid, 'primary').ok).toBe(true);
    expect(sys.equip('p1', b.uuid, 'primary').reason).toBe('slotOcupado');
  });

  it('desequipar só libera o slot se o item couber em algum lugar', () => {
    // Freeing the slot first would lose the item when the bag is full.
    const sys = setup();
    sys.createContainer(def({ id: 'minusculo', kind: 'stash', width: 1, height: 1 }));
    const rifle = make(sys, 'rifle');
    sys.equip('p1', rifle.uuid, 'primary');
    expect(sys.unequip('p1', 'primary', 'minusculo').ok).toBe(false);
    expect(sys.equippedIn('p1', 'primary')?.uuid).toBe(rifle.uuid);

    expect(sys.unequip('p1', 'primary', 'mochila').ok).toBe(true);
    expect(sys.equippedIn('p1', 'primary')).toBeNull();
  });

  it('a mochila equipada já abre o grid dela', () => {
    const sys = setup();
    const pack = make(sys, 'backpack');
    sys.equip('p1', pack.uuid, 'backpack');
    const inner = sys.nestedGridOf(pack.uuid);
    expect(inner).not.toBeNull();
    expect(inner!.width).toBe(6);
  });
});

describe('contêineres aninhados', () => {
  it('mochila dentro de caixa mantém o próprio grid', () => {
    const sys = setup();
    sys.createContainer(def({ id: 'caixa', kind: 'crate', width: 12, height: 12 }));
    const pack = make(sys, 'backpack');
    sys.moveInto(pack.uuid, 'caixa');
    const inner = sys.openNested(pack)!;
    const mag = make(sys, 'mag');
    expect(sys.moveInto(mag.uuid, inner.id).ok).toBe(true);
    expect(inner.count).toBe(1);
    expect(sys.container('caixa')!.count).toBe(1);
  });

  it('a mochila não entra dentro de si mesma', () => {
    // Otherwise it vanishes from the world while still holding everything.
    const sys = setup();
    const pack = make(sys, 'backpack');
    sys.moveInto(pack.uuid, 'mochila');
    const inner = sys.openNested(pack)!;
    expect(sys.moveInto(pack.uuid, inner.id).reason).toBe('recursivo');
  });

  it('nem por um nível de indireção', () => {
    const sys = setup();
    const outer = make(sys, 'backpack');
    const innerPack = make(sys, 'backpack');
    sys.moveInto(outer.uuid, 'mochila');
    const outerGrid = sys.openNested(outer)!;
    sys.moveInto(innerPack.uuid, outerGrid.id);
    const innerGrid = sys.openNested(innerPack)!;
    expect(sys.moveInto(outer.uuid, innerGrid.id).reason).toBe('recursivo');
  });
});

describe('inspeção de corpo com tempo de busca', () => {
  function corpse() {
    const sys = setup();
    sys.createContainer(
      def({ id: 'corpo', kind: 'corpse', ownerId: 'npc7', searchSeconds: 4, position: { x: 10, y: 0, z: 5 } }),
    );
    const loot = make(sys, 'mag');
    sys.container('corpo')!.insert(loot);
    return { sys, loot };
  }

  it('começa não pesquisado', () => {
    const { sys } = corpse();
    expect(sys.isRevealed('corpo')).toBe(false);
    expect(sys.searchProgress('corpo')).toBe(0);
  });

  it('não deixa tirar nada antes de terminar a busca', () => {
    const { sys, loot } = corpse();
    expect(sys.moveInto(loot.uuid, 'mochila').ok).toBe(true); // sair é permitido
    const { sys: s2, loot: l2 } = corpse();
    // Mas colocar algo dentro de um corpo não pesquisado, não.
    const grenade = make(s2, 'grenade');
    expect(s2.moveInto(grenade.uuid, 'corpo').reason).toBe('naoPesquisado');
    void l2;
  });

  it('a barra avança e revela no fim', () => {
    const { sys } = corpse();
    expect(sys.advanceSearch('corpo', 2)).toBe(false);
    expect(sys.searchProgress('corpo')).toBeCloseTo(0.5, 3);
    expect(sys.isRevealed('corpo')).toBe(false);
    expect(sys.advanceSearch('corpo', 2)).toBe(true);
    expect(sys.isRevealed('corpo')).toBe(true);
    expect(sys.searchProgress('corpo')).toBe(1);
  });

  it('revelar duas vezes não dispara de novo', () => {
    const { sys } = corpse();
    sys.advanceSearch('corpo', 10);
    expect(sys.advanceSearch('corpo', 10)).toBe(false);
  });

  it('contêiner do próprio jogador não pede busca', () => {
    const { sys } = corpse();
    expect(sys.isRevealed('mochila')).toBe(true);
    expect(sys.searchProgress('mochila')).toBe(1);
  });

  it('o painel de corpo lista os slots equipados do morto', () => {
    const { sys } = corpse();
    const rifle = make(sys, 'rifle');
    sys.equip('npc7', rifle.uuid, 'primary');
    const contents = sys.corpseContents('corpo');
    expect(contents.slots.primary).toBe(rifle.uuid);
    expect(contents.grid?.count).toBe(1);
  });
});

describe('chão', () => {
  it('largar tira do grid e põe no mundo', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    sys.moveInto(rifle.uuid, 'mochila');
    const dropped = sys.drop(rifle.uuid, 10, 2, 5, 1.2)!;
    expect(dropped.x).toBe(10);
    expect(sys.container('mochila')!.count).toBe(0);
    expect(rifle.containerId).toBeNull();
    expect(sys.groundCount).toBe(1);
  });

  it('lista o que está perto, do mais próximo ao mais longe', () => {
    const sys = setup();
    const perto = make(sys, 'grenade');
    const longe = make(sys, 'mag');
    sys.drop(perto.uuid, 1, 0, 0);
    sys.drop(longe.uuid, 2.5, 0, 0);
    const near = sys.groundNear(0, 0, 3);
    expect(near.map((g) => g.instance.uuid)).toEqual([perto.uuid, longe.uuid]);
    expect(sys.groundNear(0, 0, 1.5).length).toBe(1);
  });

  it('pegar volta para a mochila e sai do chão', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    sys.drop(rifle.uuid, 0, 0, 0);
    expect(sys.pickUp(rifle.uuid, 'mochila').ok).toBe(true);
    expect(sys.groundCount).toBe(0);
    expect(sys.container('mochila')!.count).toBe(1);
  });

  it('mochila cheia deixa o item no chão em vez de sumir', () => {
    const sys = setup();
    sys.createContainer(def({ id: 'minusculo', width: 1, height: 1 }));
    const rifle = make(sys, 'rifle');
    sys.drop(rifle.uuid, 0, 0, 0);
    expect(sys.pickUp(rifle.uuid, 'minusculo').ok).toBe(false);
    expect(sys.groundCount).toBe(1);
  });

  it('caixas por perto aparecem na interação de proximidade', () => {
    const sys = setup();
    sys.createContainer(def({ id: 'caixa', kind: 'crate', position: { x: 2, y: 0, z: 0 } }));
    sys.createContainer(def({ id: 'longe', kind: 'crate', position: { x: 50, y: 0, z: 0 } }));
    const near = sys.containersNear(0, 0, 3);
    expect(near.map((g) => g.id)).toEqual(['caixa']);
  });
});

describe('anexos', () => {
  it('encaixa a luneta no trilho', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    const optic = make(sys, 'optic');
    sys.moveInto(rifle.uuid, 'mochila');
    sys.moveInto(optic.uuid, 'mochila');
    expect(sys.attach(rifle.uuid, 'optic', optic.uuid).ok).toBe(true);
    // Attaching takes it out of the grid; it rides the weapon now.
    expect(sys.container('mochila')!.count).toBe(1);
    expect(sys.attachmentsOf(rifle.uuid).length).toBe(1);
  });

  it('recusa peça do tipo errado no slot', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    const grenade = make(sys, 'grenade');
    expect(sys.attach(rifle.uuid, 'optic', grenade.uuid).reason).toBe('tipoNaoAceito');
  });

  it('não põe duas peças no mesmo trilho', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    expect(sys.attach(rifle.uuid, 'optic', make(sys, 'optic').uuid).ok).toBe(true);
    expect(sys.attach(rifle.uuid, 'optic', make(sys, 'optic').uuid).reason).toBe('slotOcupado');
  });

  it('a mesma peça não vai para duas armas', () => {
    const sys = setup();
    const optic = make(sys, 'optic');
    expect(sys.attach(make(sys, 'rifle').uuid, 'optic', optic.uuid).ok).toBe(true);
    expect(sys.attach(make(sys, 'rifle').uuid, 'optic', optic.uuid).reason).toBe('slotOcupado');
  });

  it('slot que a arma não tem é recusado', () => {
    const sys = setup();
    expect(sys.attach(make(sys, 'rifle').uuid, 'bipe', make(sys, 'optic').uuid).reason)
      .toBe('slotDeAnexoInvalido');
  });

  it('desmontar devolve a peça para a mochila', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    const optic = make(sys, 'optic');
    sys.attach(rifle.uuid, 'optic', optic.uuid);
    expect(sys.detachAttachment(optic.uuid, 'mochila').ok).toBe(true);
    expect(sys.attachmentsOf(rifle.uuid).length).toBe(0);
    expect(sys.container('mochila')!.count).toBe(1);
  });
});

describe('peso total', () => {
  it('soma equipado, mochila, aninhado e anexos', () => {
    const sys = setup();
    const pack = make(sys, 'backpack');
    sys.equip('p1', pack.uuid, 'backpack');
    const inner = sys.nestedGridOf(pack.uuid)!;

    const rifle = make(sys, 'rifle');
    const optic = make(sys, 'optic');
    sys.moveInto(rifle.uuid, inner.id);
    sys.attach(rifle.uuid, 'optic', optic.uuid);
    sys.moveInto(make(sys, 'ammo', 60).uuid, inner.id);

    // 1.2 mochila + 3.4 fuzil + 0.5 luneta + 60 x 0.012 munição
    expect(sys.totalWeight('p1')).toBeCloseTo(1.2 + 3.4 + 0.5 + 0.72, 3);
  });

  it('não conta o mesmo item duas vezes', () => {
    const sys = setup();
    const rifle = make(sys, 'rifle');
    sys.equip('p1', rifle.uuid, 'primary');
    expect(sys.totalWeight('p1')).toBeCloseTo(3.4, 3);
  });
});
