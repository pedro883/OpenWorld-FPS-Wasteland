import { describe, expect, it, vi, afterEach } from 'vitest';
import { ZoneHealth, zoneForNode, ZONES } from '../src/entities/health';
import { Player as Cfg } from '../src/core/config';

const cfg = Cfg.health;

/** Removes the randomness from bleed rolls so outcomes are assertable. */
function withRandom<T>(value: number, fn: () => T): T {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(value);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('mapeamento de nós do rig', () => {
  it('mapeia os nós do Mini Characters para zonas', () => {
    expect(zoneForNode('head')).toBe('head');
    expect(zoneForNode('arm-left')).toBe('armLeft');
    expect(zoneForNode('leg-right')).toBe('legRight');
    expect(zoneForNode('torso')).toBe('torso');
  });

  it('cai no torso para nós desconhecidos, em vez de perder o dano', () => {
    expect(zoneForNode('nó-inexistente')).toBe('torso');
  });
});

describe('dano por zona', () => {
  it('aplica o multiplicador da zona', () => {
    const h = new ZoneHealth();
    const result = withRandom(1, () => h.applyDamage('torso', 10));
    expect(result.applied).toBeCloseTo(10 * cfg.zones.torso.damageMultiplier, 5);
    expect(h.get('torso').hp).toBeCloseTo(cfg.zones.torso.max - result.applied, 5);
  });

  it('a cabeça leva mais dano que o torso pelo mesmo tiro', () => {
    const head = new ZoneHealth();
    const torso = new ZoneHealth();
    withRandom(1, () => {
      head.applyDamage('head', 10);
      torso.applyDamage('torso', 10);
    });
    expect(head.fraction('head')).toBeLessThan(torso.fraction('torso'));
  });

  it('zera a zona sem deixar vida negativa', () => {
    const h = new ZoneHealth();
    withRandom(1, () => h.applyDamage('legLeft', 9999));
    expect(h.get('legLeft').hp).toBe(0);
  });

  it('mata ao zerar cabeça ou torso, mas não ao zerar um membro', () => {
    const porMembro = new ZoneHealth();
    withRandom(1, () => porMembro.applyDamage('armLeft', 9999));
    expect(porMembro.alive).toBe(true);

    const porTorso = new ZoneHealth();
    const r = withRandom(1, () => porTorso.applyDamage('torso', 9999));
    expect(porTorso.alive).toBe(false);
    expect(r.killed).toBe(true);
  });

  it('ignora dano em quem já morreu', () => {
    const h = new ZoneHealth();
    withRandom(1, () => h.applyDamage('head', 9999));
    const depois = withRandom(1, () => h.applyDamage('torso', 50));
    expect(depois.applied).toBe(0);
    expect(h.get('torso').hp).toBe(cfg.zones.torso.max);
  });

  it('sinaliza `disabled` só na transição para fora de combate', () => {
    const h = new ZoneHealth();
    const primeiro = withRandom(1, () => h.applyDamage('legRight', 9999));
    const segundo = withRandom(1, () => h.applyDamage('legRight', 10));
    expect(primeiro.disabled).toBe(true);
    expect(segundo.disabled).toBe(false);
  });
});

describe('efeitos de membro ferido', () => {
  it('uma perna ferida reduz a velocidade; duas reduzem mais', () => {
    const h = new ZoneHealth();
    expect(h.speedMultiplier).toBe(1);
    withRandom(1, () => h.applyDamage('legLeft', 9999));
    expect(h.speedMultiplier).toBeCloseTo(cfg.brokenLegSpeedMultiplier, 5);
    withRandom(1, () => h.applyDamage('legRight', 9999));
    expect(h.speedMultiplier).toBeLessThan(cfg.brokenLegSpeedMultiplier);
  });

  it('braço ferido aumenta o sway, e dois braços compõem', () => {
    const h = new ZoneHealth();
    expect(h.swayMultiplier).toBe(1);
    withRandom(1, () => h.applyDamage('armRight', 9999));
    expect(h.swayMultiplier).toBeCloseTo(cfg.brokenArmSwayMultiplier, 5);
    withRandom(1, () => h.applyDamage('armLeft', 9999));
    expect(h.swayMultiplier).toBeCloseTo(cfg.brokenArmSwayMultiplier ** 2, 5);
  });

  it('perna ferida não afeta o sway nem braço ferido a velocidade', () => {
    const h = new ZoneHealth();
    withRandom(1, () => h.applyDamage('legLeft', 9999));
    expect(h.swayMultiplier).toBe(1);
    const outro = new ZoneHealth();
    withRandom(1, () => outro.applyDamage('armLeft', 9999));
    expect(outro.speedMultiplier).toBe(1);
  });
});

describe('sangramento', () => {
  it('um tiro pesado pode abrir sangramento; um de raspão não', () => {
    const pesado = new ZoneHealth();
    withRandom(0, () => pesado.applyDamage('torso', 100));
    expect(pesado.isBleeding).toBe(true);

    const raspao = new ZoneHealth();
    withRandom(0.99, () => raspao.applyDamage('torso', 1));
    expect(raspao.isBleeding).toBe(false);
  });

  it('drena o torso na taxa configurada', () => {
    const h = new ZoneHealth();
    withRandom(0, () => h.applyDamage('legLeft', 100));
    const antes = h.get('torso').hp;
    for (let i = 0; i < 60; i++) h.update(1 / 60);
    expect(antes - h.get('torso').hp).toBeCloseTo(cfg.bleedDamagePerSecond, 1);
  });

  it('sangramento não tratado é letal', () => {
    const h = new ZoneHealth();
    withRandom(0, () => h.applyDamage('torso', 60));
    let segundos = 0;
    while (h.alive && segundos < 600) {
      h.update(1 / 60);
      segundos += 1 / 60;
    }
    expect(h.alive).toBe(false);
  });

  it('a bandagem estanca um sangramento e recupera a pior zona', () => {
    const h = new ZoneHealth();
    withRandom(0, () => h.applyDamage('legLeft', 30));
    expect(h.isBleeding).toBe(true);
    const antes = h.get('legLeft').hp;
    h.bandage();
    expect(h.isBleeding).toBe(false);
    expect(h.get('legLeft').hp).toBeGreaterThan(antes);
  });

  it('não cura acima do máximo da zona', () => {
    const h = new ZoneHealth();
    withRandom(1, () => h.applyDamage('torso', 1));
    h.bandage();
    h.bandage();
    for (const zone of ZONES) {
      expect(h.get(zone).hp).toBeLessThanOrEqual(h.get(zone).max);
    }
  });
});

describe('reset', () => {
  it('devolve todas as zonas ao máximo e ressuscita', () => {
    const h = new ZoneHealth();
    withRandom(0, () => h.applyDamage('head', 9999));
    h.reset();
    expect(h.alive).toBe(true);
    expect(h.isBleeding).toBe(false);
    for (const zone of ZONES) expect(h.fraction(zone)).toBe(1);
  });
});
