import * as THREE from 'three';
import { assets } from '../core/assets';
import type { Biome } from './terrain';

export interface ScatterInstance {
  modelId: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

/** Which models each biome scatters, and how densely (instances per chunk). */
export const BIOME_SCATTER: Record<Biome, Array<{ model: string; weight: number }>> = {
  campo: [
    { model: 'nature-kit/grass', weight: 6 },
    { model: 'nature-kit/rock_smallA', weight: 3 },
    { model: 'nature-kit/tree_default', weight: 1 },
  ],
  floresta: [
    { model: 'nature-kit/tree_default', weight: 6 },
    { model: 'nature-kit/tree_pineDefaultA', weight: 5 },
    { model: 'nature-kit/tree_blocks', weight: 3 },
    { model: 'nature-kit/rock_smallA', weight: 2 },
  ],
  industrial: [
    { model: 'survival-kit/barrel', weight: 3 },
    { model: 'nature-kit/rock_smallA', weight: 2 },
    { model: 'nature-kit/grass', weight: 2 },
  ],
  militar: [
    { model: 'nature-kit/rock_smallA', weight: 3 },
    { model: 'nature-kit/grass', weight: 3 },
    { model: 'survival-kit/barrel', weight: 1 },
  ],
  costa: [
    { model: 'nature-kit/rock_smallA', weight: 4 },
    { model: 'nature-kit/grass', weight: 2 },
  ],
};

const DENSITY: Record<Biome, number> = {
  campo: 26,
  floresta: 64,
  industrial: 14,
  militar: 16,
  costa: 10,
};

export function scatterDensity(biome: Biome): number {
  return DENSITY[biome];
}

interface Field {
  mesh: THREE.InstancedMesh;
  count: number;
}

/**
 * All scattered props, as one InstancedMesh per model across the whole streamed
 * world — not per chunk.
 *
 * A forest chunk holds ~64 props; with 80 loaded chunks, per-chunk instancing
 * would cost hundreds of draw calls. Pooling by model keeps it at one draw per
 * distinct prop, and chunks just contribute and withdraw their instances.
 */
export class ScatterField {
  private readonly fields = new Map<string, Field>();
  private readonly chunkInstances = new Map<string, ScatterInstance[]>();
  private dirty = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scaleVec = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly capacityPerModel = 4096,
  ) {}

  /** Models must be preloaded before the first chunk contributes instances. */
  async prepare(): Promise<void> {
    const ids = new Set<string>();
    for (const list of Object.values(BIOME_SCATTER)) {
      for (const entry of list) ids.add(entry.model);
    }
    await assets.prepare(...ids);
    for (const id of ids) this.ensureField(id);
  }

  private ensureField(modelId: string): Field | null {
    const existing = this.fields.get(modelId);
    if (existing) return existing;

    const source = assets.instantiateSync(modelId);
    if (!source) return null;

    // Kenney props are one mesh under a group; take the first mesh found and
    // bake the group's transform into the instance geometry.
    let mesh: THREE.Mesh | null = null;
    source.updateWorldMatrix(true, true);
    source.traverse((obj) => {
      if (!mesh && (obj as THREE.Mesh).isMesh) mesh = obj as THREE.Mesh;
    });
    if (!mesh) return null;
    const found = mesh as THREE.Mesh;

    const geometry = found.geometry.clone();
    geometry.applyMatrix4(found.matrixWorld);
    const material = found.material as THREE.Material;

    const instanced = new THREE.InstancedMesh(geometry, material, this.capacityPerModel);
    instanced.count = 0;
    instanced.castShadow = true;
    instanced.receiveShadow = true;
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    instanced.frustumCulled = false;
    this.scene.add(instanced);

    const field: Field = { mesh: instanced, count: 0 };
    this.fields.set(modelId, field);
    return field;
  }

  setChunk(key: string, instances: ScatterInstance[]): void {
    this.chunkInstances.set(key, instances);
    this.dirty = true;
  }

  clearChunk(key: string): void {
    if (this.chunkInstances.delete(key)) this.dirty = true;
  }

  /** Rebuilds the instance buffers; only runs on the frames chunks changed. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;

    for (const field of this.fields.values()) field.count = 0;

    for (const instances of this.chunkInstances.values()) {
      for (const instance of instances) {
        const field = this.fields.get(instance.modelId);
        if (!field || field.count >= this.capacityPerModel) continue;
        this.position.set(instance.x, instance.y, instance.z);
        this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), instance.yaw);
        this.scaleVec.setScalar(instance.scale);
        this.matrix.compose(this.position, this.quaternion, this.scaleVec);
        field.mesh.setMatrixAt(field.count++, this.matrix);
      }
    }

    for (const field of this.fields.values()) {
      field.mesh.count = field.count;
      field.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get stats(): { models: number; instances: number } {
    let instances = 0;
    for (const field of this.fields.values()) instances += field.count;
    return { models: this.fields.size, instances };
  }

  dispose(): void {
    for (const field of this.fields.values()) {
      this.scene.remove(field.mesh);
      field.mesh.geometry.dispose();
      field.mesh.dispose();
    }
    this.fields.clear();
    this.chunkInstances.clear();
  }
}
