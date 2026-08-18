import * as THREE from 'three';
import { World as WorldCfg } from '../core/config';
import { groups, Layer } from '../physics/layers';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import { Terrain } from './terrain';
import type { WorldLayout } from './layout';
import { BIOME_SCATTER, ScatterField, scatterDensity, type ScatterInstance } from './scatter';
import type { BuiltChunk, WorkerRequest } from './terrainWorker';

/** Visual resolution per LOD level: quads per 128 m chunk side. */
const LOD_RES = [32, 16, 8];
/** Collider resolution is fixed so physics never changes under the player. */
const COLLIDER_RES = 16;

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  lod: number;
  mesh: THREE.Mesh | null;
  collider: RAPIER.Collider | null;
  body: RAPIER.RigidBody | null;
  pending: boolean;
}

function keyOf(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

/** Deterministic per-position hash, so scatter is identical every load. */
function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Loads and unloads terrain around the viewer.
 *
 * Generation runs in a Web Worker and results are applied at most
 * `maxChunkBuildsPerFrame` per frame — building a chunk's geometry and its
 * Rapier heightfield in one go is several milliseconds, and doing a whole ring
 * at once is exactly the stutter the frame budget forbids.
 */
export class TerrainStreamer {
  private readonly chunks = new Map<string, Chunk>();
  private readonly worker: Worker;
  private readonly ready: Array<BuiltChunk> = [];
  private readonly material: THREE.MeshLambertMaterial;
  private nextRequestId = 1;
  private readonly pendingLod = new Map<number, { key: string; lod: number }>();

  readonly scatter: ScatterField;
  /** Counters for the debug overlay. */
  stats = { loaded: 0, pending: 0, builtTotal: 0, instances: 0 };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly terrain: Terrain,
    private readonly layout: WorldLayout,
  ) {
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.scatter = new ScatterField(scene);

    this.worker = new Worker(new URL('./terrainWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<BuiltChunk>) => {
      this.ready.push(event.data);
    };
    this.post({
      type: 'init',
      params: terrain.params,
      discs: [...terrain.flattenDiscs],
    });
  }

  private post(message: WorkerRequest): void {
    this.worker.postMessage(message);
  }

  async prepare(): Promise<void> {
    await this.scatter.prepare();
  }

  /**
   * Loads the chunks around a point and waits for them.
   *
   * Generation is asynchronous, so spawning the player and letting the loop
   * start would drop them through a world that does not exist yet. This blocks
   * until there is ground underfoot.
   */
  async warmup(centre: THREE.Vector3, rings = 2): Promise<void> {
    const size = WorldCfg.chunkMeters;
    const cx = Math.floor(centre.x / size);
    const cz = Math.floor(centre.z / size);
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        this.request(cx + dx, cz + dz, 0);
      }
    }
    const deadline = performance.now() + 8000;
    while (this.pendingLod.size > 0 && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      // Apply everything that arrived; the per-frame budget does not apply to
      // the warmup, which happens before the first frame is ever drawn.
      while (this.ready.length) {
        const built = this.ready.shift()!;
        const request = this.pendingLod.get(built.id);
        this.pendingLod.delete(built.id);
        const chunk = request ? this.chunks.get(request.key) : undefined;
        if (chunk && request) this.applyChunk(chunk, built, request.lod);
      }
    }
    this.scatter.flush();
  }

  /** Ground height from the collider, or null when the chunk is not loaded. */
  groundAt(x: number, z: number): number | null {
    const hit = this.physics.raycast(
      { x, y: 400, z },
      { x: 0, y: -1, z: 0 },
      800,
      Layer.TERRAIN,
    );
    return hit ? hit.point.y : null;
  }

  private lodFor(distance: number): number {
    const d = WorldCfg.streaming.lodDistances;
    for (let i = 0; i < d.length; i++) {
      if (distance <= d[i]!) return i;
    }
    return LOD_RES.length - 1;
  }

  update(viewer: THREE.Vector3): void {
    const size = WorldCfg.chunkMeters;
    const cx = Math.floor(viewer.x / size);
    const cz = Math.floor(viewer.z / size);
    const loadRadius = WorldCfg.streaming.loadRadiusChunks;
    const unloadRadius = WorldCfg.streaming.unloadRadiusChunks;

    // Request the ring nearest first, so the ground under the player exists
    // before the horizon does.
    const wanted: Array<{ cx: number; cz: number; distance: number }> = [];
    for (let dz = -loadRadius; dz <= loadRadius; dz++) {
      for (let dx = -loadRadius; dx <= loadRadius; dx++) {
        const chunkX = cx + dx;
        const chunkZ = cz + dz;
        const centreX = (chunkX + 0.5) * size;
        const centreZ = (chunkZ + 0.5) * size;
        const distance = Math.hypot(centreX - viewer.x, centreZ - viewer.z);
        if (distance > loadRadius * size) continue;
        wanted.push({ cx: chunkX, cz: chunkZ, distance });
      }
    }
    wanted.sort((a, b) => a.distance - b.distance);

    for (const entry of wanted) {
      const key = keyOf(entry.cx, entry.cz);
      const lod = this.lodFor(entry.distance);
      const chunk = this.chunks.get(key);
      if (!chunk) {
        this.request(entry.cx, entry.cz, lod);
      } else if (!chunk.pending && chunk.lod !== lod) {
        // Re-detail in place; the collider is untouched because it never changes.
        this.request(entry.cx, entry.cz, lod);
      }
    }

    for (const [key, chunk] of this.chunks) {
      const centreX = (chunk.cx + 0.5) * size;
      const centreZ = (chunk.cz + 0.5) * size;
      const distance = Math.hypot(centreX - viewer.x, centreZ - viewer.z);
      if (distance > unloadRadius * size) {
        this.unload(key, chunk);
      }
    }

    this.applyReady();
    this.scatter.flush();

    this.stats.loaded = this.chunks.size;
    this.stats.pending = this.pendingLod.size;
    this.stats.instances = this.scatter.stats.instances;
  }

  private request(cx: number, cz: number, lod: number): void {
    const key = keyOf(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = { key, cx, cz, lod, mesh: null, collider: null, body: null, pending: true };
      this.chunks.set(key, chunk);
    }
    chunk.pending = true;
    const id = this.nextRequestId++;
    this.pendingLod.set(id, { key, lod });
    this.post({
      type: 'build',
      id,
      chunkX: cx,
      chunkZ: cz,
      chunkMeters: WorldCfg.chunkMeters,
      res: LOD_RES[lod] ?? LOD_RES[LOD_RES.length - 1]!,
      colliderRes: COLLIDER_RES,
    });
  }

  private applyReady(): void {
    let budget = WorldCfg.streaming.maxChunkBuildsPerFrame;
    while (budget-- > 0) {
      const built = this.ready.shift();
      if (!built) return;
      const request = this.pendingLod.get(built.id);
      this.pendingLod.delete(built.id);
      if (!request) continue;
      const chunk = this.chunks.get(request.key);
      // The chunk may have been unloaded while the worker was busy.
      if (!chunk) continue;
      this.applyChunk(chunk, built, request.lod);
    }
  }

  private applyChunk(chunk: Chunk, built: BuiltChunk, lod: number): void {
    const size = WorldCfg.chunkMeters;

    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(built.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(built.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(built.indices, 1));
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, built.minY, 0),
      new THREE.Vector3(size, built.maxY, size),
    );
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(size / 2, (built.minY + built.maxY) / 2, size / 2),
      Math.hypot(size, built.maxY - built.minY),
    );

    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.position.set(chunk.cx * size, 0, chunk.cz * size);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    this.scene.add(mesh);
    chunk.mesh = mesh;
    chunk.lod = lod;
    chunk.pending = false;
    this.stats.builtTotal++;

    if (!chunk.collider) {
      this.createCollider(chunk, built);
      this.buildScatter(chunk);
    }
  }

  /**
   * Rapier heightfields are centred on the collider and indexed column-major,
   * while the worker produces row-major samples from the chunk's corner. Both
   * conversions happen here, once.
   */
  private createCollider(chunk: Chunk, built: BuiltChunk): void {
    const size = WorldCfg.chunkMeters;
    const res = built.colliderRes;
    const side = res + 1;
    const source = built.colliderHeights;
    const transposed = new Float32Array(side * side);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        transposed[i * side + j] = source[j * side + i]!;
      }
    }

    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        (chunk.cx + 0.5) * size,
        0,
        (chunk.cz + 0.5) * size,
      ),
    );
    const desc = RAPIER.ColliderDesc.heightfield(res, res, transposed, {
      x: size,
      y: 1,
      z: size,
    }).setCollisionGroups(groups(Layer.TERRAIN, 0xffff));
    const collider = this.physics.world.createCollider(desc, body);
    this.physics.own(collider, { kind: 'surface', material: 'dirt' });
    chunk.collider = collider;
    chunk.body = body;
  }

  /** Deterministic props for one chunk, suppressed on roads and steep ground. */
  private buildScatter(chunk: Chunk): void {
    const size = WorldCfg.chunkMeters;
    const seed = this.terrain.params.seed;
    const originX = chunk.cx * size;
    const originZ = chunk.cz * size;
    const instances: ScatterInstance[] = [];

    const centreBiome = this.terrain.biomeAt(originX + size / 2, originZ + size / 2);
    const count = scatterDensity(centreBiome);
    const table = BIOME_SCATTER[centreBiome];
    const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);

    for (let n = 0; n < count; n++) {
      const rx = hash(chunk.cx * 1013 + n, chunk.cz * 1409, seed);
      const rz = hash(chunk.cx * 2027 + n, chunk.cz * 3079, seed + 17);
      const x = originX + rx * size;
      const z = originZ + rz * size;

      const y = this.terrain.heightAt(x, z);
      if (y < this.terrain.params.waterLevel + 0.6) continue;
      // Nothing grows on cliffs, on the road, or inside a POI's footprint.
      if (this.terrain.slopeAt(x, z) > 0.6) continue;
      if (this.layout.distanceToRoad(x, z) < 7) continue;
      if (this.layout.poiAt(x, z)) continue;

      const pick = hash(chunk.cx * 4093 + n, chunk.cz * 5087, seed + 31) * totalWeight;
      let acc = 0;
      let modelId = table[0]!.model;
      for (const entry of table) {
        acc += entry.weight;
        if (pick <= acc) {
          modelId = entry.model;
          break;
        }
      }

      instances.push({
        modelId,
        x,
        y,
        z,
        yaw: hash(chunk.cx * 6091 + n, chunk.cz * 7013, seed + 47) * Math.PI * 2,
        scale: 0.8 + hash(chunk.cx * 8093 + n, chunk.cz * 9091, seed + 53) * 0.5,
      });
    }

    this.scatter.setChunk(chunk.key, instances);
  }

  private unload(key: string, chunk: Chunk): void {
    if (chunk.mesh) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    if (chunk.collider) {
      this.physics.forget(chunk.collider);
      this.physics.world.removeCollider(chunk.collider, false);
    }
    if (chunk.body) this.physics.world.removeRigidBody(chunk.body);
    this.scatter.clearChunk(key);
    this.chunks.delete(key);
  }

  get debugText(): string {
    return [
      `chunks ${this.stats.loaded}  fila ${this.stats.pending}  construídos ${this.stats.builtTotal}`,
      `props instanciados ${this.stats.instances} em ${this.scatter.stats.models} modelos`,
    ].join('\n');
  }

  dispose(): void {
    for (const [key, chunk] of this.chunks) this.unload(key, chunk);
    this.chunks.clear();
    this.scatter.dispose();
    this.material.dispose();
    this.worker.terminate();
  }
}
