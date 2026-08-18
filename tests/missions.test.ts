import { describe, expect, it } from 'vitest';
import { Random } from '../src/core/random';
import { fillBoard, generateMission, type MissionWorld } from '../src/missions/generator';
import { DIRECTOR, MISSION_TYPES, missionType } from '../src/missions/types';

const WORLD: MissionWorld = {
  pois: [
    { id: 'vila', name: 'Vila Cinza', kind: 'vila', x: -400, z: 350, radius: 70 },
    { id: 'base', name: 'Posto Ferro', kind: 'militar', x: 420, z: 470, radius: 80 },
    { id: 'usina', name: 'Usina', kind: 'industrial', x: 120, z: -520, radius: 75 },
  ],
  roads: [
    { ax: -400, az: 350, bx: 420, bz: 470 },
    { ax: 420, az: 470, bx: 120, bz: -520 },
  ],
  halfExtent: 1024,
  homeX: -400,
  homeZ: 350,
};

describe('gerador de missões', () => {
  it('a spec pede pelo menos 5 tipos e nós temos 7', () => {
    expect(MISSION_TYPES.length).toBeGreaterThanOrEqual(5);
    for (const id of ['convoy', 'outpost', 'supplyDrop', 'hvt', 'rescue', 'sabotage', 'sector']) {
      expect(missionType(id), id).not.toBeNull();
    }
  });

  it('a mesma semente gera a mesma missão', () => {
    const a = generateMission(new Random(5), WORLD);
    const b = generateMission(new Random(5), WORLD);
    expect(a).toEqual(b);
  });

  it('sementes diferentes geram missões diferentes', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const mission = generateMission(new Random(i), WORLD);
      ids.add(`${mission!.type}@${mission!.x.toFixed(0)},${mission!.z.toFixed(0)}`);
    }
    expect(ids.size).toBeGreaterThan(20);
  });

  it('a recompensa cresce com a dificuldade', () => {
    const media = (type: string) => {
      let total = 0;
      for (let i = 0; i < 200; i++) total += generateMission(new Random(i), WORLD, [], type)!.reward;
      return total / 200;
    };
    // supplyDrop é dificuldade 1, sector é 5.
    expect(media('sector')).toBeGreaterThan(media('supplyDrop'));
  });

  it('missão mais longe de casa paga mais', () => {
    const perto: MissionWorld = { ...WORLD, homeX: 420, homeZ: 470 };
    const longe: MissionWorld = { ...WORLD, homeX: -1000, homeZ: -1000 };
    const media = (world: MissionWorld) => {
      let total = 0;
      for (let i = 0; i < 200; i++) total += generateMission(new Random(i), world, [], 'outpost')!.reward;
      return total / 200;
    };
    expect(media(longe)).toBeGreaterThan(media(perto));
  });

  it('missão de POI cai num POI do tipo permitido', () => {
    for (let i = 0; i < 60; i++) {
      const mission = generateMission(new Random(i), WORLD, [], 'hvt')!;
      const perto = WORLD.pois.some(
        (poi) => Math.hypot(poi.x - mission.x, poi.z - mission.z) <= poi.radius,
      );
      expect(perto).toBe(true);
    }
  });

  it('o posto avançado só nasce em POI militar ou industrial', () => {
    const permitidos = missionType('outpost')!.poiKinds!;
    for (let i = 0; i < 60; i++) {
      const mission = generateMission(new Random(i), WORLD, [], 'outpost')!;
      const poi = WORLD.pois.find((p) => Math.hypot(p.x - mission.x, p.z - mission.z) <= p.radius);
      expect(permitidos).toContain(poi!.kind);
    }
  });

  it('o comboio cai sobre uma estrada, longe das pontas', () => {
    for (let i = 0; i < 40; i++) {
      const m = generateMission(new Random(i), WORLD, [], 'convoy')!;
      const naEstrada = WORLD.roads.some((road) => {
        const dx = road.bx - road.ax;
        const dz = road.bz - road.az;
        const t = ((m.x - road.ax) * dx + (m.z - road.az) * dz) / (dx * dx + dz * dz);
        if (t < 0.2 || t > 0.8) return false;
        const px = road.ax + dx * t;
        const pz = road.az + dz * t;
        return Math.hypot(m.x - px, m.z - pz) < 1;
      });
      expect(naEstrada).toBe(true);
    }
  });

  it('missão de campo aberto fica dentro do mapa', () => {
    for (let i = 0; i < 60; i++) {
      const m = generateMission(new Random(i), WORLD, [], 'supplyDrop')!;
      expect(Math.abs(m.x)).toBeLessThanOrEqual(WORLD.halfExtent);
      expect(Math.abs(m.z)).toBeLessThanOrEqual(WORLD.halfExtent);
    }
  });

  it('o quadro enche até o número pedido', () => {
    const board = fillBoard(new Random(3), WORLD, [], DIRECTOR.maxActive);
    expect(board.length).toBe(DIRECTOR.maxActive);
    expect(new Set(board.map((m) => m.id)).size).toBe(board.length);
  });

  it('preserva as missões que já estavam no quadro', () => {
    const first = fillBoard(new Random(3), WORLD, [], 2);
    const second = fillBoard(new Random(9), WORLD, first, 5);
    expect(second.slice(0, 2)).toEqual(first);
  });

  it('espalha as missões em vez de empilhar tudo num canto', () => {
    // Missions stacked on one hillside read as a single long fight.
    const board = fillBoard(new Random(11), WORLD, [], DIRECTOR.maxActive);
    let apertadas = 0;
    for (let i = 0; i < board.length; i++) {
      for (let j = i + 1; j < board.length; j++) {
        const d = Math.hypot(board[i]!.x - board[j]!.x, board[i]!.z - board[j]!.z);
        if (d < DIRECTOR.minSpacingMeters) apertadas++;
      }
    }
    expect(apertadas).toBeLessThanOrEqual(1);
  });

  it('a composição de inimigos respeita a faixa do tipo', () => {
    for (const type of MISSION_TYPES) {
      for (let i = 0; i < 30; i++) {
        const m = generateMission(new Random(i), WORLD, [], type.id)!;
        expect(m.enemyCount).toBeGreaterThanOrEqual(type.enemies.count[0]);
        expect(m.enemyCount).toBeLessThanOrEqual(type.enemies.count[1]);
        expect(m.enemySkill).toBe(type.enemies.skill);
        expect(m.timerSeconds).toBeGreaterThan(0);
      }
    }
  });

  it('um mundo sem lugar nenhum não gera missão em vez de quebrar', () => {
    const vazio: MissionWorld = { pois: [], roads: [], halfExtent: 500, homeX: 0, homeZ: 0 };
    // Wilderness still works with no POIs; POI-only types must bow out.
    expect(generateMission(new Random(1), vazio, [], 'outpost')).toBeNull();
    expect(generateMission(new Random(1), vazio, [], 'supplyDrop')).not.toBeNull();
  });
});
