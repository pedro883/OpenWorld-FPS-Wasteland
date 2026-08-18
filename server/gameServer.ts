import worldConfig from '../config/world.json' with { type: 'json' };
import { Terrain } from '../src/world/terrain.ts';
import { WorldLayout } from '../src/world/layout.ts';
import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  SERVER_TICK_HZ,
  SNAPSHOT_HZ,
  encode,
  parseClientMessage,
  type ClientMessage,
  type PlayerState,
  type ServerMessage,
} from '../src/net/protocol.ts';
import { createBody, stepMovement, type NetPlayerBody } from '../src/net/movement.ts';
import { PositionHistory, eyeOf, rayHitsPlayer } from '../src/net/lagCompensation.ts';
import { INTERPOLATION_DELAY_MS } from '../src/net/protocol.ts';

export interface ServerOptions {
  seed: number;
  sizeMeters: number;
  heightScale: number;
  waterLevel: number;
  /** Spawn ring radius around the origin of the safe zone. */
  spawn: { x: number; z: number; radius: number };
  maxHealth: number;
}

/**
 * Read from the same `config/world.json` the client uses, never copied.
 *
 * Hand-copying these was a real bug: `waterLevel` was written as 0 here while
 * the config said 4, so the two sides computed different ground heights and the
 * client was corrected on *every* snapshot, even standing still. The terrain is
 * only a shared truth if both sides read the same numbers.
 */
function defaultOptions(): ServerOptions {
  const terrain = new Terrain({
    seed: worldConfig.seed,
    sizeMeters: worldConfig.sizeMeters,
    heightScale: worldConfig.heightScale,
    waterLevel: worldConfig.waterLevel,
  });
  // Spawn where single-player does: the village, which the layout derives from
  // the same seed.
  const village = new WorldLayout(terrain).pois[0];
  return {
    seed: worldConfig.seed,
    sizeMeters: worldConfig.sizeMeters,
    heightScale: worldConfig.heightScale,
    waterLevel: worldConfig.waterLevel,
    spawn: village
      ? { x: village.x, z: village.z, radius: village.radius * 0.6 }
      : { x: 0, z: 0, radius: 20 },
    maxHealth: 100,
  };
}

export const DEFAULT_OPTIONS: ServerOptions = defaultOptions();

/** Anything that can carry messages to one client. */
export interface Connection {
  send(data: string): void;
  close(): void;
}

interface ServerPlayer {
  id: number;
  name: string;
  conn: Connection;
  body: NetPlayerBody;
  health: number;
  /** Last input sequence applied, echoed back so the client can reconcile. */
  ack: number;
  history: PositionHistory;
  /** Round-trip time in ms, from pings; half of it is the rewind. */
  rtt: number;
  pending: ClientMessage[];
  speed: number;
  lastShotAt: number;
  joined: boolean;
}

/**
 * Authoritative game server.
 *
 * Deliberately transport-agnostic: it takes `Connection` objects rather than
 * sockets, which is what lets the acceptance test drive two clients through a
 * delay-injecting pipe instead of a real network. `ws` is wired to it in
 * `main.ts`.
 *
 * The server owns positions and health. It does *not* own the world: terrain
 * height comes from the same pure function the clients use, so no map data
 * crosses the wire and both sides agree on the ground for free.
 */
export class GameServer {
  private readonly terrain: Terrain;
  private readonly layout: WorldLayout;
  private readonly players = new Map<number, ServerPlayer>();
  private nextId = 1;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  /** Milliseconds since start; the clock every timestamp is measured against. */
  private time = 0;
  private startedAt = Date.now();

  private readonly options: ServerOptions;

  constructor(options: ServerOptions = DEFAULT_OPTIONS) {
    this.options = options;
    this.terrain = new Terrain({
      seed: options.seed,
      sizeMeters: options.sizeMeters,
      heightScale: options.heightScale,
      waterLevel: options.waterLevel,
    });
    // Building the layout is not optional bookkeeping: it *registers the
    // flatten discs* that level the ground under every POI and road. Skipping
    // it left the server reading raw terrain while the client read the levelled
    // village — 2.5 m apart at the spawn, which corrected the player on every
    // single snapshot even standing still.
    this.layout = new WorldLayout(this.terrain);
  }

  get playerCount(): number {
    return this.players.size;
  }

  get now(): number {
    return this.time;
  }

  /** Ground height, the one thing client and server must agree on exactly. */
  private ground = (x: number, z: number): number => this.terrain.heightAt(x, z);

  start(): void {
    if (this.tickTimer) return;
    this.startedAt = Date.now();
    this.tickTimer = setInterval(() => this.tick(1000 / SERVER_TICK_HZ), 1000 / SERVER_TICK_HZ);
    this.snapshotTimer = setInterval(() => this.broadcastSnapshot(), 1000 / SNAPSHOT_HZ);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.tickTimer = null;
    this.snapshotTimer = null;
    for (const player of this.players.values()) player.conn.close();
    this.players.clear();
  }

  /** Registers a connection. Returns the id, or null when the server is full. */
  connect(conn: Connection): number | null {
    if (this.players.size >= MAX_PLAYERS) {
      conn.send(encode({ t: 'reject', reason: 'servidor cheio' }));
      conn.close();
      return null;
    }
    const id = this.nextId++;
    const angle = (id / MAX_PLAYERS) * Math.PI * 2;
    const x = this.options.spawn.x + Math.cos(angle) * this.options.spawn.radius;
    const z = this.options.spawn.z + Math.sin(angle) * this.options.spawn.radius;
    const body = createBody(x, this.ground(x, z), z);

    this.players.set(id, {
      id,
      name: `jogador-${id}`,
      conn,
      body,
      health: this.options.maxHealth,
      ack: 0,
      history: new PositionHistory(),
      rtt: 0,
      pending: [],
      speed: 0,
      lastShotAt: -1000,
      joined: false,
    });
    return id;
  }

  disconnect(id: number): void {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: 'left', id });
  }

  /** Feeds one raw message from a client. */
  receive(id: number, raw: string): void {
    const player = this.players.get(id);
    if (!player) return;
    const msg = parseClientMessage(raw);
    if (!msg) return;

    switch (msg.t) {
      case 'join':
        if (msg.version !== PROTOCOL_VERSION) {
          player.conn.send(encode({ t: 'reject', reason: 'versão de protocolo diferente' }));
          player.conn.close();
          this.players.delete(id);
          return;
        }
        player.name = msg.name;
        player.joined = true;
        player.conn.send(
          encode({
            t: 'welcome',
            id,
            tickHz: SERVER_TICK_HZ,
            snapshotHz: SNAPSHOT_HZ,
            seed: this.options.seed,
            serverTime: this.time,
          }),
        );
        return;

      case 'input':
        // Queued rather than applied: inputs are consumed on the tick, so a
        // client that floods the socket cannot move faster than everyone else.
        if (player.pending.length < 32) player.pending.push(msg);
        return;

      case 'shot':
        player.pending.push(msg);
        return;

      case 'ping':
        if (msg.rtt) this.setRtt(id, msg.rtt);
        player.conn.send(encode({ t: 'pong', time: msg.time }));
        return;
    }
  }

  /** Reports a measured round trip, which sets how far shots rewind. */
  setRtt(id: number, rtt: number): void {
    const player = this.players.get(id);
    if (player) player.rtt = Math.max(0, Math.min(1000, rtt));
  }

  /** Advances the world by `dtMs`. Public so tests can step it by hand. */
  tick(dtMs: number): void {
    this.time += dtMs;

    for (const player of this.players.values()) {
      const before = { x: player.body.x, z: player.body.z };
      let moved = 0;

      for (const msg of player.pending) {
        if (msg.t === 'input') {
          stepMovement(player.body, msg.cmd, this.ground);
          player.ack = Math.max(player.ack, msg.cmd.seq);
          moved += msg.cmd.dt;
        } else if (msg.t === 'shot') {
          this.resolveShot(player, msg.shot);
        }
      }
      player.pending.length = 0;

      const travelled = Math.hypot(player.body.x - before.x, player.body.z - before.z);
      player.speed = moved > 0 ? travelled / moved : 0;
      player.history.record(this.time, player.body);
    }
  }

  /**
   * Resolves a shot against where the shooter saw the world.
   *
   * The rewind is the shooter's own latency plus the interpolation delay they
   * render at: what was on their screen is that much older than the present.
   * The client also sends the time it rendered, and the smaller of the two is
   * used — trusting the client's number outright would let it rewind targets
   * arbitrarily far and shoot the past.
   */
  private resolveShot(shooter: ServerPlayer, shot: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; damage: number; rangeMeters: number; renderTime: number }): void {
    if (shooter.health <= 0) return;
    // Rate limit, so a modified client cannot empty a magazine in one tick.
    if (this.time - shooter.lastShotAt < 40) return;
    shooter.lastShotAt = this.time;

    const eye = eyeOf(shooter.body);
    // The muzzle must be where the server thinks the shooter is, not where the
    // client claims: otherwise a client shoots from anywhere on the map.
    const drift = Math.hypot(shot.ox - eye.x, shot.oy - eye.y, shot.oz - eye.z);
    if (drift > 3) return;

    const length = Math.hypot(shot.dx, shot.dy, shot.dz);
    if (length < 1e-6) return;
    const dx = shot.dx / length;
    const dy = shot.dy / length;
    const dz = shot.dz / length;

    const ownRewind = shooter.rtt / 2 + INTERPOLATION_DELAY_MS;
    const claimed = this.time - shot.renderTime;
    const rewind = Math.max(0, Math.min(ownRewind, claimed > 0 ? claimed : ownRewind, 500));
    const at = this.time - rewind;

    let best: { player: ServerPlayer; distance: number; zone: string } | null = null;
    for (const target of this.players.values()) {
      if (target.id === shooter.id || target.health <= 0) continue;
      const past = target.history.at(at);
      if (!past) continue;
      const hit = rayHitsPlayer(eye.x, eye.y, eye.z, dx, dy, dz, shot.rangeMeters, past);
      if (hit && (!best || hit.distance < best.distance)) {
        best = { player: target, distance: hit.distance, zone: hit.zone };
      }
    }
    if (!best) return;

    const damage = best.zone === 'head' ? shot.damage * 2 : shot.damage;
    best.player.health = Math.max(0, best.player.health - damage);
    const killed = best.player.health <= 0;

    shooter.conn.send(
      encode({ t: 'hit', targetId: best.player.id, damage, zone: best.zone, killed }),
    );
    best.player.conn.send(
      encode({ t: 'damaged', byId: shooter.id, damage, health: best.player.health }),
    );

    if (killed) this.respawn(best.player);
  }

  private respawn(player: ServerPlayer): void {
    const angle = Math.random() * Math.PI * 2;
    const x = this.options.spawn.x + Math.cos(angle) * this.options.spawn.radius;
    const z = this.options.spawn.z + Math.sin(angle) * this.options.spawn.radius;
    player.body.x = x;
    player.body.z = z;
    player.body.y = this.ground(x, z);
    player.body.vy = 0;
    player.health = this.options.maxHealth;
    player.history.clear();
  }

  private stateOf(player: ServerPlayer): PlayerState {
    return {
      id: player.id,
      name: player.name,
      x: player.body.x,
      y: player.body.y,
      z: player.body.z,
      yaw: player.body.yaw,
      pitch: player.body.pitch,
      health: player.health,
      crouched: player.body.crouched,
      speed: player.speed,
    };
  }

  /** Snapshot to everyone. Each client gets its own acknowledged sequence. */
  broadcastSnapshot(): void {
    const players = [...this.players.values()].filter((p) => p.joined).map((p) => this.stateOf(p));
    if (!players.length) return;
    for (const player of this.players.values()) {
      if (!player.joined) continue;
      player.conn.send(
        encode({ t: 'snapshot', time: this.time, ack: player.ack, players }),
      );
    }
  }

  private broadcast(message: ServerMessage): void {
    const data = encode(message);
    for (const player of this.players.values()) player.conn.send(data);
  }

  /** For the console and for tests. */
  debugState(): { time: number; players: { id: number; x: number; z: number; health: number }[] } {
    return {
      time: this.time,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        x: p.body.x,
        z: p.body.z,
        health: p.health,
      })),
    };
  }

  get uptimeSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }
}
