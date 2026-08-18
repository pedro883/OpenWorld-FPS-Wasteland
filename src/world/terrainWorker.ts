/// <reference lib="webworker" />
import { Terrain, type FlattenDisc, type TerrainParams } from './terrain';

export interface InitMessage {
  type: 'init';
  params: TerrainParams;
  discs: FlattenDisc[];
}

export interface BuildMessage {
  type: 'build';
  id: number;
  chunkX: number;
  chunkZ: number;
  chunkMeters: number;
  /** Quads per side for the visual mesh. */
  res: number;
  /** Quads per side for the collider, kept constant across LODs. */
  colliderRes: number;
}

export type WorkerRequest = InitMessage | BuildMessage;

export interface BuiltChunk {
  type: 'built';
  id: number;
  chunkX: number;
  chunkZ: number;
  res: number;
  colliderRes: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Row-major heights for the Rapier heightfield. */
  colliderHeights: Float32Array;
  minY: number;
  maxY: number;
}

let terrain: Terrain | null = null;

/** Flat palette keyed to height, slope and water line — no terrain textures. */
const PALETTE = {
  sand: [0.76, 0.71, 0.5],
  grass: [0.35, 0.45, 0.24],
  grassDry: [0.48, 0.5, 0.28],
  rock: [0.42, 0.4, 0.38],
  snow: [0.86, 0.88, 0.9],
} as const;

function mix(a: readonly number[], b: readonly number[], t: number, out: number[]): void {
  out[0] = a[0]! + (b[0]! - a[0]!) * t;
  out[1] = a[1]! + (b[1]! - a[1]!) * t;
  out[2] = a[2]! + (b[2]! - a[2]!) * t;
}

function buildChunk(msg: BuildMessage): BuiltChunk {
  if (!terrain) throw new Error('worker de terreno usado antes do init');
  const { chunkX, chunkZ, chunkMeters, res, colliderRes } = msg;
  const side = res + 1;
  const step = chunkMeters / res;
  const originX = chunkX * chunkMeters;
  const originZ = chunkZ * chunkMeters;
  const waterLevel = terrain.params.waterLevel;
  const heightScale = terrain.params.heightScale;

  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const colors = new Float32Array(side * side * 3);
  const heights = new Float32Array(side * side);

  let minY = Infinity;
  let maxY = -Infinity;

  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const wx = originX + i * step;
      const wz = originZ + j * step;
      const h = terrain.heightAt(wx, wz);
      const index = j * side + i;
      heights[index] = h;
      positions[index * 3] = i * step;
      positions[index * 3 + 1] = h;
      positions[index * 3 + 2] = j * step;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }
  }

  // Normals from the height field itself, which is exact and cheaper than
  // accumulating face normals over the triangle list.
  const rgb: number[] = [0, 0, 0];
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const index = j * side + i;
      const hl = heights[j * side + Math.max(0, i - 1)]!;
      const hr = heights[j * side + Math.min(side - 1, i + 1)]!;
      const hd = heights[Math.max(0, j - 1) * side + i]!;
      const hu = heights[Math.min(side - 1, j + 1) * side + i]!;
      const nx = hl - hr;
      const nz = hd - hu;
      const ny = 2 * step;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[index * 3] = nx / length;
      normals[index * 3 + 1] = ny / length;
      normals[index * 3 + 2] = nz / length;

      const h = heights[index]!;
      const slope = 1 - ny / length;
      const altitude = (h - waterLevel) / Math.max(heightScale * 0.55, 1);

      if (h < waterLevel + 1.6) {
        rgb[0] = PALETTE.sand[0];
        rgb[1] = PALETTE.sand[1];
        rgb[2] = PALETTE.sand[2];
      } else {
        mix(PALETTE.grass, PALETTE.grassDry, Math.min(1, Math.max(0, altitude * 1.4)), rgb);
        // Steep faces show rock no matter the altitude.
        mix(rgb, PALETTE.rock, Math.min(1, Math.max(0, (slope - 0.25) * 2.6)), rgb);
        if (altitude > 0.78) {
          mix(rgb, PALETTE.snow, Math.min(1, (altitude - 0.78) * 3), rgb);
        }
      }
      colors[index * 3] = rgb[0]!;
      colors[index * 3 + 1] = rgb[1]!;
      colors[index * 3 + 2] = rgb[2]!;
    }
  }

  const indices = new Uint32Array(res * res * 6);
  let cursor = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const a = j * side + i;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  // The collider samples at its own fixed resolution so physics does not change
  // under the player when the visual LOD swaps.
  const colliderHeights =
    colliderRes === res
      ? heights
      : terrain.sampleChunk(chunkX, chunkZ, chunkMeters, colliderRes);

  return {
    type: 'built',
    id: msg.id,
    chunkX,
    chunkZ,
    res,
    colliderRes,
    positions,
    normals,
    colors,
    indices,
    colliderHeights,
    minY,
    maxY,
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>): void => {
  const msg = event.data;
  if (msg.type === 'init') {
    terrain = new Terrain(msg.params);
    terrain.setFlattenDiscs(msg.discs);
    return;
  }
  const built = buildChunk(msg);
  (self as unknown as Worker).postMessage(built, [
    built.positions.buffer,
    built.normals.buffer,
    built.colors.buffer,
    built.indices.buffer,
    built.colliderHeights.buffer,
  ]);
};
