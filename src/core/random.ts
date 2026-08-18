/**
 * Deterministic random source.
 *
 * Loot and missions have to be reproducible from a seed: a save that reloads
 * into a different set of missions, or a container that re-rolls its contents
 * every time it is opened, is a bug the player can see. `Math.random` cannot
 * give that, so everything that rolls goes through one of these.
 */
export class Random {
  private state: number;

  constructor(seed: number) {
    // Zero is a fixed point of the generator, so it is never a valid state.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Next value in [0, 1). */
  next(): number {
    // mulberry32: small, fast, and good enough for content generation.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive at both ends. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T | null {
    if (!items.length) return null;
    return items[Math.floor(this.next() * items.length)] ?? null;
  }

  /**
   * Picks one entry with probability proportional to its weight.
   *
   * Entries with a non-positive weight are unreachable rather than rare, which
   * is what lets a loot table disable a line by setting its weight to zero.
   */
  weighted<T extends { weight: number }>(entries: readonly T[]): T | null {
    let total = 0;
    for (const entry of entries) if (entry.weight > 0) total += entry.weight;
    if (total <= 0) return null;
    let roll = this.next() * total;
    for (const entry of entries) {
      if (entry.weight <= 0) continue;
      roll -= entry.weight;
      if (roll < 0) return entry;
    }
    // Only reachable through floating-point drift on the last entry.
    return entries[entries.length - 1] ?? null;
  }

  /** A fresh generator whose seed is derived from this one. */
  fork(salt: number): Random {
    return new Random((this.state ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0);
  }
}

/** Turns a string into a seed, so named places roll the same contents. */
export function hashSeed(text: string, base = 0): number {
  let h = 0x811c9dc5 ^ base;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
