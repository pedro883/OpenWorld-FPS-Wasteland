import { describe, expect, it } from 'vitest';
import { Grid, weightOf } from '../src/inventory/grid';
import {
  footprintOf,
  fromRow,
  toRow,
  type ContainerDef,
  type ItemBase,
  type ItemInstance,
} from '../src/inventory/types';

const BASES: Record<string, ItemBase> = {
  rifle: { id: 'rifle', name: 'Fuzil', width: 4, height: 2, weightKg: 3.4, value: 1200, tags: ['weapon'], equipSlots: ['primary'] },
  mag: { id: 'mag', name: 'Carregador', width: 1, height: 2, weightKg: 0.4, value: 90, tags: ['magazine'], capacity: 30, calibre: '5.56' },
  grenade: { id: 'grenade', name: 'Granada', width: 1, height: 1, weightKg: 0.4, value: 120, tags: ['throwable'] },
  ammo: { id: 'ammo', name: 'Munição', width: 1, height: 1, weightKg: 0.012, value: 2, tags: ['ammo'], calibre: '5.56' },
  backpack: {
    id: 'backpack', name: 'Mochila', width: 3, height: 3, weightKg: 1.2, value: 300,
    tags: ['backpack', 'container'], equipSlots: ['backpack'],
    container: { width: 6, height: 6 },
  },
};

const resolve = (id: string): ItemBase | null => BASES[id] ?? null;

let counter = 0;
function instance(baseId: string, quantity = 1): ItemInstance {
  return {
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
}

function container(overrides: Partial<ContainerDef> = {}): ContainerDef {
  return { id: 'c1', kind: 'stash', name: 'Caixa', width: 10, height: 6, ownerId: null, ...overrides };
}

describe('pegada e rotação', () => {
  it('rotacionar troca largura por altura', () => {
    expect(footprintOf(BASES.rifle!, 0)).toEqual({ w: 4, h: 2 });
    expect(footprintOf(BASES.rifle!, 90)).toEqual({ w: 2, h: 4 });
  });
});

describe('colisão de slots', () => {
  it('marca todas as células que o item ocupa', () => {
    const grid = new Grid(container({ width: 6, height: 3 }), resolve);
    grid.place(instance('rifle'), 0, 0, 0);
    expect(grid.debugText()).toBe('AAAA..\nAAAA..\n......');
  });

  it('recusa sobreposição', () => {
    const grid = new Grid(container({ width: 6, height: 3 }), resolve);
    expect(grid.place(instance('rifle'), 0, 0, 0).ok).toBe(true);
    expect(grid.place(instance('mag'), 3, 0, 0).reason).toBe('ocupado');
    expect(grid.place(instance('mag'), 4, 0, 0).ok).toBe(true);
  });

  it('recusa o que passa da borda', () => {
    const grid = new Grid(container({ width: 4, height: 2 }), resolve);
    expect(grid.place(instance('rifle'), 1, 0, 0).reason).toBe('foraDoGrid');
    expect(grid.place(instance('rifle'), 0, 0, 0).ok).toBe(true);
  });

  it('sabe o que está sob uma célula', () => {
    const grid = new Grid(container(), resolve);
    const rifle = instance('rifle');
    grid.place(rifle, 2, 1, 0);
    expect(grid.at(3, 2)?.uuid).toBe(rifle.uuid);
    expect(grid.at(0, 0)).toBeNull();
    expect(grid.at(-1, 0)).toBeNull();
  });

  it('remover libera as células', () => {
    const grid = new Grid(container({ width: 4, height: 2 }), resolve);
    const rifle = instance('rifle');
    grid.place(rifle, 0, 0, 0);
    expect(grid.freeCells).toBe(0);
    grid.remove(rifle.uuid);
    expect(grid.freeCells).toBe(8);
    expect(grid.count).toBe(0);
  });

  it('mover o item não o faz colidir consigo mesmo', () => {
    // Without ignoring its own uuid nothing could ever be nudged one cell.
    const grid = new Grid(container({ width: 6, height: 2 }), resolve);
    const rifle = instance('rifle');
    grid.place(rifle, 0, 0, 0);
    expect(grid.place(rifle, 1, 0, 0).ok).toBe(true);
    expect(grid.at(0, 0)).toBeNull();
    expect(grid.at(4, 0)?.uuid).toBe(rifle.uuid);
  });
});

describe('rotação dentro do grid', () => {
  it('gira quando cabe', () => {
    const grid = new Grid(container({ width: 4, height: 4 }), resolve);
    const rifle = instance('rifle');
    grid.place(rifle, 0, 0, 0);
    expect(grid.rotate(rifle.uuid).ok).toBe(true);
    expect(rifle.rotation).toBe(90);
    expect(grid.debugText()).toBe('AA..\nAA..\nAA..\nAA..');
  });

  it('recusa girar quando a pegada virada não cabe', () => {
    const grid = new Grid(container({ width: 4, height: 2 }), resolve);
    const rifle = instance('rifle');
    grid.place(rifle, 0, 0, 0);
    expect(grid.rotate(rifle.uuid).reason).toBe('foraDoGrid');
    expect(rifle.rotation).toBe(0);
  });

  it('item quadrado não muda nada ao girar', () => {
    const grid = new Grid(container(), resolve);
    const grenade = instance('grenade');
    grid.place(grenade, 1, 1, 0);
    expect(grid.rotate(grenade.uuid).ok).toBe(true);
    expect(grenade.x).toBe(1);
  });
});

describe('inserção automática', () => {
  it('põe no primeiro lugar livre, de cima para baixo', () => {
    const grid = new Grid(container({ width: 4, height: 4 }), resolve);
    const a = instance('mag');
    const b = instance('mag');
    grid.insert(a);
    grid.insert(b);
    expect([a.x, a.y]).toEqual([0, 0]);
    expect([b.x, b.y]).toEqual([1, 0]);
  });

  it('só gira quando precisa', () => {
    // The player learns items land unturned; a rifle turns sideways only when
    // it genuinely has to.
    const wide = new Grid(container({ width: 4, height: 2 }), resolve);
    const r1 = instance('rifle');
    wide.insert(r1);
    expect(r1.rotation).toBe(0);

    const tall = new Grid(container({ width: 2, height: 4 }), resolve);
    const r2 = instance('rifle');
    expect(tall.insert(r2).ok).toBe(true);
    expect(r2.rotation).toBe(90);
  });

  it('recusa quando não há espaço', () => {
    const grid = new Grid(container({ width: 4, height: 2 }), resolve);
    expect(grid.insert(instance('rifle')).ok).toBe(true);
    expect(grid.insert(instance('rifle')).reason).toBe('ocupado');
  });

  it('item maior que o grid nunca entra', () => {
    const grid = new Grid(container({ width: 1, height: 1 }), resolve);
    expect(grid.insert(instance('rifle')).reason).toBe('ocupado');
  });

  it('item fora do catálogo é recusado, não quebra o grid', () => {
    const grid = new Grid(container(), resolve);
    expect(grid.insert(instance('nao_existe')).reason).toBe('itemDesconhecido');
  });
});

describe('filtro por tipo de caixa', () => {
  it('caixa de munição só aceita munição e carregadores', () => {
    const grid = new Grid(
      container({ id: 'ammo-crate', kind: 'crate', accepts: ['ammo', 'magazine'] }),
      resolve,
    );
    expect(grid.insert(instance('mag')).ok).toBe(true);
    expect(grid.insert(instance('ammo')).ok).toBe(true);
    expect(grid.insert(instance('rifle')).reason).toBe('tipoNaoAceito');
    expect(grid.insert(instance('grenade')).reason).toBe('tipoNaoAceito');
  });

  it('caixa de granadas recusa arma', () => {
    const grid = new Grid(container({ accepts: ['throwable'] }), resolve);
    expect(grid.insert(instance('grenade')).ok).toBe(true);
    expect(grid.insert(instance('rifle')).reason).toBe('tipoNaoAceito');
  });

  it('sem filtro tudo entra', () => {
    const grid = new Grid(container({ accepts: [] }), resolve);
    expect(grid.insert(instance('rifle')).ok).toBe(true);
    expect(grid.insert(instance('grenade')).ok).toBe(true);
  });
});

describe('peso com contêiner aninhado', () => {
  it('soma o que a mochila carrega', () => {
    const outer = new Grid(container({ width: 8, height: 8 }), resolve);
    const pack = instance('backpack');
    outer.insert(pack);

    const inner = new Grid(
      container({ id: 'pack-grid', kind: 'nested', width: 6, height: 6, parentInstanceId: pack.uuid }),
      resolve,
    );
    inner.insert(instance('rifle'));
    const nested = new Map([[pack.uuid, inner]]);

    const soZinha = weightOf(outer, resolve);
    const comConteudo = weightOf(outer, resolve, nested);
    expect(soZinha).toBeCloseTo(1.2, 3);
    expect(comConteudo).toBeCloseTo(1.2 + 3.4, 3);
  });

  it('munição pesa por cartucho', () => {
    const grid = new Grid(container(), resolve);
    grid.insert(instance('ammo', 60));
    expect(weightOf(grid, resolve)).toBeCloseTo(0.012 * 60, 4);
  });
});

describe('serialização para o MySQL', () => {
  it('ida e volta preserva a instância', () => {
    const item = instance('rifle');
    item.x = 3;
    item.y = 1;
    item.rotation = 90;
    item.quantity = 30;
    item.durability = 71;
    item.containerId = 'c1';
    item.extra = { serial: 'AX-9' };
    expect(fromRow(toRow(item))).toEqual(item);
  });

  it('item equipado grava slot e não grava coordenada', () => {
    // Writing 0,0 for an equipped item would collide with whatever genuinely
    // sits in the corner of the grid.
    const item = instance('rifle');
    item.equippedSlot = 'primary';
    item.containerId = 'equip';
    const row = toRow(item);
    expect(row.equipped_slot).toBe('primary');
    expect(row.position_x).toBeNull();
    expect(row.position_y).toBeNull();
  });

  it('extra_json corrompido custa os extras, não a linha', () => {
    const row = { ...toRow(instance('rifle')), extra_json: '{isso não é json' };
    expect(fromRow(row).extra).toEqual({});
  });

  it('rotação inválida vinda do banco vira 0', () => {
    const row = { ...toRow(instance('rifle')), rotation: 45 };
    expect(fromRow(row).rotation).toBe(0);
  });
});

describe('carregar um grid vindo do banco', () => {
  it('respeita as coordenadas gravadas', () => {
    const grid = new Grid(container({ width: 6, height: 4 }), resolve);
    const rifle = instance('rifle');
    rifle.x = 2;
    rifle.y = 2;
    const { placed, rejected } = grid.load([rifle]);
    expect(placed).toBe(1);
    expect(rejected).toEqual([]);
    expect(grid.at(2, 2)?.uuid).toBe(rifle.uuid);
  });

  it('reposiciona a linha que não cabe mais em vez de perdê-la', () => {
    // The item was made bigger in a patch; losing the player's rifle over that
    // is worse than moving it.
    const grid = new Grid(container({ width: 6, height: 4 }), resolve);
    const rifle = instance('rifle');
    rifle.x = 5;
    rifle.y = 3;
    const { placed, rejected } = grid.load([rifle]);
    expect(placed).toBe(1);
    expect(rejected).toEqual([]);
    expect(grid.at(0, 0)?.uuid).toBe(rifle.uuid);
  });

  it('devolve o que não coube de jeito nenhum', () => {
    const grid = new Grid(container({ width: 4, height: 2 }), resolve);
    const { placed, rejected } = grid.load([instance('rifle'), instance('rifle')]);
    expect(placed).toBe(1);
    expect(rejected.length).toBe(1);
  });
});
