import * as THREE from 'three';
import lootConfig from '../../config/loot.json';
import { assets } from '../core/assets';
import { Random, hashSeed } from '../core/random';
import type { Wallet } from '../economy/wallet';
import { Inventory, itemDef } from './inventory';
import { rollCorpseLoot, rollLoot, type LootRoll } from '../loot/lootTable';

const MODELS = lootConfig.models as unknown as Record<string, string[]>;
const CONTAINERS = lootConfig.containers as unknown as Record<
  string,
  { tier: string; count: number }
>;

export type LootSourceKind = 'container' | 'corpse' | 'cache';

export interface TakeResult {
  items: { id: string; count: number }[];
  money: number;
  /** True when something was left behind because the bag was full. */
  leftBehind: boolean;
}

/**
 * A lootable thing in the world.
 *
 * Contents are rolled once, from a seed derived from the container's own id, so
 * a crate holds what it holds: walking away and coming back cannot re-roll it,
 * and neither can reloading the save.
 */
export class LootSource {
  readonly contents: LootRoll;
  emptied = false;
  private model: THREE.Object3D | null = null;

  constructor(
    readonly id: string,
    readonly kind: LootSourceKind,
    readonly position: THREE.Vector3,
    readonly tier: string,
    contents?: LootRoll,
  ) {
    this.contents = contents ?? rollLoot(tier, new Random(hashSeed(id)));
  }

  get isEmpty(): boolean {
    return this.contents.items.length === 0 && this.contents.money <= 0;
  }

  get label(): string {
    if (this.kind === 'corpse') return 'Revistar corpo';
    if (this.kind === 'cache') return 'Abrir caixa de suprimentos';
    return 'Abrir contêiner';
  }

  attach(model: THREE.Object3D): void {
    this.model = model;
  }

  /**
   * Moves everything that fits into the bag.
   *
   * What does not fit stays in the container rather than vanishing, so a full
   * player can drop something and come back for the rest.
   */
  takeAll(inventory: Inventory, wallet: Wallet): TakeResult {
    const taken: { id: string; count: number }[] = [];
    let leftBehind = false;

    for (const stack of [...this.contents.items]) {
      const moved = inventory.add(stack.id, stack.count);
      if (moved > 0) taken.push({ id: stack.id, count: moved });
      if (moved < stack.count) {
        stack.count -= moved;
        leftBehind = true;
      } else {
        this.contents.items.splice(this.contents.items.indexOf(stack), 1);
      }
    }

    const money = this.contents.money;
    // Money has no weight, so it always comes along.
    if (money > 0) {
      wallet.earn(money);
      this.contents.money = 0;
    }

    this.emptied = this.isEmpty;
    if (this.emptied) this.markEmpty();
    return { items: taken, money, leftBehind };
  }

  /** Dims an emptied container so the player can see it is done. */
  private markEmpty(): void {
    this.model?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const material = (mesh.material as THREE.MeshStandardMaterial).clone();
      material.color.multiplyScalar(0.45);
      mesh.material = material;
    });
  }

  dispose(scene: THREE.Scene): void {
    if (this.model) scene.remove(this.model);
    this.model = null;
  }
}

export interface LootFieldDeps {
  scene: THREE.Scene;
  groundAt(x: number, z: number): number | null;
}

/**
 * Every lootable thing in the world, and the lookup the interaction key uses.
 *
 * Containers are placed once per POI from the layout seed; corpses appear where
 * NPCs fall. Both live in the same list because the player interacts with them
 * the same way, and because a single nearest-thing search keeps the `E` key
 * from having to arbitrate between three separate systems.
 */
export class LootField {
  private readonly sources: LootSource[] = [];
  private pendingModels = 0;

  constructor(private readonly deps: LootFieldDeps) {}

  get count(): number {
    return this.sources.length;
  }

  get remaining(): number {
    return this.sources.filter((s) => !s.emptied).length;
  }

  list(): readonly LootSource[] {
    return this.sources;
  }

  /** Scatters containers around a POI, deterministically from its id. */
  spawnAtPoi(poi: { id: string; kind: string; x: number; z: number; radius: number }): void {
    const plan = CONTAINERS[poi.kind];
    if (!plan) return;
    const rng = new Random(hashSeed(`loot-${poi.id}`));
    for (let i = 0; i < plan.count; i++) {
      const angle = rng.range(0, Math.PI * 2);
      // Kept off the exact centre, where the buildings are densest.
      const radius = poi.radius * rng.range(0.25, 0.95);
      const x = poi.x + Math.cos(angle) * radius;
      const z = poi.z + Math.sin(angle) * radius;
      this.add(`${poi.id}-caixa-${i}`, 'container', x, z, plan.tier, rng);
    }
  }

  /** A mission cache: same idea, but tied to the mission rather than a place. */
  spawnCache(id: string, x: number, z: number, tier: string): void {
    this.add(id, 'cache', x, z, tier, new Random(hashSeed(id)));
  }

  private add(
    id: string,
    kind: LootSourceKind,
    x: number,
    z: number,
    tier: string,
    rng: Random,
  ): void {
    const y = this.deps.groundAt(x, z);
    const source = new LootSource(id, kind, new THREE.Vector3(x, y ?? 0, z), tier);
    this.sources.push(source);

    const modelId = rng.pick(MODELS[tier] ?? MODELS.civil ?? []);
    if (!modelId) return;
    this.pendingModels++;
    void assets
      .instantiate(modelId)
      .then((model) => {
        model.position.copy(source.position);
        model.rotation.y = rng.range(0, Math.PI * 2);
        this.deps.scene.add(model);
        source.attach(model);
      })
      .catch(() => {
        /* A missing model leaves the container invisible but still lootable. */
      })
      .finally(() => {
        this.pendingModels--;
      });
  }

  /** Registers what an NPC left behind. Corpses roll from the dead one's skill. */
  registerCorpse(id: string, position: THREE.Vector3, skill: string): LootSource {
    const roll = rollCorpseLoot(skill, new Random(hashSeed(`corpo-${id}`)));
    const source = new LootSource(id, 'corpse', position.clone(), 'civil', roll);
    this.sources.push(source);
    return source;
  }

  /** Nearest thing worth pressing E on, or null. */
  nearest(position: THREE.Vector3, radius = 2.6): LootSource | null {
    let best: LootSource | null = null;
    let bestDistance = radius;
    for (const source of this.sources) {
      if (source.emptied) continue;
      const d = source.position.distanceTo(position);
      if (d < bestDistance) {
        bestDistance = d;
        best = source;
      }
    }
    return best;
  }

  /** Human-readable summary of a haul, for the on-screen message. */
  static describe(result: TakeResult): string {
    const parts = result.items.map(
      (stack) => `${itemDef(stack.id)?.name ?? stack.id} x${stack.count}`,
    );
    if (result.money > 0) parts.push(`$${result.money}`);
    if (!parts.length) return 'Vazio';
    return parts.join(' · ') + (result.leftBehind ? ' (peso no limite)' : '');
  }

  dispose(): void {
    for (const source of this.sources) source.dispose(this.deps.scene);
    this.sources.length = 0;
  }
}
