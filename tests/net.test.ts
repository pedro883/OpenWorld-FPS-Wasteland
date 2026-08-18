import { describe, expect, it } from 'vitest';
import { GameServer, DEFAULT_OPTIONS, type Connection } from '../server/gameServer';
import { NetClient, type Socket } from '../src/net/client';
import { RemoteInterpolator } from '../src/net/interpolation';
import { PositionHistory, rayHitsPlayer } from '../src/net/lagCompensation';
import { createBody, stepMovement } from '../src/net/movement';
import { parseClientMessage, type InputCommand, type PlayerState } from '../src/net/protocol';
import { Terrain } from '../src/world/terrain';
import { WorldLayout } from '../src/world/layout';

const RTT_MS = 100;
const ONE_WAY_MS = RTT_MS / 2;
const FRAME_MS = 1000 / 60;

const terrain = new Terrain({
  seed: DEFAULT_OPTIONS.seed,
  sizeMeters: DEFAULT_OPTIONS.sizeMeters,
  heightScale: DEFAULT_OPTIONS.heightScale,
  waterLevel: DEFAULT_OPTIONS.waterLevel,
});
// The layout is what registers the flatten discs under the POIs. A client that
// skips it reads raw terrain where the server reads levelled ground, which is
// exactly the divergence these tests exist to catch.
new WorldLayout(terrain);
const ground = (x: number, z: number): number => terrain.heightAt(x, z);

/** A virtual clock with a delivery queue, so latency is exact and repeatable. */
class Bus {
  now = 0;
  private queue: { at: number; fn: () => void }[] = [];

  schedule(delay: number, fn: () => void): void {
    this.queue.push({ at: this.now + delay, fn });
  }

  advance(dt: number): void {
    this.now += dt;
    const due = this.queue.filter((q) => q.at <= this.now).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((q) => q.at > this.now);
    for (const item of due) item.fn();
  }
}

interface Harness {
  client: NetClient;
  id: number;
  hits: { targetId: number; zone: string; damage: number }[];
}

/** Returns null when the server turns the connection away, as it does when full. */
function connect(bus: Bus, server: GameServer, name: string): Harness | null {
  const hits: Harness['hits'] = [];
  const client = new NetClient(ground, {
    onHit: (targetId, damage, zone) => hits.push({ targetId, damage, zone }),
  });

  let socket: Socket;
  const conn: Connection = {
    // Server -> client, delayed.
    send: (data) => bus.schedule(ONE_WAY_MS, () => socket.onmessage?.(data)),
    close: () => undefined,
  };
  const id = server.connect(conn);
  if (id === null) return null;
  socket = {
    // Client -> server, delayed by the same amount.
    send: (data) => bus.schedule(ONE_WAY_MS, () => server.receive(id, data)),
    close: () => undefined,
    onmessage: null,
    onclose: null,
    onopen: null,
  };
  client.attach(socket, name);
  socket.onopen?.();
  server.setRtt(id, RTT_MS);
  return { client, id, hits };
}

function command(overrides: Partial<InputCommand> = {}): Omit<InputCommand, 'seq'> {
  return {
    dt: FRAME_MS / 1000,
    forward: 0,
    strafe: 0,
    yaw: 0,
    pitch: 0,
    jump: false,
    sprint: false,
    crouch: false,
    ...overrides,
  };
}

/** Runs the world forward, ticking the server and both clients in lockstep. */
function run(
  bus: Bus,
  server: GameServer,
  clients: Harness[],
  seconds: number,
  drive: (h: Harness, index: number, t: number) => void = () => undefined,
): void {
  const frames = Math.round((seconds * 1000) / FRAME_MS);
  let sinceSnapshot = 0;
  for (let i = 0; i < frames; i++) {
    clients.forEach((h, index) => drive(h, index, (i * FRAME_MS) / 1000));
    bus.advance(FRAME_MS);
    server.tick(FRAME_MS);
    for (const h of clients) h.client.update(FRAME_MS);
    sinceSnapshot += FRAME_MS;
    // The server ships state at its own rate, not once per frame.
    if (sinceSnapshot >= 1000 / 20) {
      sinceSnapshot = 0;
      server.broadcastSnapshot();
    }
  }
}

function serverPosition(server: GameServer, id: number): { x: number; z: number } {
  const state = server.debugState().players.find((p) => p.id === id)!;
  return { x: state.x, z: state.z };
}

describe('protocolo', () => {
  it('recusa lixo em vez de derrubar o servidor', () => {
    expect(parseClientMessage('nao é json')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
    expect(parseClientMessage('{"t":"desconhecido"}')).toBeNull();
    expect(parseClientMessage('{"t":"input"}')).toBeNull();
  });

  it('limita o dt que um comando pode reivindicar', () => {
    // Inflating dt is how a modified client would move further per command.
    const msg = parseClientMessage('{"t":"input","cmd":{"seq":1,"dt":9999}}');
    expect(msg?.t).toBe('input');
    if (msg?.t === 'input') expect(msg.cmd.dt).toBeLessThanOrEqual(0.05);
  });

  it('limita o dano que um cliente pode declarar', () => {
    const msg = parseClientMessage('{"t":"shot","shot":{"ox":0,"oy":0,"oz":0,"dx":1,"dy":0,"dz":0,"damage":99999}}');
    if (msg?.t === 'shot') expect(msg.shot.damage).toBeLessThanOrEqual(200);
  });
});

describe('movimento determinístico', () => {
  it('o mesmo comando dá o mesmo resultado dos dois lados', () => {
    const a = createBody(0, ground(0, 0), 0);
    const b = createBody(0, ground(0, 0), 0);
    const cmds = Array.from({ length: 40 }, (_, i) =>
      ({ ...command({ forward: 1, strafe: i % 3 === 0 ? 1 : 0, yaw: i * 0.05 }), seq: i }),
    );
    for (const cmd of cmds) stepMovement(a, cmd, ground);
    for (const cmd of cmds) stepMovement(b, cmd, ground);
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
  });

  it('diagonal não é mais rápida que reto', () => {
    const straight = createBody(0, ground(0, 0), 0);
    const diagonal = createBody(0, ground(0, 0), 0);
    for (let i = 0; i < 60; i++) {
      stepMovement(straight, { ...command({ forward: 1 }), seq: i }, ground);
      stepMovement(diagonal, { ...command({ forward: 1, strafe: 1 }), seq: i }, ground);
    }
    const d1 = Math.hypot(straight.x, straight.z);
    const d2 = Math.hypot(diagonal.x, diagonal.z);
    expect(d2).toBeLessThanOrEqual(d1 + 1e-9);
  });
});

describe('interpolação', () => {
  const state = (id: number, x: number): PlayerState => ({
    id,
    name: 'p',
    x,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 100,
    crouched: false,
    speed: 0,
  });

  it('interpola entre os dois snapshots que cercam o instante', () => {
    const buffer = new RemoteInterpolator();
    buffer.push(1000, state(1, 0));
    buffer.push(1050, state(1, 5));
    expect(buffer.sample(1025)!.x).toBeCloseTo(2.5, 5);
  });

  it('segura o último estado em vez de extrapolar', () => {
    // Guessing forward makes a player who stopped keep walking, then snap back.
    const buffer = new RemoteInterpolator();
    buffer.push(1000, state(1, 0));
    buffer.push(1050, state(1, 5));
    expect(buffer.sample(9999)!.x).toBe(5);
  });

  it('descarta pacote fora de ordem', () => {
    const buffer = new RemoteInterpolator();
    buffer.push(1050, state(1, 5));
    buffer.push(1000, state(1, 0));
    expect(buffer.sampleCount).toBe(1);
  });

  it('ângulo cruza o norte pelo caminho curto', () => {
    const buffer = new RemoteInterpolator();
    buffer.push(0, { ...state(1, 0), yaw: -3.0 });
    buffer.push(100, { ...state(1, 0), yaw: 3.0 });
    const mid = buffer.sample(50)!.yaw;
    // The short way passes through ±π, not through zero.
    expect(Math.abs(mid)).toBeGreaterThan(3.0);
  });
});

describe('compensação de lag', () => {
  it('rebobina para onde o alvo estava', () => {
    const history = new PositionHistory();
    const body = createBody(0, 0, 0);
    for (let t = 0; t <= 1000; t += 50) {
      body.x = t / 100;
      history.record(t, body);
    }
    expect(history.at(500)!.x).toBeCloseTo(5, 5);
    expect(history.at(1000)!.x).toBeCloseTo(10, 5);
  });

  it('acerta a cabeça acima da fração de altura', () => {
    const target = { time: 0, x: 10, y: 0, z: 0, crouched: false };
    const torso = rayHitsPlayer(0, 1.0, 0, 1, 0, 0, 50, target);
    const head = rayHitsPlayer(0, 1.7, 0, 1, 0, 0, 50, target);
    expect(torso?.zone).toBe('torso');
    expect(head?.zone).toBe('head');
  });

  it('erra quem está fora do raio do corpo', () => {
    const target = { time: 0, x: 10, y: 0, z: 1.5, crouched: false };
    expect(rayHitsPlayer(0, 1.0, 0, 1, 0, 0, 50, target)).toBeNull();
  });

  it('agachado apresenta um alvo mais baixo', () => {
    const target = { time: 0, x: 10, y: 0, z: 0, crouched: true };
    expect(rayHitsPlayer(0, 1.6, 0, 1, 0, 0, 50, target)).toBeNull();
    expect(rayHitsPlayer(0, 1.0, 0, 1, 0, 0, 50, target)).not.toBeNull();
  });
});

describe('dois clientes com 100 ms de latência', () => {
  it('veem a mesma posição depois que o movimento para', () => {
    const bus = new Bus();
    const server = new GameServer();
    const a = connect(bus, server, 'a')!;
    const b = connect(bus, server, 'b')!;

    // A walks for two seconds, then stands still long enough for B's
    // interpolation buffer to catch up.
    run(bus, server, [a, b], 2, (h, index) => {
      if (index === 0) h.client.sendInput(command({ forward: 1 }));
      else h.client.sendInput(command());
    });
    run(bus, server, [a, b], 1, (h) => h.client.sendInput(command()));

    const authoritative = serverPosition(server, a.id);
    const seenByB = b.client.remoteStates().find((p) => p.id === a.id)!;
    expect(seenByB).toBeDefined();
    expect(Math.hypot(seenByB.x - authoritative.x, seenByB.z - authoritative.z)).toBeLessThan(0.05);

    // And A's own prediction agrees with the server it is predicting.
    expect(Math.hypot(a.client.body.x - authoritative.x, a.client.body.z - authoritative.z))
      .toBeLessThan(0.05);
    server.stop();
  });

  it('a predição local não fica presa atrás do servidor enquanto anda', () => {
    const bus = new Bus();
    const server = new GameServer();
    const a = connect(bus, server, 'a')!;
    const b = connect(bus, server, 'b')!;
    const start = a.client.body.x;

    run(bus, server, [a, b], 1.5, (h, index) => {
      h.client.sendInput(command({ forward: index === 0 ? 1 : 0 }));
    });

    // Without prediction the local player would sit a full round trip behind.
    const predicted = Math.hypot(a.client.body.x - start, a.client.body.z - 0);
    expect(predicted).toBeGreaterThan(4);
    server.stop();
  });

  it('o tiro acerta onde o atirador viu o alvo, não onde ele já está', () => {
    const bus = new Bus();
    const server = new GameServer();
    const a = connect(bus, server, 'a')!;
    const b = connect(bus, server, 'b')!;

    // Settle, then B strafes across A's line of sight while A fires at the
    // position A can actually see — which is already 150 ms old.
    run(bus, server, [a, b], 0.5, (h) => h.client.sendInput(command()));

    let fired = false;
    let aimedAt: PlayerState | null = null;
    run(bus, server, [a, b], 2, (h, index, t) => {
      if (index === 1) {
        h.client.sendInput(command({ strafe: 1, yaw: 0 }));
        return;
      }
      h.client.sendInput(command());
      if (!fired && t > 1.0) {
        const seen = h.client.remoteStates().find((p) => p.id === b.id);
        if (!seen) return;
        aimedAt = seen;
        const eye = { x: h.client.body.x, y: h.client.body.y + 1.65, z: h.client.body.z };
        const target = { x: seen.x, y: seen.y + 1.2, z: seen.z };
        const dx = target.x - eye.x;
        const dy = target.y - eye.y;
        const dz = target.z - eye.z;
        const len = Math.hypot(dx, dy, dz);
        h.client.fire({
          ox: eye.x,
          oy: eye.y,
          oz: eye.z,
          dx: dx / len,
          dy: dy / len,
          dz: dz / len,
          weapon: 'rifle_m4x',
          damage: 30,
          rangeMeters: 300,
        });
        fired = true;
      }
    });

    expect(fired).toBe(true);
    expect(a.hits.length).toBeGreaterThan(0);
    expect(a.hits[0]!.targetId).toBe(b.id);

    // The same ray against where B is *now* would have missed: that gap is
    // exactly what the rewind exists to close.
    const now = serverPosition(server, b.id);
    const seen = aimedAt!;
    expect(Math.hypot(now.x - seen.x, now.z - seen.z)).toBeGreaterThan(0.42);
    server.stop();
  });

  it('o alvo é avisado do dano que levou', () => {
    const bus = new Bus();
    const server = new GameServer();
    const a = connect(bus, server, 'a')!;
    const b = connect(bus, server, 'b')!;
    let damaged = 0;
    b.client.health = 100;
    const client = b.client as unknown as { events: { onDamaged?: (id: number, d: number, h: number) => void } };
    void client;

    run(bus, server, [a, b], 0.5, (h) => h.client.sendInput(command()));
    // Aimed in three dimensions at B's chest. A flat ray would be wrong: even
    // on levelled ground the two spawn points sit at slightly different
    // heights, and at eighteen metres that is enough to pass over a head.
    const eye = { x: a.client.body.x, y: a.client.body.y + 1.65, z: a.client.body.z };
    const chest = { x: b.client.body.x, y: b.client.body.y + 1.2, z: b.client.body.z };
    const dx = chest.x - eye.x;
    const dy = chest.y - eye.y;
    const dz = chest.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    a.client.fire({
      ox: eye.x,
      oy: eye.y,
      oz: eye.z,
      dx: dx / len,
      dy: dy / len,
      dz: dz / len,
      weapon: 'rifle_m4x',
      damage: 30,
      rangeMeters: 300,
    });
    run(bus, server, [a, b], 0.6, (h) => h.client.sendInput(command()));
    damaged = b.client.health;
    expect(a.hits.length, `sem acerto; distância ${len.toFixed(1)} m`).toBeGreaterThan(0);
    expect(damaged).toBeLessThan(100);
    server.stop();
  });

  it('recusa tiro cuja origem não bate com onde o servidor põe o atirador', () => {
    const bus = new Bus();
    const server = new GameServer();
    const a = connect(bus, server, 'a')!;
    const b = connect(bus, server, 'b')!;
    run(bus, server, [a, b], 0.5, (h) => h.client.sendInput(command()));

    const bPos = serverPosition(server, b.id);
    // Claiming to shoot from right next to the victim, from across the map.
    a.client.fire({
      ox: bPos.x - 1,
      oy: 1.6,
      oz: bPos.z,
      dx: 1,
      dy: 0,
      dz: 0,
      weapon: 'rifle_m4x',
      damage: 200,
      rangeMeters: 300,
    });
    run(bus, server, [a, b], 0.6, (h) => h.client.sendInput(command()));
    expect(a.hits.length).toBe(0);
    expect(b.client.health).toBe(100);
    server.stop();
  });

  it('suporta os 16 jogadores da spec', () => {
    const bus = new Bus();
    const server = new GameServer();
    const clients = Array.from({ length: 16 }, (_, i) => connect(bus, server, `p${i}`)!);
    run(bus, server, clients, 0.4, (h) => h.client.sendInput(command({ forward: 1 })));
    expect(server.playerCount).toBe(16);
    // The seventeenth is turned away rather than accepted and dropped later.
    expect(connect(bus, server, 'p17')).toBeNull();
    server.stop();
  });
});
