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
  /** Model whose clips drive this one, for bodies sharing a skeleton. */
  rig?: string;
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
  icons: Record<string, string>;
}

/** Character skin textures, written next to the GLBs by build-characters.mjs. */
type SkinIndex = Record<string, string>;

interface LoadedCategory {
  gltf: GLTF;
  /** Node name -> the merged group for that model. */
  nodes: Map<string, THREE.Object3D>;
  clips: Map<string, THREE.AnimationClip[]>;
}

const PACK_SCALES = scaleConfig.packs as Record<string, number>;

function hasSkinnedMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

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
  private readonly skinTextures = new Map<string, THREE.Texture>();
  private skins: SkinIndex | null = null;
  private skinsPending: Promise<SkinIndex> | null = null;
  private readonly textureLoader = new THREE.TextureLoader();

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

    // Detected from the mesh rather than from "does it own clips": bodies that
    // borrow another body's rig own none, and a plain clone would leave their
    // skinning unbound.
    const instance = hasSkinnedMesh(source) ? cloneSkinned(source) : source.clone(true);
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
    const own = this.loaded.get(entry.category)?.clips.get(entry.node);
    if (own?.length) return own;
    // Bodies sharing a skeleton borrow the rig owner's clips; they bind by bone
    // name, so the same tracks drive any body in the pack.
    return entry.rig ? this.clips(entry.rig) : [];
  }

  /**
   * Scale that makes a model a given height in metres.
   *
   * The four Kenney bodies are not authored at one height, so a single per-pack
   * factor would leave them a head apart from each other.
   */
  scaleToHeight(id: string, metres: number): number {
    const entry = this.entry(id);
    if (!entry) return 1;
    const height = entry.bounds.max[1] - entry.bounds.min[1];
    return height > 0 ? metres / height : 1;
  }

  /** Names of the character skins the pipeline produced. */
  async skinNames(): Promise<string[]> {
    return Object.keys(await this.loadSkins());
  }

  /**
   * A character skin texture, cached. The bundle is one mesh with a swappable
   * colour map, so every NPC look costs a texture rather than a model.
   */
  async skin(name: string): Promise<THREE.Texture | null> {
    const cached = this.skinTextures.get(name);
    if (cached) return cached;
    const index = await this.loadSkins();
    const url = index[name];
    if (!url) return null;
    const texture = await this.textureLoader.loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.skinTextures.set(name, texture);
    return texture;
  }

  private async loadSkins(): Promise<SkinIndex> {
    if (this.skins) return this.skins;
    if (this.skinsPending) return this.skinsPending;
    this.skinsPending = fetch('assets/skins/index.json')
      .then((r) => (r.ok ? (r.json() as Promise<SkinIndex>) : {}))
      .catch(() => ({}))
      .then((index) => {
        this.skins = index;
        return index;
      });
    return this.skinsPending;
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

  /** Hotbar sprite for a model id, produced by the asset pipeline. */
  iconUrl(id: string): string | undefined {
    return this.manifest?.icons?.[id];
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
