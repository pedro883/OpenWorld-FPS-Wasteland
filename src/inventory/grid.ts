import {
  footprintOf,
  type ContainerDef,
  type ItemBase,
  type ItemInstance,
  type ItemTag,
  type Rotation,
} from './types';

export type PlacementError =
  | 'ok'
  | 'foraDoGrid'
  | 'ocupado'
  | 'tipoNaoAceito'
  | 'itemDesconhecido'
  | 'aninhamentoInvalido';

export interface PlacementResult {
  ok: boolean;
  reason: PlacementError;
  x?: number;
  y?: number;
  rotation?: Rotation;
}

/** Looks a base item up by id; the grid never owns the catalogue. */
export type BaseResolver = (baseId: string) => ItemBase | null;

/**
 * One container's occupancy matrix.
 *
 * The matrix stores the uuid occupying each cell rather than a boolean, which
 * costs the same and answers the question the UI actually asks — *what* is under
 * the cursor — without scanning every item on every mouse move.
 */
export class Grid {
  readonly width: number;
  readonly height: number;
  /** `width * height` cells, each holding a uuid or null. */
  private readonly cells: (string | null)[];
  private readonly items = new Map<string, ItemInstance>();

  constructor(
    readonly def: ContainerDef,
    private readonly resolve: BaseResolver,
  ) {
    this.width = Math.max(1, Math.floor(def.width));
    this.height = Math.max(1, Math.floor(def.height));
    this.cells = new Array<string | null>(this.width * this.height).fill(null);
  }

  get id(): string {
    return this.def.id;
  }

  get count(): number {
    return this.items.size;
  }

  list(): ItemInstance[] {
    return [...this.items.values()];
  }

  at(x: number, y: number): ItemInstance | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const uuid = this.cells[y * this.width + x];
    return uuid ? (this.items.get(uuid) ?? null) : null;
  }

  get(uuid: string): ItemInstance | null {
    return this.items.get(uuid) ?? null;
  }

  /** Cells still free, for the weight/space readout. */
  get freeCells(): number {
    let free = 0;
    for (const cell of this.cells) if (cell === null) free++;
    return free;
  }

  /** Does this container's filter admit the item at all? */
  accepts(base: ItemBase): boolean {
    const filter = this.def.accepts;
    if (!filter || filter.length === 0) return true;
    return base.tags.some((tag) => filter.includes(tag));
  }

  /**
   * Can `base` sit at (x, y) with this rotation?
   *
   * `ignoreUuid` exists for moving an item within its own grid: without it an
   * item always collides with itself and nothing could ever be nudged one cell.
   */
  canPlace(
    base: ItemBase,
    x: number,
    y: number,
    rotation: Rotation,
    ignoreUuid?: string,
  ): PlacementError {
    if (!this.accepts(base)) return 'tipoNaoAceito';
    const { w, h } = footprintOf(base, rotation);
    if (x < 0 || y < 0 || x + w > this.width || y + h > this.height) return 'foraDoGrid';
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const occupant = this.cells[(y + dy) * this.width + (x + dx)];
        if (occupant && occupant !== ignoreUuid) return 'ocupado';
      }
    }
    return 'ok';
  }

  private stamp(instance: ItemInstance, base: ItemBase, value: string | null): void {
    const { w, h } = footprintOf(base, instance.rotation);
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        this.cells[(instance.y + dy) * this.width + (instance.x + dx)] = value;
      }
    }
  }

  /** Places an instance at an explicit spot. */
  place(instance: ItemInstance, x: number, y: number, rotation: Rotation): PlacementResult {
    const base = this.resolve(instance.baseId);
    if (!base) return { ok: false, reason: 'itemDesconhecido' };
    const reason = this.canPlace(base, x, y, rotation, instance.uuid);
    if (reason !== 'ok') return { ok: false, reason };

    if (this.items.has(instance.uuid)) this.stamp(instance, base, null);
    instance.x = x;
    instance.y = y;
    instance.rotation = rotation;
    instance.containerId = this.def.id;
    instance.equippedSlot = null;
    this.items.set(instance.uuid, instance);
    this.stamp(instance, base, instance.uuid);
    return { ok: true, reason: 'ok', x, y, rotation };
  }

  /**
   * Finds the first spot the item fits, trying the rotated footprint too.
   *
   * Scanning row-major and preferring the unrotated form is what makes
   * auto-placement predictable: the player learns that picked-up items land
   * top-left, and a rifle only turns sideways when it genuinely has to.
   */
  findSpot(base: ItemBase, allowRotation = true): { x: number; y: number; rotation: Rotation } | null {
    const rotations: Rotation[] = allowRotation && base.width !== base.height ? [0, 90] : [0];
    for (const rotation of rotations) {
      const { w, h } = footprintOf(base, rotation);
      if (w > this.width || h > this.height) continue;
      for (let y = 0; y <= this.height - h; y++) {
        for (let x = 0; x <= this.width - w; x++) {
          if (this.canPlace(base, x, y, rotation) === 'ok') return { x, y, rotation };
        }
      }
    }
    return null;
  }

  /** Places an item wherever it fits. */
  insert(instance: ItemInstance, allowRotation = true): PlacementResult {
    const base = this.resolve(instance.baseId);
    if (!base) return { ok: false, reason: 'itemDesconhecido' };
    if (!this.accepts(base)) return { ok: false, reason: 'tipoNaoAceito' };
    const spot = this.findSpot(base, allowRotation);
    if (!spot) return { ok: false, reason: 'ocupado' };
    return this.place(instance, spot.x, spot.y, spot.rotation);
  }

  remove(uuid: string): ItemInstance | null {
    const instance = this.items.get(uuid);
    if (!instance) return null;
    const base = this.resolve(instance.baseId);
    if (base) this.stamp(instance, base, null);
    this.items.delete(uuid);
    instance.containerId = null;
    return instance;
  }

  /** Rotates in place, refusing when the turned footprint would not fit. */
  rotate(uuid: string): PlacementResult {
    const instance = this.items.get(uuid);
    if (!instance) return { ok: false, reason: 'itemDesconhecido' };
    const base = this.resolve(instance.baseId);
    if (!base) return { ok: false, reason: 'itemDesconhecido' };
    if (base.width === base.height) return { ok: true, reason: 'ok', x: instance.x, y: instance.y, rotation: instance.rotation };

    const next: Rotation = instance.rotation === 0 ? 90 : 0;
    const reason = this.canPlace(base, instance.x, instance.y, next, instance.uuid);
    if (reason !== 'ok') return { ok: false, reason };
    return this.place(instance, instance.x, instance.y, next);
  }

  /** Rebuilds occupancy from a set of instances, e.g. straight out of MySQL. */
  load(instances: ItemInstance[]): { placed: number; rejected: ItemInstance[] } {
    this.cells.fill(null);
    this.items.clear();
    const rejected: ItemInstance[] = [];
    let placed = 0;
    for (const instance of instances) {
      const base = this.resolve(instance.baseId);
      if (!base) {
        rejected.push(instance);
        continue;
      }
      // Stored coordinates are trusted first; a row that no longer fits (the
      // item was resized in a patch) is re-placed rather than dropped.
      if (this.canPlace(base, instance.x, instance.y, instance.rotation) === 'ok') {
        this.place(instance, instance.x, instance.y, instance.rotation);
        placed++;
      } else if (this.insert(instance).ok) {
        placed++;
      } else {
        rejected.push(instance);
      }
    }
    return { placed, rejected };
  }

  /** ASCII picture of the occupancy, for tests and the debug overlay. */
  debugText(): string {
    const symbols = new Map<string, string>();
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let next = 0;
    const rows: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let row = '';
      for (let x = 0; x < this.width; x++) {
        const uuid = this.cells[y * this.width + x];
        if (!uuid) {
          row += '.';
          continue;
        }
        if (!symbols.has(uuid)) symbols.set(uuid, alphabet[next++ % alphabet.length]!);
        row += symbols.get(uuid);
      }
      rows.push(row);
    }
    return rows.join('\n');
  }
}

/** Total weight of a grid, counting what nested containers hold. */
export function weightOf(
  grid: Grid,
  resolve: BaseResolver,
  nested: Map<string, Grid> = new Map(),
): number {
  let total = 0;
  for (const instance of grid.list()) {
    const base = resolve(instance.baseId);
    if (!base) continue;
    // Ammunition weighs per round, so a full magazine is heavier than an empty.
    const stackFactor = base.tags.includes('ammo') ? Math.max(1, instance.quantity) : 1;
    total += base.weightKg * stackFactor;
    const child = nested.get(instance.uuid);
    if (child) total += weightOf(child, resolve, nested);
  }
  return total;
}

/** Does `tag` pass a container filter? */
export function tagAllowed(filter: ItemTag[] | undefined, tags: ItemTag[]): boolean {
  if (!filter || filter.length === 0) return true;
  return tags.some((tag) => filter.includes(tag));
}
