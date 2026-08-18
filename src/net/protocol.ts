/**
 * The wire protocol, shared by client and server.
 *
 * Messages are JSON. At sixteen players and twenty snapshots a second this is
 * a few dozen kilobytes per second per client — well inside what a browser
 * socket does without noticing — and being readable is worth more here than
 * the bytes a binary encoding would save.
 *
 * Everything arriving from a client goes through `parseClientMessage`, which
 * treats the socket as hostile: a server that trusts a position field is a
 * server that can be teleported.
 */

export const PROTOCOL_VERSION = 1;
/** Authoritative simulation rate. */
export const SERVER_TICK_HZ = 30;
/** How often the server ships state. */
export const SNAPSHOT_HZ = 20;
/** How far behind the newest snapshot remote players are drawn. */
export const INTERPOLATION_DELAY_MS = 100;
export const MAX_PLAYERS = 16;

export interface InputCommand {
  /** Monotonic per client; the server acknowledges the last one it applied. */
  seq: number;
  /** Seconds this command covers. Clamped server-side. */
  dt: number;
  forward: number;
  strafe: number;
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
}

export interface PlayerState {
  id: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  crouched: boolean;
  /** Speed on the horizontal plane, so remotes can pick an animation. */
  speed: number;
}

export interface ShotRequest {
  /** Where the client says it fired from, checked against its own position. */
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  weapon: string;
  damage: number;
  rangeMeters: number;
  /** Server time the client believed it was shooting at, for the rewind. */
  renderTime: number;
}

export type ClientMessage =
  | { t: 'join'; name: string; version: number }
  | { t: 'input'; cmd: InputCommand }
  | { t: 'shot'; shot: ShotRequest }
  | { t: 'ping'; time: number; rtt?: number };

export type ServerMessage =
  | { t: 'welcome'; id: number; tickHz: number; snapshotHz: number; seed: number; serverTime: number }
  | { t: 'reject'; reason: string }
  | { t: 'snapshot'; time: number; ack: number; players: PlayerState[] }
  | { t: 'hit'; targetId: number; damage: number; zone: string; killed: boolean }
  | { t: 'damaged'; byId: number; damage: number; health: number }
  | { t: 'left'; id: number }
  | { t: 'pong'; time: number };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampNumber(value: unknown, min: number, max: number, fallback = 0): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Parses and sanitises an inbound client message.
 *
 * Returns null for anything malformed rather than throwing, so one bad frame
 * costs that client its message and not the whole server. Numeric fields are
 * clamped here rather than trusted: `dt` in particular is the field a cheating
 * client would inflate to move further per command than anyone else.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const msg = data as Record<string, unknown>;

  switch (msg.t) {
    case 'join':
      return {
        t: 'join',
        name: typeof msg.name === 'string' ? msg.name.slice(0, 24) : 'sem-nome',
        version: isFiniteNumber(msg.version) ? msg.version : 0,
      };

    case 'input': {
      const cmd = msg.cmd as Record<string, unknown> | undefined;
      if (!cmd || typeof cmd !== 'object' || !isFiniteNumber(cmd.seq)) return null;
      return {
        t: 'input',
        cmd: {
          seq: Math.floor(cmd.seq),
          // A command may never claim more than a tick and a half of time.
          dt: clampNumber(cmd.dt, 0, 0.05, 0),
          forward: clampNumber(cmd.forward, -1, 1),
          strafe: clampNumber(cmd.strafe, -1, 1),
          yaw: clampNumber(cmd.yaw, -Math.PI * 4, Math.PI * 4),
          pitch: clampNumber(cmd.pitch, -Math.PI / 2, Math.PI / 2),
          jump: cmd.jump === true,
          sprint: cmd.sprint === true,
          crouch: cmd.crouch === true,
        },
      };
    }

    case 'shot': {
      const shot = msg.shot as Record<string, unknown> | undefined;
      if (!shot || typeof shot !== 'object') return null;
      if (!isFiniteNumber(shot.ox) || !isFiniteNumber(shot.dx)) return null;
      return {
        t: 'shot',
        shot: {
          ox: clampNumber(shot.ox, -100000, 100000),
          oy: clampNumber(shot.oy, -100000, 100000),
          oz: clampNumber(shot.oz, -100000, 100000),
          dx: clampNumber(shot.dx, -1, 1),
          dy: clampNumber(shot.dy, -1, 1),
          dz: clampNumber(shot.dz, -1, 1),
          weapon: typeof shot.weapon === 'string' ? shot.weapon.slice(0, 32) : '',
          // Damage is clamped, not trusted: the server caps what any weapon can do.
          damage: clampNumber(shot.damage, 0, 200, 0),
          rangeMeters: clampNumber(shot.rangeMeters, 0, 1200, 300),
          renderTime: clampNumber(shot.renderTime, 0, Number.MAX_SAFE_INTEGER, 0),
        },
      };
    }

    case 'ping':
      return {
        t: 'ping',
        time: isFiniteNumber(msg.time) ? msg.time : 0,
        // Client-reported, and therefore clamped: the rewind it feeds is also
        // capped server-side, so a lying client buys itself nothing.
        rtt: clampNumber(msg.rtt, 0, 1000, 0),
      };

    default:
      return null;
  }
}

export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}
