/**
 * Terrain definition: a pure function of (seed, x, z).
 *
 * Nothing here may touch three, Rapier or the DOM — this module is imported by
 * the generation Web Worker as well as the main thread, and both must produce
 * bit-identical heights or the collider and the mesh will disagree.
 */

export interface TerrainParams {
  seed: number;
  sizeMeters: number;
  heightScale: number;
  waterLevel: number;
}

export const BIOMES = ['campo', 'floresta', 'industrial', 'militar', 'costa'] as const;
export type Biome = (typeof BIOMES)[number];

/** Integer hash — cheap, stable across engines, and good enough for value noise. */
function hash2(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);

  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);

  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

function fbm(x: number, y: number, seed: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * frequency, y * frequency, seed + i * 8191) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return sum / norm;
}

/** Ridged noise makes mountain spines instead of rolling blobs. */
function ridged(x: number, y: number, seed: number, octaves: number): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * frequency, y * frequency, seed + i * 7919));
    sum += n * n * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return sum / norm;
}

/**
 * Flat spots the world needs: POIs and roads must not sit on a slope. Each is a
 * disc that pulls the height towards its own level, with a soft edge.
 */
export interface FlattenDisc {
  x: number;
  z: number;
  radius: number;
  falloff: number;
  height: number;
}

export class Terrain {
  private readonly discs: FlattenDisc[] = [];

  constructor(readonly params: TerrainParams) {}

  /** Registered before any chunk is built; the worker gets a copy of these. */
  addFlatten(disc: FlattenDisc): void {
    this.discs.push(disc);
  }

  get flattenDiscs(): readonly FlattenDisc[] {
    return this.discs;
  }

  setFlattenDiscs(discs: FlattenDisc[]): void {
    this.discs.length = 0;
    this.discs.push(...discs);
  }

  /** Raw height in metres before flattening. */
  private baseHeight(x: number, z: number): number {
    const { seed, heightScale } = this.params;
    // Continent shape: very low frequency, decides land vs. lowland.
    const continent = fbm(x / 1400, z / 1400, seed, 3);
    // Hills at a human scale.
    const hills = fbm(x / 320, z / 320, seed + 101, 4);
    // Mountain ridges, masked to the high side of the continent.
    const mountainMask = Math.max(0, continent * 1.4);
    const mountains = ridged(x / 620, z / 620, seed + 202, 4) * mountainMask;
    // Fine detail, kept small so slopes stay walkable.
    const detail = fbm(x / 48, z / 48, seed + 303, 3) * 0.06;

    const raw = continent * 0.45 + hills * 0.3 + mountains * 0.55 + detail;
    // Bias upward: the raw field is centred on zero, which would put half the
    // map under the water line and leave an ocean with islands. Compressing and
    // lifting it gives roughly 10% water — coast and lakes, not a sea.
    const shaped = raw * 0.95 + 0.42;
    return shaped * heightScale;
  }

  heightAt(x: number, z: number): number {
    let h = this.baseHeight(x, z);
    for (const disc of this.discs) {
      const dx = x - disc.x;
      const dz = z - disc.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > disc.radius + disc.falloff) continue;
      // 1 inside the disc, easing to 0 across the falloff band.
      const t =
        distance <= disc.radius
          ? 1
          : 1 - smooth((distance - disc.radius) / Math.max(disc.falloff, 1e-3));
      h += (disc.height - h) * t;
    }
    return h;
  }

  /** Central-difference normal; used for slope-dependent scatter and shading. */
  slopeAt(x: number, z: number, step = 2): number {
    const hx = this.heightAt(x + step, z) - this.heightAt(x - step, z);
    const hz = this.heightAt(x, z + step) - this.heightAt(x, z - step);
    const gradient = Math.sqrt(hx * hx + hz * hz) / (2 * step);
    return Math.atan(gradient);
  }

  /**
   * Biome from height, slope and a moisture field. Coast is decided by height
   * relative to the water line so the shore always reads as shore.
   */
  biomeAt(x: number, z: number): Biome {
    const h = this.heightAt(x, z);
    const { waterLevel, seed } = this.params;
    if (h < waterLevel + 2.5) return 'costa';

    const moisture = fbm(x / 900, z / 900, seed + 404, 3);
    const industry = fbm(x / 1100, z / 1100, seed + 505, 2);

    if (industry > 0.42) return 'industrial';
    if (industry < -0.52) return 'militar';
    if (moisture > 0.12) return 'floresta';
    return 'campo';
  }

  /** Height sampled on the chunk grid, row-major, (res+1)^2 values. */
  sampleChunk(chunkX: number, chunkZ: number, chunkMeters: number, res: number): Float32Array {
    const out = new Float32Array((res + 1) * (res + 1));
    const step = chunkMeters / res;
    const originX = chunkX * chunkMeters;
    const originZ = chunkZ * chunkMeters;
    for (let j = 0; j <= res; j++) {
      for (let i = 0; i <= res; i++) {
        out[j * (res + 1) + i] = this.heightAt(originX + i * step, originZ + j * step);
      }
    }
    return out;
  }
}
