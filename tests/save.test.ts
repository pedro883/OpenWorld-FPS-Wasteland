import { describe, expect, it } from 'vitest';
import { SAVE_VERSION, defaultSave, normalizeSave } from '../src/save/saveGame';

const SEED = 1337;

describe('serialização do save', () => {
  it('um save recém-criado sobrevive à ida e volta', () => {
    const save = defaultSave(SEED);
    save.bank = 900;
    save.carried = 120;
    save.inventory = [{ id: 'bandage', count: 3 }];
    save.weapons = ['rifle_m4x'];
    const round = normalizeSave(JSON.parse(JSON.stringify(save)), SEED);
    expect(round).toEqual({ ...save, version: SAVE_VERSION });
  });

  it('recusa o que não é um save', () => {
    expect(normalizeSave(null, SEED)).toBeNull();
    expect(normalizeSave('save', SEED)).toBeNull();
    expect(normalizeSave({}, SEED)).toBeNull();
    expect(normalizeSave([], SEED)).toBeNull();
  });

  it('recusa um save de uma versão futura', () => {
    // Fields a future build relies on cannot be invented by this one.
    expect(normalizeSave({ version: SAVE_VERSION + 1 }, SEED)).toBeNull();
  });

  it('preenche o que faltar em vez de perder a run inteira', () => {
    const save = normalizeSave({ version: 1, bank: 500 }, SEED)!;
    expect(save.bank).toBe(500);
    expect(save.carried).toBe(0);
    expect(save.inventory).toEqual([]);
    expect(save.position).toEqual([0, 0, 0]);
    expect(save.stats.kills).toBe(0);
  });

  it('descarta itens que saíram do catálogo', () => {
    const save = normalizeSave(
      { version: 1, inventory: [{ id: 'item_removido', count: 4 }, { id: 'scrap', count: 2 }] },
      SEED,
    )!;
    expect(save.inventory).toEqual([{ id: 'scrap', count: 2 }]);
  });

  it('descarta pilhas de contagem inválida', () => {
    const save = normalizeSave(
      {
        version: 1,
        inventory: [
          { id: 'scrap', count: 0 },
          { id: 'scrap', count: -3 },
          { id: 'scrap', count: 'muitos' },
          { id: 'scrap', count: 2 },
        ],
      },
      SEED,
    )!;
    expect(save.inventory).toEqual([{ id: 'scrap', count: 2 }]);
  });

  it('não deixa dinheiro negativo entrar', () => {
    const save = normalizeSave({ version: 1, bank: -900, carried: -5 }, SEED)!;
    expect(save.bank).toBe(0);
    expect(save.carried).toBe(0);
  });

  it('sanitiza números corrompidos na posição', () => {
    const save = normalizeSave({ version: 1, position: [10, NaN, 'z'] }, SEED)!;
    expect(save.position).toEqual([10, 0, 0]);
  });

  it('adota a semente atual quando o save não trouxe uma', () => {
    expect(normalizeSave({ version: 1 }, SEED)!.seed).toBe(SEED);
  });

  it('preserva a semente que o save trouxe', () => {
    expect(normalizeSave({ version: 1, seed: 42 }, SEED)!.seed).toBe(42);
  });

  it('ignora listas de armas e acessórios malformadas', () => {
    const save = normalizeSave(
      { version: 1, weapons: ['rifle', 7, null], attachments: { rifle: ['optic_reddot', 3], vazia: [] } },
      SEED,
    )!;
    expect(save.weapons).toEqual(['rifle']);
    expect(save.attachments).toEqual({ rifle: ['optic_reddot'] });
  });

  it('trunca munição fracionada e nega negativa', () => {
    const save = normalizeSave({ version: 1, ammo: { '5.56': 30.7, '9mm': -10 } }, SEED)!;
    expect(save.ammo).toEqual({ '5.56': 30, '9mm': 0 });
  });
});
