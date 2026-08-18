import type { PlayerState } from './protocol';

interface Sample {
  time: number;
  state: PlayerState;
}

function shortestAngle(from: number, to: number): number {
  return ((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

/**
 * Buffer of snapshots for one remote player, played back on a delay.
 *
 * Remote players are drawn a fixed interval behind the newest snapshot. That
 * delay is what buys smooth motion: at twenty snapshots a second there is
 * 50 ms between updates, and rendering the newest one directly would show a
 * player teleporting twenty times a second. Holding one snapshot back means
 * there is almost always a pair to interpolate between, and a late packet has
 * time to arrive before it is needed.
 */
export class RemoteInterpolator {
  private readonly samples: Sample[] = [];
  /** Keeps a second of history; older samples can never be asked for. */
  private readonly historyMs = 1000;

  push(time: number, state: PlayerState): void {
    // Out-of-order packets are dropped rather than inserted: they are already
    // older than what has been drawn, so they can only rewind the picture.
    const newest = this.samples[this.samples.length - 1];
    if (newest && time <= newest.time) return;
    this.samples.push({ time, state });
    const cutoff = time - this.historyMs;
    while (this.samples.length > 2 && this.samples[0]!.time < cutoff) this.samples.shift();
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get newestTime(): number {
    return this.samples[this.samples.length - 1]?.time ?? 0;
  }

  /**
   * State at `renderTime`, interpolated.
   *
   * Past the end of the buffer it holds the last known state rather than
   * extrapolating: guessing forward makes a player who stopped keep walking and
   * then snap back, which reads far worse than a brief freeze.
   */
  sample(renderTime: number): PlayerState | null {
    if (!this.samples.length) return null;
    if (this.samples.length === 1) return this.samples[0]!.state;

    const first = this.samples[0]!;
    if (renderTime <= first.time) return first.state;
    const last = this.samples[this.samples.length - 1]!;
    if (renderTime >= last.time) return last.state;

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i]!;
      const a = this.samples[i - 1]!;
      if (renderTime >= a.time && renderTime <= b.time) {
        const span = b.time - a.time;
        const t = span > 0 ? (renderTime - a.time) / span : 0;
        return lerpState(a.state, b.state, t);
      }
    }
    return last.state;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export function lerpState(a: PlayerState, b: PlayerState, t: number): PlayerState {
  return {
    id: b.id,
    name: b.name,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    // Angles take the short way round, or a player crossing north spins.
    yaw: a.yaw + shortestAngle(a.yaw, b.yaw) * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    health: b.health,
    crouched: b.crouched,
    speed: a.speed + (b.speed - a.speed) * t,
  };
}
