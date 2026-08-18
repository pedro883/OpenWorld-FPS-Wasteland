import { describe, expect, it } from 'vitest';
import { ACTIONS, Keybinds, type Action } from '../src/core/keybinds';
import { defaultSave, normalizeSave } from '../src/save/saveGame';

describe('keybinds remapeáveis', () => {
  it('começa com todas as ações mapeadas', () => {
    const kb = new Keybinds();
    for (const action of Object.keys(ACTIONS) as Action[]) {
      expect(kb.get(action), action).toBeTruthy();
    }
    expect(kb.unbound()).toEqual([]);
  });

  it('nenhuma tecla padrão faz duas coisas', () => {
    // A duplicate would give one keypress two meanings, and which one wins
    // depends on iteration order — a bug that looks random from outside.
    const kb = new Keybinds();
    const codes = (Object.keys(ACTIONS) as Action[]).map((a) => kb.get(a));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('remapear tira a tecla de quem a tinha', () => {
    const kb = new Keybinds();
    expect(kb.get('forward')).toBe('KeyW');
    kb.set('reload', 'KeyW');
    expect(kb.get('reload')).toBe('KeyW');
    expect(kb.get('forward')).toBe('');
    expect(kb.unbound()).toEqual(['forward']);
  });

  it('recusa teclas reservadas pelo navegador e pelo debug', () => {
    const kb = new Keybinds();
    for (const code of ['Escape', 'F1', 'F5', 'F12', 'Tab']) {
      expect(kb.set('jump', code), code).toBe(false);
    }
    expect(kb.get('jump')).toBe('Space');
  });

  it('encontra a ação de uma tecla', () => {
    const kb = new Keybinds();
    expect(kb.actionFor('KeyE')).toBe('interact');
    expect(kb.actionFor('KeyQ')).toBeNull();
  });

  it('restaurar padrões desfaz tudo', () => {
    const kb = new Keybinds();
    kb.set('reload', 'KeyW');
    kb.reset();
    expect(kb.get('forward')).toBe('KeyW');
    expect(kb.get('reload')).toBe('KeyR');
  });

  it('rótulos são legíveis', () => {
    expect(Keybinds.describe('KeyW')).toBe('W');
    expect(Keybinds.describe('Space')).toBe('Espaço');
    expect(Keybinds.describe('ShiftLeft')).toBe('Shift esq');
    expect(Keybinds.describe('Digit1')).toBe('1');
  });

  it('carrega um mapeamento salvo', () => {
    const kb = new Keybinds();
    kb.load({ forward: 'KeyZ', reload: 'KeyP' });
    expect(kb.get('forward')).toBe('KeyZ');
    expect(kb.get('reload')).toBe('KeyP');
    // Actions the save did not mention fall back to their default.
    expect(kb.get('jump')).toBe('Space');
  });

  it('ignora lixo vindo do save', () => {
    const kb = new Keybinds();
    kb.load({ acaoInexistente: 'KeyQ', jump: 'Escape', reload: 42 as unknown as string });
    expect(kb.get('jump')).toBe('Space');
    expect(kb.get('reload')).toBe('KeyR');
  });
});

describe('configurações no save', () => {
  it('sobrevivem à ida e volta', () => {
    const save = defaultSave(1);
    save.settings = {
      volumes: { master: 0.4, music: 0.1 },
      sensitivity: 1.8,
      fov: 95,
      quality: 'baixa',
      invertY: true,
      keybinds: { forward: 'KeyZ' },
    };
    const round = normalizeSave(JSON.parse(JSON.stringify(save)), 1)!;
    expect(round.settings).toEqual(save.settings);
  });

  it('valor fora de faixa é preso na faixa, não descartado', () => {
    // A build with a wider slider is the likely source, so the nearest legal
    // value is closer to the intent than the default would be.
    const round = normalizeSave(
      { version: 1, settings: { fov: 0, sensitivity: 99, volumes: { music: 9 } } },
      1,
    )!;
    expect(round.settings.fov).toBe(60);
    expect(round.settings.sensitivity).toBe(3);
    expect(round.settings.volumes.music).toBe(1);
  });

  it('valor que não é número cai no padrão', () => {
    const round = normalizeSave(
      { version: 1, settings: { sensitivity: NaN, fov: 'largo', quality: 'ultra' } },
      1,
    )!;
    expect(round.settings.sensitivity).toBe(1);
    expect(round.settings.fov).toBe(75);
    expect(round.settings.quality).toBe('alta');
  });

  it('um save sem bloco de configurações usa os padrões', () => {
    const round = normalizeSave({ version: 1 }, 1)!;
    expect(round.settings.fov).toBe(75);
    expect(round.settings.keybinds).toEqual({});
  });
});
