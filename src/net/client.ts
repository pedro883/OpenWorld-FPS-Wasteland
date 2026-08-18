import { RemoteInterpolator } from './interpolation';
import { createBody, positionError, stepMovement, type GroundSampler, type NetPlayerBody } from './movement';
import {
  INTERPOLATION_DELAY_MS,
  PROTOCOL_VERSION,
  encode,
  type ClientMessage,
  type InputCommand,
  type PlayerState,
  type ServerMessage,
  type ShotRequest,
} from './protocol';

/** Beyond this the correction is applied hard; below it, it is eased in. */
const SNAP_ERROR_METRES = 2.5;
/** Below this the server and the prediction agree closely enough to ignore. */
const IGNORE_ERROR_METRES = 0.02;

export interface NetClientEvents {
  onWelcome?(id: number, seed: number): void;
  onReject?(reason: string): void;
  onHit?(targetId: number, damage: number, zone: string, killed: boolean): void;
  onDamaged?(byId: number, damage: number, health: number): void;
  onLeft?(id: number): void;
  onDisconnect?(): void;
}

/** Anything that behaves like a WebSocket, so tests can substitute a pipe. */
export interface Socket {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
  onopen: (() => void) | null;
}

/**
 * The client half of the netcode: prediction, reconciliation, interpolation.
 *
 * The local player moves the instant a key is pressed rather than waiting for
 * the server to agree — at 100 ms that wait is the difference between a game
 * that feels responsive and one that feels broken. Every command is kept until
 * the server acknowledges it, so when a correction arrives the client can rewind
 * to the authoritative state and replay everything the server had not yet seen,
 * landing exactly where the server will a moment later.
 */
export class NetClient {
  readonly body: NetPlayerBody = createBody(0, 0, 0);
  /** Server-assigned id, or 0 before the welcome arrives. */
  id = 0;
  health = 100;
  connected = false;

  private socket: Socket | null = null;
  private seq = 1;
  /** Commands sent but not yet acknowledged, replayed after a correction. */
  private readonly unacknowledged: InputCommand[] = [];
  private readonly remotes = new Map<number, RemoteInterpolator>();
  private readonly names = new Map<number, string>();
  /** Server clock estimate, advanced locally between snapshots. */
  private serverTime = 0;
  private lastSnapshotAt = 0;
  private rtt = 0;
  private corrections = 0;
  private snapshotsReceived = 0;

  constructor(
    private readonly ground: GroundSampler,
    private readonly events: NetClientEvents = {},
  ) {}

  get roundTripMs(): number {
    return this.rtt;
  }

  get correctionCount(): number {
    return this.corrections;
  }

  get snapshotCount(): number {
    return this.snapshotsReceived;
  }

  get pendingCount(): number {
    return this.unacknowledged.length;
  }

  get remoteIds(): number[] {
    return [...this.remotes.keys()];
  }

  nameOf(id: number): string {
    return this.names.get(id) ?? `jogador-${id}`;
  }

  attach(socket: Socket, name: string): void {
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.send({ t: 'join', name, version: PROTOCOL_VERSION });
    };
    socket.onmessage = (data) => this.handle(data);
    socket.onclose = () => {
      this.connected = false;
      this.events.onDisconnect?.();
    };
  }

  /** Opens a real WebSocket. Tests hand in their own socket via `attach`. */
  connect(url: string, name: string): void {
    const raw = new WebSocket(url);
    const adapter: Socket = {
      send: (data) => raw.send(data),
      close: () => raw.close(),
      onmessage: null,
      onclose: null,
      onopen: null,
    };
    raw.onopen = () => adapter.onopen?.();
    raw.onmessage = (event) => adapter.onmessage?.(String(event.data));
    raw.onclose = () => adapter.onclose?.();
    this.attach(adapter, name);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.connected = false;
    this.remotes.clear();
  }

  private send(message: ClientMessage): void {
    this.socket?.send(encode(message));
  }

  /**
   * Applies a command locally *and* sends it.
   *
   * The order matters: predicting first is what removes the latency from the
   * player's own movement, and keeping the command lets the replay reproduce it
   * exactly when the server's version of events turns out to differ.
   */
  sendInput(partial: Omit<InputCommand, 'seq'>): void {
    const cmd: InputCommand = { ...partial, seq: this.seq++ };
    stepMovement(this.body, cmd, this.ground);
    this.unacknowledged.push(cmd);
    // A client that cannot keep up drops the oldest rather than growing forever.
    if (this.unacknowledged.length > 120) this.unacknowledged.shift();
    this.send({ t: 'input', cmd });
  }

  fire(shot: Omit<ShotRequest, 'renderTime'>): void {
    this.send({ t: 'shot', shot: { ...shot, renderTime: this.renderTime } });
  }

  ping(): void {
    // The measured trip rides along, because only the client can measure it:
    // the server's clock and the client's are unrelated.
    this.send({ t: 'ping', time: Date.now(), rtt: this.rtt });
  }

  /** Advances the local estimate of the server clock between snapshots. */
  update(dtMs: number): void {
    this.serverTime += dtMs;
  }

  /** The instant remote players are drawn at. */
  get renderTime(): number {
    return this.serverTime - INTERPOLATION_DELAY_MS;
  }

  /** Interpolated state of every other player, ready to be drawn. */
  remoteStates(): PlayerState[] {
    const out: PlayerState[] = [];
    const at = this.renderTime;
    for (const [id, buffer] of this.remotes) {
      const state = buffer.sample(at);
      if (state && id !== this.id) out.push(state);
    }
    return out;
  }

  private handle(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'welcome':
        this.id = msg.id;
        this.serverTime = msg.serverTime;
        this.events.onWelcome?.(msg.id, msg.seed);
        return;

      case 'reject':
        this.events.onReject?.(msg.reason);
        return;

      case 'snapshot':
        this.applySnapshot(msg);
        return;

      case 'hit':
        this.events.onHit?.(msg.targetId, msg.damage, msg.zone, msg.killed);
        return;

      case 'damaged':
        this.health = msg.health;
        this.events.onDamaged?.(msg.byId, msg.damage, msg.health);
        return;

      case 'left':
        this.remotes.delete(msg.id);
        this.names.delete(msg.id);
        this.events.onLeft?.(msg.id);
        return;

      case 'pong':
        // The timestamp is the client's own, sent out with the ping, so this is
        // a genuine round trip. Echoing it back would start a loop between the
        // two ping handlers that never settles and inflates the number forever.
        this.rtt = Math.max(0, Date.now() - msg.time);
        return;
    }
  }

  private applySnapshot(msg: Extract<ServerMessage, { t: 'snapshot' }>): void {
    this.snapshotsReceived++;
    // The server clock is taken from the newest snapshot rather than smoothed:
    // it is the only authoritative time there is, and drifting off it makes the
    // interpolation window slide until remotes stutter.
    this.serverTime = Math.max(this.serverTime, msg.time);
    this.lastSnapshotAt = msg.time;

    for (const state of msg.players) {
      this.names.set(state.id, state.name);
      if (state.id === this.id) {
        this.reconcile(state, msg.ack);
        continue;
      }
      let buffer = this.remotes.get(state.id);
      if (!buffer) {
        buffer = new RemoteInterpolator();
        this.remotes.set(state.id, buffer);
      }
      buffer.push(msg.time, state);
    }
  }

  /**
   * Rewinds to the server's version and replays what it had not yet seen.
   *
   * Without the replay the correction would undo every command still in flight,
   * dragging the player backwards by a full round trip on every snapshot. With
   * it, the client only ever moves when the server genuinely disagrees.
   */
  private reconcile(state: PlayerState, ack: number): void {
    while (this.unacknowledged.length && this.unacknowledged[0]!.seq <= ack) {
      this.unacknowledged.shift();
    }

    const error = positionError(this.body, state);
    if (error < IGNORE_ERROR_METRES) return;

    const replay = createBody(state.x, state.y, state.z);
    replay.yaw = this.body.yaw;
    replay.pitch = this.body.pitch;
    replay.crouched = state.crouched;
    // Vertical velocity is not in the snapshot; keeping the local one avoids a
    // jump being cancelled mid-air by a correction that only knew the position.
    replay.vy = this.body.vy;
    replay.grounded = Math.abs(state.y - this.ground(state.x, state.z)) < 0.05;

    for (const cmd of this.unacknowledged) stepMovement(replay, cmd, this.ground);

    const corrected = positionError(this.body, replay);
    if (corrected < IGNORE_ERROR_METRES) return;
    this.corrections++;

    if (corrected > SNAP_ERROR_METRES) {
      // Far enough that easing would look like sliding on ice.
      this.body.x = replay.x;
      this.body.y = replay.y;
      this.body.z = replay.z;
    } else {
      // Small disagreements are eased in, so the camera never jerks.
      const k = 0.25;
      this.body.x += (replay.x - this.body.x) * k;
      this.body.y += (replay.y - this.body.y) * k;
      this.body.z += (replay.z - this.body.z) * k;
    }
    this.body.vy = replay.vy;
    this.body.grounded = replay.grounded;
  }

  /** One line for the debug overlay. */
  get debugText(): string {
    return [
      `${this.connected ? 'conectado' : 'offline'} id ${this.id} · rtt ${this.rtt.toFixed(0)} ms`,
      `snapshots ${this.snapshotsReceived} · correções ${this.corrections} · pendentes ${this.unacknowledged.length}`,
      `remotos ${this.remotes.size} · atraso de render ${INTERPOLATION_DELAY_MS} ms`,
    ].join('\n');
  }

  get lastSnapshotTime(): number {
    return this.lastSnapshotAt;
  }
}
