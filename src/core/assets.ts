import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import scaleConfig from '../../config/asset-scales.json';

export interface ModelBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ModelEntry {
  category: string;
  node: string;
  pack: string;
  bounds: ModelBounds;
  triangles: number;
  animations?: string[];
}

export interface CategoryInfo {
  file: string;
  bytes: number;
  models: number;
  materials: number;
  textures: number;
  preload: boolean;
}

export interface Manifest {
  generatedAt: string;
  license: string;
  categories: Record<string, CategoryInfo>;
  models: Record<string, ModelEntry>;
  animations: Record<string, string[]>;
  audio: Record<string, string>;
}

interface LoadedCategory {
  gltf: GLTF;
  /** Node name -> the merged group for that model. */
  nodes: Map<string, THREE.Object3D>;
  clips: Map<string, THREE.AnimationClip[]>;
}

const PACK_SCALES = scaleConfig.packs as Record<string, number>;

/**
 * Loads the merged category GLBs produced by tools/build-assets.mjs.
 *
 * Only categories flagged `preload` are fetched at boot; the rest arrive the
 * first time something asks for a model in them, so the initial download stays
 * around 2 MB even though the catalogue holds 2107 models.
 */
class AssetManager {
  private manifest: Manifest | null = null;
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly loaded = new Map<string, LoadedCategory>();
  private readonly pending = new Map<string, Promise<LoadedCategory>>();
  private readonly audioBuffers = new Map<string, AudioBuffer>();

  async init(): Promise<void> {
    if (this.manifest) return;
    const res = await fetch('assets/manifest.json');
    if (!res.ok) {
      throw new Error(
        'assets/manifest.json não encontrado. Rode `npm run assets:build` antes de `npm run dev`.',
      );
    }
    this.manifest = (await res.json()) as Manifest;

    await Promise.all(
      Object.entries(this.manifest.categories)
        .filter(([, info]) => info.preload)
        .map(([name]) => this.loadCategory(name)),
    );
  }

  get data(): Manifest {
    if (!this.manifest) throw new Error('AssetManager.init() não foi aguardado');
    return this.manifest;
  }

  /** Scale that converts this kit's native units to metres. */
  scaleFor(id: string): number {
    const pack = id.split('/')[0] ?? '';
    return PACK_SCALES[pack] ?? scaleConfig.default;
  }

  entry(id: string): ModelEntry | undefined {
    return this.manifest?.models[id];
  }

  ids(filter?: (entry: ModelEntry, id: string) => boolean): string[] {
    const models = this.data.models;
    const all = Object.keys(models);
    if (!filter) return all;
    return all.filter((id) => filter(models[id]!, id));
  }

  async loadCategory(name: string): Promise<LoadedCategory> {
    const existing = this.loaded.get(name);
    if (existing) return existing;
    const inFlight = this.pending.get(name);
    if (inFlight) return inFlight;

    const info = this.data.categories[name];
    if (!info) throw new Error(`categoria desconhecida no manifest: ${name}`);

    const promise = this.loader.loadAsync(info.file).then((gltf) => {
      const nodes = new Map<string, THREE.Object3D>();
      for (const child of gltf.scene.children) nodes.set(child.name, child);

      // Clips are namespaced `<node name>|<clip>` by the build so that two kits
      // can both ship an "idle" without colliding.
      const clips = new Map<string, THREE.AnimationClip[]>();
      for (const clip of gltf.animations) {
        const sep = clip.name.indexOf('|');
        if (sep < 0) continue;
        const node = clip.name.slice(0, sep);
        const bare = clip.name.slice(sep + 1);
        const list = clips.get(node) ?? [];
        const renamed = clip.clone();
        renamed.name = bare;
        list.push(renamed);
        clips.set(node, list);
      }

      const record: LoadedCategory = { gltf, nodes, clips };
      this.loaded.set(name, record);
      this.pending.delete(name);
      return record;
    });

    this.pending.set(name, promise);
    return promise;
  }

  /** True when the model can be instantiated without a network round trip. */
  isReady(id: string): boolean {
    const entry = this.entry(id);
    return !!entry && this.loaded.has(entry.category);
  }

  async prepare(...ids: string[]): Promise<void> {
    const categories = new Set<string>();
    for (const id of ids) {
      const entry = this.entry(id);
      if (entry) categories.add(entry.category);
    }
    await Promise.all([...categories].map((c) => this.loadCategory(c)));
  }

  /**
   * Returns a fresh instance, scaled to metres. Materials stay shared with the
   * source so instances of the same kit keep batching together.
   */
  async instantiate(id: string, options: { scale?: number } = {}): Promise<THREE.Object3D> {
    const entry = this.entry(id);
    if (!entry) throw new Error(`modelo desconhecido: ${id}`);
    await this.loadCategory(entry.category);
    const instance = this.instantiateSync(id, options);
    if (!instance) throw new Error(`nó ausente no GLB da categoria ${entry.category}: ${id}`);
    return instance;
  }

  instantiateSync(id: string, options: { scale?: number } = {}): THREE.Object3D | null {
    const entry = this.entry(id);
    if (!entry) return null;
    const category = this.loaded.get(entry.category);
    const source = category?.nodes.get(entry.node);
    if (!source) return null;

    const isSkinned = category!.clips.has(entry.node);
    const instance = isSkinned ? cloneSkinned(source) : source.clone(true);
    instance.name = id;
    const scale = options.scale ?? this.scaleFor(id);
    if (scale !== 1) instance.scale.multiplyScalar(scale);
    instance.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return instance;
  }

  /** Animation clips for a model, already stripped of the id namespace. */
  clips(id: string): THREE.AnimationClip[] {
    const entry = this.entry(id);
    if (!entry) return [];
    return this.loaded.get(entry.category)?.clips.get(entry.node) ?? [];
  }

  /** Size in metres after the kit scale is applied. */
  sizeOf(id: string): THREE.Vector3 {
    const entry = this.entry(id);
    if (!entry) return new THREE.Vector3();
    const s = this.scaleFor(id);
    return new THREE.Vector3(
      (entry.bounds.max[0] - entry.bounds.min[0]) * s,
      (entry.bounds.max[1] - entry.bounds.min[1]) * s,
      (entry.bounds.max[2] - entry.bounds.min[2]) * s,
    );
  }

  audioUrl(id: string): string | undefined {
    return this.manifest?.audio[id];
  }

  async loadAudio(ctx: AudioContext, id: string): Promise<AudioBuffer | null> {
    const cached = this.audioBuffers.get(id);
    if (cached) return cached;
    const url = this.audioUrl(id);
    if (!url) return null;
    const res = await fetch(url);
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
    this.audioBuffers.set(id, buffer);
    return buffer;
  }

  get stats(): string {
    const loadedNames = [...this.loaded.keys()];
    const bytes = loadedNames.reduce(
      (sum, name) => sum + (this.data.categories[name]?.bytes ?? 0),
      0,
    );
    return `categorias ${loadedNames.length}/${Object.keys(this.data.categories).length} (${(bytes / 1048576).toFixed(1)} MB)\n${loadedNames.join(', ')}`;
  }
}

export const assets = new AssetManager();
