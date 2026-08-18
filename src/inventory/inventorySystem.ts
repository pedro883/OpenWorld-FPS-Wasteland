import { Grid, type BaseResolver, type PlacementError } from './grid';
import {
  EQUIP_SLOTS,
  footprintOf,
  type ContainerDef,
  type EquipSlot,
  type ItemAttachment,
  type ItemBase,
  type ItemInstance,
  type ItemTag,
  type Rotation,
} from './types';

export type MoveError =
  | PlacementError
  | 'semContainer'
  | 'itemNaoEncontrado'
  | 'slotInvalido'
  | 'slotOcupado'
  | 'naoPesquisado'
  | 'recursivo'
  | 'slotDeAnexoInvalido';

export interface MoveResult {
  ok: boolean;
  reason: MoveError;
}

const OK: MoveResult = { ok: true, reason: 'ok' };
const fail = (reason: MoveError): MoveResult => ({ ok: false, reason });

/** An item lying on the ground, with the transform its physics settled into. */
export interface GroundItem {
  instance: ItemInstance;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Per-owner equipment: slot -> instance uuid. */
export type Equipment = Partial<Record<EquipSlot, string>>;

/** How far along a search of a corpse or crate is. */
interface SearchState {
  elapsed: number;
  revealed: boolean;
}

/**
 * Owns every grid in the game and every rule about moving between them.
 *
 * The grids themselves only know about cells; anything that spans two of them —
 * equipping, nesting a backpack, dropping to the floor, searching a corpse —
 * lives here, because those are the operations that can leave an item in two
 * places at once if they go wrong halfway.
 */
export class InventorySystem {
  private readonly grids = new Map<string, Grid>();
  private readonly instances = new Map<string, ItemInstance>();
  private readonly equipment = new Map<string, Equipment>();
  private readonly attachments: ItemAttachment[] = [];
  private readonly ground: GroundItem[] = [];
  private readonly searches = new Map<string, SearchState>();
  /** Nested grid created by a container item, keyed by that item's uuid. */
  private readonly nestedByItem = new Map<string, string>();

  constructor(private readonly resolve: BaseResolver) {}

  // ---- Contêineres --------------------------------------------------------

  createContainer(def: ContainerDef): Grid {
    const grid = new Grid(def, this.resolve);
    this.grids.set(def.id, grid);
    if ((def.searchSeconds ?? 0) > 0) {
      this.searches.set(def.id, { elapsed: 0, revealed: false });
    }
    return grid;
  }

  container(id: string): Grid | null {
    return this.grids.get(id) ?? null;
  }

  get containerIds(): string[] {
    return [...this.grids.keys()];
  }

  instance(uuid: string): ItemInstance | null {
    return this.instances.get(uuid) ?? null;
  }

  /** Registers an instance so the system can find it wherever it goes. */
  track(instance: ItemInstance): void {
    this.instances.set(instance.uuid, instance);
  }

  /**
   * Puts a container item's own grid into the world.
   *
   * A backpack is two things at once: an instance sitting in someone's crate,
   * and a container holding magazines. This is what creates the second half.
   */
  openNested(instance: ItemInstance): Grid | null {
    const existing = this.nestedByItem.get(instance.uuid);
    if (existing) return this.grids.get(existing) ?? null;
    const base = this.resolve(instance.baseId);
    if (!base?.container) return null;
    const id = `${instance.uuid}:conteudo`;
    const grid = this.createContainer({
      id,
      kind: 'nested',
      name: base.name,
      width: base.container.width,
      height: base.container.height,
      ownerId: null,
      accepts: base.container.accepts,
      parentInstanceId: instance.uuid,
    });
    this.nestedByItem.set(instance.uuid, id);
    return grid;
  }

  nestedGridOf(uuid: string): Grid | null {
    const id = this.nestedByItem.get(uuid);
    return id ? (this.grids.get(id) ?? null) : null;
  }

  /**
   * Would moving `item` into `target` put it inside itself?
   *
   * A backpack dropped into its own main compartment would vanish from the
   * world while still holding everything — the classic inventory soft-lock.
   */
  private wouldRecurse(itemUuid: string, targetGridId: string): boolean {
    let cursor: string | undefined = targetGridId;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const def: ContainerDef | undefined = this.grids.get(cursor)?.def;
      const parent: string | null = def?.parentInstanceId ?? null;
      if (!parent) return false;
      if (parent === itemUuid) return true;
      cursor = this.instances.get(parent)?.containerId ?? undefined;
    }
    return false;
  }

  // ---- Busca em corpos e caixas -------------------------------------------

  /** True when the contents may be shown; false while still unsearched. */
  isRevealed(containerId: string): boolean {
    const state = this.searches.get(containerId);
    return !state || state.revealed;
  }

  searchProgress(containerId: string): number {
    const state = this.searches.get(containerId);
    if (!state) return 1;
    const total = this.grids.get(containerId)?.def.searchSeconds ?? 0;
    if (total <= 0) return 1;
    return Math.min(1, state.elapsed / total);
  }

  /** Advances a search; returns true the moment it completes. */
  advanceSearch(containerId: string, dt: number): boolean {
    const state = this.searches.get(containerId);
    if (!state || state.revealed) return false;
    const total = this.grids.get(containerId)?.def.searchSeconds ?? 0;
    state.elapsed += dt;
    if (state.elapsed >= total) {
      state.revealed = true;
      return true;
    }
    return false;
  }

  /** Interrupting a search keeps the progress, so it is not punishing. */
  resetSearch(containerId: string): void {
    const state = this.searches.get(containerId);
    if (state) state.elapsed = Math.max(0, state.elapsed);
  }

  // ---- Mover entre grids ---------------------------------------------------

  /** Moves an item into a container at an explicit cell. */
  moveTo(uuid: string, containerId: string, x: number, y: number, rotation: Rotation): MoveResult {
    const instance = this.instances.get(uuid);
    if (!instance) return fail('itemNaoEncontrado');
    const target = this.grids.get(containerId);
    if (!target) return fail('semContainer');
    if (!this.isRevealed(containerId)) return fail('naoPesquisado');
    if (this.wouldRecurse(uuid, containerId)) return fail('recursivo');

    const base = this.resolve(instance.baseId);
    if (!base) return fail('itemDesconhecido');
    const reason = target.canPlace(base, x, y, rotation, uuid);
    if (reason !== 'ok') return fail(reason);

    this.detach(instance);
    const result = target.place(instance, x, y, rotation);
    return result.ok ? OK : fail(result.reason);
  }

  /** Moves an item into the first free spot of a container. */
  moveInto(uuid: string, containerId: string): MoveResult {
    const instance = this.instances.get(uuid);
    if (!instance) return fail('itemNaoEncontrado');
    const target = this.grids.get(containerId);
    if (!target) return fail('semContainer');
    if (!this.isRevealed(containerId)) return fail('naoPesquisado');
    if (this.wouldRecurse(uuid, containerId)) return fail('recursivo');

    const base = this.resolve(instance.baseId);
    if (!base) return fail('itemDesconhecido');
    if (!target.accepts(base)) return fail('tipoNaoAceito');
    const spot = target.findSpot(base);
    if (!spot) return fail('ocupado');

    this.detach(instance);
    const result = target.place(instance, spot.x, spot.y, spot.rotation);
    return result.ok ? OK : fail(result.reason);
  }

  /** Takes the item out of wherever it currently is, without placing it. */
  private detach(instance: ItemInstance): void {
    if (instance.containerId) this.grids.get(instance.containerId)?.remove(instance.uuid);
    if (instance.equippedSlot) {
      for (const [owner, set] of this.equipment) {
        if (set[instance.equippedSlot] === instance.uuid) {
          delete set[instance.equippedSlot];
          void owner;
        }
      }
      instance.equippedSlot = null;
    }
    const onGround = this.ground.findIndex((g) => g.instance.uuid === instance.uuid);
    if (onGround >= 0) this.ground.splice(onGround, 1);
    instance.containerId = null;
  }

  // ---- Equipamento ---------------------------------------------------------

  equipmentOf(ownerId: string): Equipment {
    let set = this.equipment.get(ownerId);
    if (!set) {
      set = {};
      this.equipment.set(ownerId, set);
    }
    return set;
  }

  /**
   * Equips into a slot, refusing anything the slot does not admit.
   *
   * The restriction is on the item, not on the slot's name: a helmet declares
   * it goes on a head, so adding a new slot never means auditing every item.
   */
  equip(ownerId: string, uuid: string, slot: EquipSlot): MoveResult {
    const instance = this.instances.get(uuid);
    if (!instance) return fail('itemNaoEncontrado');
    if (!EQUIP_SLOTS.includes(slot)) return fail('slotInvalido');
    const base = this.resolve(instance.baseId);
    if (!base) return fail('itemDesconhecido');
    if (!base.equipSlots?.includes(slot)) return fail('slotInvalido');

    const set = this.equipmentOf(ownerId);
    if (set[slot] && set[slot] !== uuid) return fail('slotOcupado');

    this.detach(instance);
    set[slot] = uuid;
    instance.equippedSlot = slot;
    instance.containerId = null;
    // A worn container starts holding things the moment it goes on.
    if (base.container) this.openNested(instance);
    return OK;
  }

  /** Unequips into a container, or refuses if it will not fit. */
  unequip(ownerId: string, slot: EquipSlot, intoContainerId: string): MoveResult {
    const set = this.equipmentOf(ownerId);
    const uuid = set[slot];
    if (!uuid) return fail('itemNaoEncontrado');
    const result = this.moveInto(uuid, intoContainerId);
    // Only clear the slot once the item has somewhere to be, or it is lost.
    if (result.ok) delete set[slot];
    return result;
  }

  equippedIn(ownerId: string, slot: EquipSlot): ItemInstance | null {
    const uuid = this.equipmentOf(ownerId)[slot];
    return uuid ? (this.instances.get(uuid) ?? null) : null;
  }

  // ---- Anexos --------------------------------------------------------------

  attach(parentUuid: string, slotType: string, childUuid: string): MoveResult {
    const parent = this.instances.get(parentUuid);
    const child = this.instances.get(childUuid);
    if (!parent || !child) return fail('itemNaoEncontrado');
    const parentBase = this.resolve(parent.baseId);
    const childBase = this.resolve(child.baseId);
    if (!parentBase || !childBase) return fail('itemDesconhecido');

    const slot = parentBase.attachmentSlots?.find((s) => s.type === slotType);
    if (!slot) return fail('slotDeAnexoInvalido');
    if (!childBase.tags.some((tag) => slot.accepts.includes(tag))) return fail('tipoNaoAceito');
    if (this.attachments.some((a) => a.parentInstanceId === parentUuid && a.slotType === slotType)) {
      return fail('slotOcupado');
    }
    // A part cannot be on two weapons at once.
    if (this.attachments.some((a) => a.childInstanceId === childUuid)) return fail('slotOcupado');

    this.detach(child);
    this.attachments.push({ parentInstanceId: parentUuid, slotType, childInstanceId: childUuid });
    return OK;
  }

  detachAttachment(childUuid: string, intoContainerId: string): MoveResult {
    const index = this.attachments.findIndex((a) => a.childInstanceId === childUuid);
    if (index < 0) return fail('itemNaoEncontrado');
    const result = this.moveInto(childUuid, intoContainerId);
    if (result.ok) this.attachments.splice(index, 1);
    return result;
  }

  attachmentsOf(parentUuid: string): ItemAttachment[] {
    return this.attachments.filter((a) => a.parentInstanceId === parentUuid);
  }

  // ---- Chão ----------------------------------------------------------------

  /** Drops an item in front of the player. */
  drop(uuid: string, x: number, y: number, z: number, yaw = 0): GroundItem | null {
    const instance = this.instances.get(uuid);
    if (!instance) return null;
    this.detach(instance);
    const entry: GroundItem = { instance, x, y, z, yaw };
    this.ground.push(entry);
    return entry;
  }

  /** Everything lying within `radius` of a point, nearest first. */
  groundNear(x: number, z: number, radius = 3): GroundItem[] {
    return this.ground
      .map((item) => ({ item, d: Math.hypot(item.x - x, item.z - z) }))
      .filter((entry) => entry.d <= radius)
      .sort((a, b) => a.d - b.d)
      .map((entry) => entry.item);
  }

  groundItem(uuid: string): GroundItem | null {
    return this.ground.find((g) => g.instance.uuid === uuid) ?? null;
  }

  get groundCount(): number {
    return this.ground.length;
  }

  /** Picks an item off the floor into a container. */
  pickUp(uuid: string, intoContainerId: string): MoveResult {
    if (!this.groundItem(uuid)) return fail('itemNaoEncontrado');
    return this.moveInto(uuid, intoContainerId);
  }

  // ---- Consultas -----------------------------------------------------------

  /** Containers within reach, for the proximity interaction. */
  containersNear(x: number, z: number, radius = 3): Grid[] {
    const out: { grid: Grid; d: number }[] = [];
    for (const grid of this.grids.values()) {
      const pos = grid.def.position;
      if (!pos) continue;
      const d = Math.hypot(pos.x - x, pos.z - z);
      if (d <= radius) out.push({ grid, d });
    }
    return out.sort((a, b) => a.d - b.d).map((entry) => entry.grid);
  }

  /** Total weight an owner is carrying, equipment and nested grids included. */
  totalWeight(ownerId: string): number {
    let total = 0;
    const counted = new Set<string>();

    const addInstance = (instance: ItemInstance): void => {
      if (counted.has(instance.uuid)) return;
      counted.add(instance.uuid);
      const base = this.resolve(instance.baseId);
      if (!base) return;
      const stack = base.tags.includes('ammo') ? Math.max(1, instance.quantity) : 1;
      total += base.weightKg * stack;
      const nested = this.nestedGridOf(instance.uuid);
      if (nested) for (const child of nested.list()) addInstance(child);
      for (const attachment of this.attachmentsOf(instance.uuid)) {
        const child = this.instances.get(attachment.childInstanceId);
        if (child) addInstance(child);
      }
    };

    for (const uuid of Object.values(this.equipmentOf(ownerId))) {
      const instance = uuid ? this.instances.get(uuid) : null;
      if (instance) addInstance(instance);
    }
    for (const grid of this.grids.values()) {
      if (grid.def.ownerId === ownerId) for (const child of grid.list()) addInstance(child);
    }
    return total;
  }

  /** Everything a corpse is carrying, for the body-inspection panel. */
  corpseContents(containerId: string): { slots: Equipment; grid: Grid | null } {
    const grid = this.grids.get(containerId) ?? null;
    const owner = grid?.def.ownerId;
    return { slots: owner ? this.equipmentOf(owner) : {}, grid };
  }
}

/** Cells an item takes, for a UI that needs the size before placing. */
export function cellsOf(base: ItemBase, rotation: Rotation): number {
  const { w, h } = footprintOf(base, rotation);
  return w * h;
}

export type { ItemTag };
