import { eyeHeightOf, type NetPlayerBody } from './movement.ts';

export interface HistorySample {
  time: number;
  x: number;
  y: number;
  z: number;
  crouched: boolean;
}

/** Hitbox around a standing player, in metres. */
export const HITBOX = {
  radius: 0.42,
  standHeight: 1.8,
  crouchHeight: 1.2,
  headFraction: 0.86,
};

/**
 * Where every player was, recently.
 *
 * Lag compensation is the difference between a game that feels fair and one
 * where you have to lead every shot: the shooter aimed at what their screen
 * showed, which is already old by their latency plus the interpolation delay.
 * The server rewinds the target to that instant before testing the shot, so
 * hitting what you saw counts.
 */
export class PositionHistory {
  private readonly samples: HistorySample[] = [];

  private readonly windowMs: number;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  record(time: number, body: NetPlayerBody): void {
    this.samples.push({ time, x: body.x, y: body.y, z: body.z, crouched: body.crouched });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 1 && this.samples[0]!.time < cutoff) this.samples.shift();
  }

  get length(): number {
    return this.samples.length;
  }

  /**
   * Position at a past instant.
   *
   * Anything older than the window is clamped to the oldest sample rather than
   * refused: a client on a terrible connection should shoot slightly stale
   * targets, not miss everything.
   */
  at(time: number): HistorySample | null {
    if (!this.samples.length) return null;
    const first = this.samples[0]!;
    if (time <= first.time) return first;
    const last = this.samples[this.samples.length - 1]!;
    if (time >= last.time) return last;

    for (let i = this.samples.length - 1; i > 0; i--) {
      const b = this.samples[i]!;
      const a = this.samples[i - 1]!;
      if (time >= a.time && time <= b.time) {
        const span = b.time - a.time;
        const t = span > 0 ? (time - a.time) / span : 0;
        return {
          time,
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
          crouched: t < 0.5 ? a.crouched : b.crouched,
        };
      }
    }
    return last;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

export interface RayHit {
  distance: number;
  zone: 'head' | 'torso';
}

/**
 * Ray against an upright capsule, approximated as a vertical cylinder.
 *
 * A cylinder is close enough for a human silhouette at these ranges, and it
 * costs a quadratic instead of the capsule's cap tests — worth it when the
 * server runs this against every player on every shot.
 */
export function rayHitsPlayer(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  target: HistorySample,
): RayHit | null {
  const height = target.crouched ? HITBOX.crouchHeight : HITBOX.standHeight;

  // Horizontal quadratic: where the ray enters the cylinder's circle.
  const mx = ox - target.x;
  const mz = oz - target.z;
  const a = dx * dx + dz * dz;
  const b = 2 * (mx * dx + mz * dz);
  const c = mx * mx + mz * mz - HITBOX.radius * HITBOX.radius;

  let t = -1;
  if (a < 1e-8) {
    // Straight up or down: inside the circle or nothing.
    if (c > 0) return null;
    t = 0;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const t0 = (-b - root) / (2 * a);
    const t1 = (-b + root) / (2 * a);
    t = t0 >= 0 ? t0 : t1;
    if (t < 0) return null;
  }
  if (t > maxDistance) return null;

  const hitY = oy + dy * t;
  const footY = target.y;
  if (hitY < footY || hitY > footY + height) return null;

  const fraction = (hitY - footY) / height;
  return { distance: t, zone: fraction >= HITBOX.headFraction ? 'head' : 'torso' };
}

/** Eye position of a body, where its shots come from. */
export function eyeOf(body: NetPlayerBody): { x: number; y: number; z: number } {
  return { x: body.x, y: body.y + eyeHeightOf(body), z: body.z };
}
