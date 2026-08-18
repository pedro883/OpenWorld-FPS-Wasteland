/**
 * Data model for the grid inventory, shaped to map straight onto the MySQL
 * schema in `sql/inventory.sql`.
 *
 * The split is deliberate and it is the same split the database makes:
 *
 * - `ItemBase` is the *definition* — what a rifle is. One row, shared by every
 *   rifle in the world, never mutated at runtime.
 * - `ItemInstance` is *this* rifle — the one in your hands, with its own
 *   durability, its own rounds, its own place in a grid. One row per object.
 *
 * Collapsing the two, which is tempting while everything is in memory, is what
 * makes a save impossible later: there would be nothing stable to point a
 * foreign key at.
 */

/** Where an item is allowed to be equipped. */
export type EquipSlot =
  | 'primary'
  | 'secondary'
  | 'holster'
  | 'helmet'
  | 'armour'
  | 'headset'
  | 'backpack'
  | 'rig'
  | 'pockets';

export const EQUIP_SLOTS: EquipSlot[] = [
  'primary',
  'secondary',
  'holster',
  'helmet',
  'armour',
  'headset',
  'backpack',
  'rig',
  'pockets',
];

/** Free-form classification, used by container filters and slot restrictions. */
export type ItemTag =
  | 'weapon'
  | 'pistol'
  | 'attachment'
  | 'magazine'
  | 'ammo'
  | 'throwable'
  | 'medical'
  | 'armour'
  | 'helmet'
  | 'headset'
  | 'backpack'
  | 'rig'
  | 'container'
  | 'valuable'
  | 'tool'
  | 'food';

export type Rotation = 0 | 90;

export interface AttachmentSlotDef {
  /** `optic`, `muzzle`, `magazine`, `grip`, `stock`. */
  type: string;
  /** Tags an attachment must carry to fit here. */
  accepts: ItemTag[];
}

export interface ItemBase {
  id: string;
  name: string;
  /** Footprint in grid cells, unrotated. */
  width: number;
  height: number;
  weightKg: number;
  value: number;
  tags: ItemTag[];
  /** Slots this item may be equipped into, if any. */
  equipSlots?: EquipSlot[];
  /** Set when the item is itself a container: its internal grid. */
  container?: { width: number; height: number; accepts?: ItemTag[] };
  /** Rounds a magazine holds, or a weapon's chamber capacity. */
  capacity?: number;
  /** Calibre, for magazines and ammunition. */
  calibre?: string;
  maxDurability?: number;
  attachmentSlots?: AttachmentSlotDef[];
  /** Model id for the world drop, from the asset manifest. */
  model?: string;
}

export interface ItemInstance {
  /** Stable identity; the primary key in `item_instances`. */
  uuid: string;
  baseId: string;
  /** Container holding it, or null while it is equipped, attached or on the floor. */
  containerId: string | null;
  x: number;
  y: number;
  rotation: Rotation;
  /** Set instead of x/y when the item sits in an equipment slot. */
  equippedSlot: EquipSlot | null;
  /** Rounds loaded, or units in a stack. */
  quantity: number;
  durability: number;
  /** Anything that does not deserve a column of its own. */
  extra: Record<string, unknown>;
}

export type ContainerKind =
  | 'player'
  | 'equipment'
  | 'stash'
  | 'crate'
  | 'corpse'
  | 'ground'
  | 'nested';

export interface ContainerDef {
  id: string;
  kind: ContainerKind;
  name: string;
  width: number;
  height: number;
  /** Player who owns it, for a stash; null for world containers. */
  ownerId: string | null;
  /** Only these tags may enter. Empty or absent means anything fits. */
  accepts?: ItemTag[];
  /** World position, for crates, corpses and ground piles. */
  position?: { x: number; y: number; z: number };
  /** Instance whose `container` definition created this grid, for nesting. */
  parentInstanceId?: string | null;
  /**
   * Seconds to search before the contents are revealed. Zero means the grid is
   * visible immediately, which is how the player's own containers behave.
   */
  searchSeconds?: number;
}

export interface ItemAttachment {
  parentInstanceId: string;
  slotType: string;
  childInstanceId: string;
}

/** The footprint of an instance once its rotation is taken into account. */
export function footprintOf(base: ItemBase, rotation: Rotation): { w: number; h: number } {
  return rotation === 90
    ? { w: base.height, h: base.width }
    : { w: base.width, h: base.height };
}

/** Row shape for `item_instances`, ready to hand to the driver. */
export interface ItemInstanceRow {
  uuid: string;
  base_item_id: string;
  container_id: string | null;
  position_x: number | null;
  position_y: number | null;
  rotation: number;
  equipped_slot: string | null;
  quantity: number;
  durability: number;
  extra_json: string;
}

export function toRow(instance: ItemInstance): ItemInstanceRow {
  return {
    uuid: instance.uuid,
    base_item_id: instance.baseId,
    container_id: instance.containerId,
    // An equipped item has a slot instead of coordinates; writing 0,0 would make
    // it collide with whatever genuinely sits in the corner of the grid.
    position_x: instance.equippedSlot ? null : instance.x,
    position_y: instance.equippedSlot ? null : instance.y,
    rotation: instance.rotation,
    equipped_slot: instance.equippedSlot,
    quantity: instance.quantity,
    durability: instance.durability,
    extra_json: JSON.stringify(instance.extra ?? {}),
  };
}

export function fromRow(row: ItemInstanceRow): ItemInstance {
  let extra: Record<string, unknown> = {};
  try {
    // A corrupted blob costs the item its extras, not the whole load.
    extra = row.extra_json ? (JSON.parse(row.extra_json) as Record<string, unknown>) : {};
  } catch {
    extra = {};
  }
  return {
    uuid: row.uuid,
    baseId: row.base_item_id,
    containerId: row.container_id,
    x: row.position_x ?? 0,
    y: row.position_y ?? 0,
    rotation: row.rotation === 90 ? 90 : 0,
    equippedSlot: (row.equipped_slot as EquipSlot | null) ?? null,
    quantity: Number.isFinite(row.quantity) ? row.quantity : 0,
    durability: Number.isFinite(row.durability) ? row.durability : 100,
    extra,
  };
}
