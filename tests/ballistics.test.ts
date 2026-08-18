import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { BallisticsSystem, falloffAt, type ImpactEvent } from '../src/combat/ballistics';
import type { PhysicsWorld, RayHit } from '../src/physics/world';
import { World as WorldCfg } from '../src/core/config';
import { ZoneHealth } from '../src/entities/health';
import type { Damageable } from '../src/combat/types';

/**
 * Stub world: a set of infinite planes perpendicular to -Z, each with a
 * material and thickness. Enough to drive penetration, ricochet and damage
 * without booting Rapier's WASM in the test runner.
 */
interface Slab {
  z: number;
  thickness: number;
  material: string;
  owner?: unknown;
}

class StubPhysics {
  slabs: Slab[] = [];

  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDistance: number,
  ): RayHit | null {
    if (dir.z >= 0) return null;
    let best: { distance: number; slab: Slab } | null = null;
    for (const slab of this.slabs) {
      const distance = (origin.z - slab.z) / -dir.z;
      if (distance < 1e-6 || distance > maxDistance) continue;
      if (!best || distance < best.distance) best = { distance, slab };
    }
    if (!best) return null;
    return {
      distance: best.distance,
      point: {
        x: origin.x + dir.x * best.distance,
        y: origin.y + dir.y * best.distance,
        z: origin.z + dir.z * best.distance,
      },
      normal: { x: 0, y: 0, z: 1 },
      collider: { handle: this.slabs.indexOf(best.slab) } as never,
      userData: best.slab.owner ?? { kind: 'surface', material: best.slab.material },
    };
  }

  raycastCollider(collider: { handle: number }): number | null {
    return this.slabs[collider.handle]?.thickness ?? null;
  }
}

function makeSystem(stub: StubPhysics): BallisticsSystem {
  return new BallisticsSystem(stub as unknown as PhysicsWorld, WorldCfg.gravity);
}

const RIFLE = {
  muzzleVelocity: 880,
  damage: 26,
  falloff: [
    [0, 1],
    [70, 1],
    [180, 0.68],
    [350, 0.46],
  ] as Array<[number, number]>,
  penetration: 0.55,
};

/** Flies a round with nothing in the way, sampling position each tick. */
function flyFreely(seconds: number): Array<{ t: number; pos: THREE.Vector3 }> {
  const stub = new StubPhysics();
  const sys = makeSystem(stub);
  sys.fire({
    origin: new THREE.Vector3(0, 0, 0),
    direction: new THREE.Vector3(0, 0, -1),
    ...RIFLE,
    shooter: null,
    tracer: false,
  });
  const samples: Array<{ t: number; pos: THREE.Vector3 }> = [];
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    sys.update(dt);
    let captured: THREE.Vector3 | null = null;
    sys.forEachActive((pos) => {
      captured = pos.clone();
    });
    if (!captured) break;
    samples.push({ t: t + dt, pos: captured });
  }
  return samples;
}

describe('queda de dano por distância', () => {
  it('não perde dano dentro da faixa plana', () => {
    expect(falloffAt(RIFLE.falloff, 0)).toBe(1);
    expect(falloffAt(RIFLE.falloff, 70)).toBe(1);
  });

  it('interpola linearmente entre os pontos da curva', () => {
    // Meio do caminho entre 70 m (1.0) e 180 m (0.68)
    expect(falloffAt(RIFLE.falloff, 125)).toBeCloseTo((1 + 0.68) / 2, 3);
  });

  it('mantém o último valor além do fim da curva', () => {
    expect(falloffAt(RIFLE.falloff, 1000)).toBe(0.46);
  });

  it('nunca aumenta com a distância', () => {
    let previous = Infinity;
    for (let d = 0; d <= 400; d += 10) {
      const value = falloffAt(RIFLE.falloff, d);
      expect(value).toBeLessThanOrEqual(previous + 1e-9);
      previous = value;
    }
  });
});

describe('queda do projétil e tempo de voo', () => {
  const samples = flyFreely(1.4);

  const at = (distance: number) => {
    for (const s of samples) {
      if (-s.pos.z >= distance) return s;
    }
    throw new Error(`o projétil não alcançou ${distance} m`);
  };

  it('o projétil não é hitscan: leva tempo mensurável para chegar', () => {
    const s300 = at(300);
    // 300 m a ~880 m/s com arrasto: em torno de 0,37 s.
    expect(s300.t).toBeGreaterThan(0.3);
    expect(s300.t).toBeLessThan(0.45);
  });

  it('o arrasto faz bandas iguais de distância levarem cada vez mais tempo', () => {
    // Comparar t(2d) com 2*t(d) é frágil: a 60 Hz o tempo é quantizado em 16,7 ms,
    // e nessas faixas o efeito do arrasto é menor que um tick. Medir bandas
    // sucessivas de 200 m é a mesma afirmação física, sem essa fragilidade.
    const primeira = at(200).t;
    const segunda = at(400).t - at(200).t;
    const terceira = at(600).t - at(400).t;
    expect(segunda).toBeGreaterThanOrEqual(primeira);
    expect(terceira).toBeGreaterThan(primeira);
  });

  it('cai sob gravidade, e a queda cresce com o quadrado do tempo', () => {
    const a = at(100);
    const b = at(200);
    expect(a.pos.y).toBeLessThan(0);
    // Dobrar a distância mais que triplica a queda (t^2 sobre um t maior).
    expect(-b.pos.y).toBeGreaterThan(-a.pos.y * 3);
  });

  it('a queda a 100 m fica na faixa de um 5,56 real (10–20 cm)', () => {
    const drop = -at(100).pos.y;
    expect(drop).toBeGreaterThan(0.1);
    expect(drop).toBeLessThan(0.2);
  });

  it('perde velocidade ao longo do voo', () => {
    const first = samples[1]!;
    const last = samples[samples.length - 1]!;
    const speedStart = first.pos.distanceTo(samples[0]!.pos) * 60;
    const speedEnd = last.pos.distanceTo(samples[samples.length - 2]!.pos) * 60;
    expect(speedEnd).toBeLessThan(speedStart);
  });

  it('expira depois do tempo máximo de voo, sem vazar do pool', () => {
    const stub = new StubPhysics();
    const sys = makeSystem(stub);
    sys.fire({
      origin: new THREE.Vector3(),
      direction: new THREE.Vector3(0, 0, -1),
      ...RIFLE,
      shooter: null,
      tracer: false,
    });
    expect(sys.activeCount).toBe(1);
    for (let i = 0; i < 60 * 8; i++) sys.update(1 / 60);
    expect(sys.activeCount).toBe(0);
  });
});

describe('varredura contra paredes finas', () => {
  it('um passo de 14 m não atravessa uma parede de 5 cm', () => {
    const stub = new StubPhysics();
    stub.slabs = [{ z: -8, thickness: 0.05, material: 'concrete' }];
    const sys = makeSystem(stub);
    const impacts: ImpactEvent[] = [];
    sys.onImpact = (e) => impacts.push(e);
    sys.fire({
      origin: new THREE.Vector3(0, 0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      ...RIFLE,
      shooter: null,
      tracer: false,
    });
    // Um único tick move ~14,6 m — muito além da parede a 8 m.
    sys.update(1 / 60);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.material).toBe('concrete');
    expect(impacts[0]!.point.z).toBeCloseTo(-8, 1);
  });
});

describe('penetração por material', () => {
  const fire = (slabs: Slab[], penetration = RIFLE.penetration) => {
    const stub = new StubPhysics();
    stub.slabs = slabs;
    const sys = makeSystem(stub);
    const impacts: ImpactEvent[] = [];
    sys.onImpact = (e) => impacts.push(e);
    sys.fire({
      origin: new THREE.Vector3(0, 0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      ...RIFLE,
      penetration,
      shooter: null,
      tracer: false,
    });
    for (let i = 0; i < 30 && sys.activeCount > 0; i++) sys.update(1 / 60);
    return impacts;
  };

  it('atravessa madeira fina', () => {
    const impacts = fire([{ z: -10, thickness: 0.12, material: 'wood' }]);
    expect(impacts[0]!.penetrated).toBe(true);
  });

  it('para em concreto grosso', () => {
    const impacts = fire([{ z: -10, thickness: 0.3, material: 'concrete' }]);
    expect(impacts[0]!.penetrated).toBe(false);
  });

  it('para num saco de areia, que é mole mas espesso', () => {
    const impacts = fire([{ z: -10, thickness: 0.35, material: 'sandbag' }]);
    expect(impacts[0]!.penetrated).toBe(false);
  });

  it('gasta orçamento: atravessa a primeira placa e para na segunda', () => {
    const impacts = fire([
      { z: -10, thickness: 0.12, material: 'wood' },
      { z: -12, thickness: 0.12, material: 'wood' },
      { z: -14, thickness: 0.12, material: 'wood' },
      { z: -16, thickness: 0.12, material: 'wood' },
    ]);
    const atravessou = impacts.filter((i) => i.penetrated).length;
    expect(atravessou).toBeGreaterThan(0);
    expect(atravessou).toBeLessThan(4);
    expect(impacts[impacts.length - 1]!.penetrated).toBe(false);
  });
});

describe('dano por zona a partir do impacto', () => {
  class Alvo implements Damageable {
    readonly health = new ZoneHealth();
    hits: Array<{ zone: string; amount: number }> = [];
    get isAlive(): boolean {
      return this.health.alive;
    }
    worldPosition(out: THREE.Vector3): THREE.Vector3 {
      return out.set(0, 0, -10);
    }
    onDamaged(zone: string, amount: number): void {
      this.hits.push({ zone, amount });
    }
  }

  let alvo: Alvo;
  let stub: StubPhysics;

  beforeEach(() => {
    alvo = new Alvo();
    stub = new StubPhysics();
  });

  const shoot = (zone: string, distance: number) => {
    stub.slabs = [
      {
        z: -distance,
        thickness: 0.3,
        material: 'flesh',
        owner: { kind: 'body', entity: alvo, zone, material: 'flesh' },
      },
    ];
    const sys = makeSystem(stub);
    sys.fire({
      origin: new THREE.Vector3(0, 0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      ...RIFLE,
      shooter: null,
      tracer: false,
    });
    for (let i = 0; i < 40 && sys.activeCount > 0; i++) sys.update(1 / 60);
  };

  it('acerta a zona indicada pelo colisor', () => {
    shoot('legRight', 20);
    expect(alvo.hits).toHaveLength(1);
    expect(alvo.hits[0]!.zone).toBe('legRight');
  });

  it('a cabeça recebe o multiplicador da zona', () => {
    shoot('head', 20);
    expect(alvo.hits[0]!.amount).toBeCloseTo(26 * 2.6, 1);
  });

  it('dano cai com a distância', () => {
    shoot('torso', 20);
    const perto = alvo.hits[0]!.amount;
    alvo = new Alvo();
    shoot('torso', 300);
    const longe = alvo.hits[0]!.amount;
    expect(longe).toBeLessThan(perto);
  });
});
