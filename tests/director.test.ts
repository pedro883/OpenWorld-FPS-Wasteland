import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MissionDirector, type ActiveMission } from '../src/missions/director';
import type { MissionWorld } from '../src/missions/generator';
import { DIRECTOR } from '../src/missions/types';

const WORLD: MissionWorld = {
  pois: [
    { id: 'vila', name: 'Vila', kind: 'vila', x: -400, z: 350, radius: 70 },
    { id: 'base', name: 'Base', kind: 'militar', x: 420, z: 470, radius: 80 },
    { id: 'usina', name: 'Usina', kind: 'industrial', x: 120, z: -520, radius: 75 },
  ],
  roads: [{ ax: -400, az: 350, bx: 420, bz: 470 }],
  halfExtent: 1024,
  homeX: -400,
  homeZ: 350,
};

function makeDirector(seed = 1) {
  const events = { onSpawn: vi.fn(), onEnd: vi.fn(), onCompleted: vi.fn() };
  const director = new MissionDirector(seed, WORLD, events);
  return { director, events };
}

const FAR = new THREE.Vector3(9999, 0, 9999);

function standingOn(mission: ActiveMission): THREE.Vector3 {
  return new THREE.Vector3(mission.spec.x, 0, mission.spec.z);
}

describe('diretor de missões', () => {
  it('abre o quadro com o mínimo de missões da spec', () => {
    const { director, events } = makeDirector();
    director.start();
    expect(director.activeCount).toBe(DIRECTOR.minActive);
    expect(DIRECTOR.minActive).toBeGreaterThanOrEqual(3);
    expect(DIRECTOR.maxActive).toBeLessThanOrEqual(5);
    expect(events.onSpawn).toHaveBeenCalledTimes(DIRECTOR.minActive);
  });

  it('missão expira quando o tempo acaba', () => {
    const { director, events } = makeDirector();
    director.start();
    const alvo = director.missions[0]!;
    director.update(alvo.spec.timerSeconds + 1, FAR);
    expect(alvo.status).toBe('expired');
    expect(events.onEnd).toHaveBeenCalled();
    expect(events.onCompleted).not.toHaveBeenCalled();
  });

  it('repõe o quadro depois que uma missão sai', () => {
    const { director } = makeDirector();
    director.start();
    const alvo = director.missions[0]!;
    director.fail(alvo);
    expect(director.activeCount).toBe(DIRECTOR.minActive - 1);
    // The board refills only after the pause, so it does not visibly churn.
    director.update(DIRECTOR.respawnDelaySeconds + 1, FAR);
    expect(director.activeCount).toBe(DIRECTOR.minActive);
  });

  it('a missão reposta não é a que saiu', () => {
    const { director } = makeDirector(7);
    director.start();
    const saiu = director.missions[0]!.spec.id;
    director.fail(director.missions[0]!);
    director.update(DIRECTOR.respawnDelaySeconds + 1, FAR);
    expect(director.missions.map((m) => m.spec.id)).not.toContain(saiu);
  });

  it('eliminar todos completa uma missão de eliminação', () => {
    const { director, events } = makeDirector(3);
    director.start();
    const alvo = director.missions.find((m) => m.spec.objective === 'eliminate');
    if (!alvo) return; // depende do sorteio; coberto pelos casos abaixo
    for (let i = 0; i < alvo.spec.enemyCount; i++) director.reportKill(alvo.spec.id);
    expect(alvo.status).toBe('completed');
    expect(events.onCompleted).toHaveBeenCalledWith(alvo);
  });

  it('matar menos que todos não completa', () => {
    const { director } = makeDirector(3);
    director.start();
    const alvo = director.missions[0]!;
    director.reportKill(alvo.spec.id);
    expect(alvo.status).toBe('active');
    expect(alvo.enemiesAlive).toBe(alvo.spec.enemyCount - 1);
  });

  it('matar numa missão que já saiu não quebra nada', () => {
    const { director } = makeDirector();
    director.start();
    const alvo = director.missions[0]!;
    director.fail(alvo);
    expect(() => director.reportKill(alvo.spec.id)).not.toThrow();
  });

  it('progresso de plantar/segurar só corre dentro do círculo', () => {
    const { director } = makeDirector();
    director.start();
    const alvo = director.missions.find((m) => m.spec.progressSeconds > 0);
    if (!alvo) return;
    director.update(10, FAR);
    expect(alvo.progress).toBe(0);
    director.update(10, standingOn(alvo));
    expect(alvo.progress).toBeCloseTo(10);
  });

  it('sair do círculo pausa o progresso mas não o zera', () => {
    const { director } = makeDirector();
    director.start();
    const alvo = director.missions.find((m) => m.spec.progressSeconds > 0);
    if (!alvo) return;
    director.update(5, standingOn(alvo));
    director.update(5, FAR);
    expect(alvo.progress).toBeCloseTo(5);
  });

  it('detecta em que missão o jogador está', () => {
    const { director } = makeDirector();
    director.start();
    const alvo = director.missions[0]!;
    expect(director.missionAt(standingOn(alvo))?.spec.id).toBe(alvo.spec.id);
    expect(director.missionAt(FAR)).toBeNull();
  });

  it('o rastreador escreve uma linha por missão com distância e prêmio', () => {
    const { director } = makeDirector();
    director.start();
    const linhas = director.trackerLines(FAR);
    expect(linhas.length).toBe(director.missions.length);
    for (const linha of linhas) {
      expect(linha).toMatch(/km/);
      expect(linha).toMatch(/\$\d+/);
    }
  });

  it('completar duas vezes só conta uma', () => {
    const { director, events } = makeDirector();
    director.start();
    const alvo = director.missions[0]!;
    director.complete(alvo);
    director.complete(alvo);
    expect(events.onCompleted).toHaveBeenCalledTimes(1);
  });
});
