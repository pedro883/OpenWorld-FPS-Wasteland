import { itemDef, type ItemStack } from '../entities/inventory';
import { deleteRecord, isPersistenceAvailable, readRecord, writeRecord } from './db';

/**
 * Bumped whenever the shape changes in a way `normalizeSave` cannot repair on
 * its own. Older saves are read through the same normaliser, which fills in
 * whatever the old shape lacked, so a version bump is only for real breaks.
 */
export const SAVE_VERSION = 1;
const SAVE_KEY = 'save';

export interface SaveStats {
  kills: number;
  deaths: number;
  missionsCompleted: number;
  moneyEarned: number;
  secondsPlayed: number;
}

export interface SaveState {
  version: number;
  savedAt: number;
  /** World seed, so a save always reloads into the map it was made in. */
  seed: number;
  /** Money in the bank; this is what survives death. */
  bank: number;
  /** Money in the pocket; this is what death takes. */
  carried: number;
  position: [number, number, number];
  yaw: number;
  inventory: ItemStack[];
  /** Weapon ids the player owns, beyond the starting kit. */
  weapons: string[];
  /** Attachment ids fitted per weapon. */
  attachments: Record<string, string[]>;
  /** Reserve rounds per calibre. */
  ammo: Record<string, number>;
  stats: SaveStats;
  /** Options screen: volumes, aim, graphics and keybinds. */
  settings: SaveSettings;
}

export interface SaveSettings {
  volumes: Record<string, number>;
  sensitivity: number;
  fov: number;
  quality: string;
  invertY: boolean;
  keybinds: Record<string, string>;
}

export function defaultSave(seed: number): SaveState {
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    seed,
    bank: 0,
    carried: 0,
    position: [0, 0, 0],
    yaw: 0,
    inventory: [],
    weapons: [],
    attachments: {},
    ammo: {},
    stats: { kills: 0, deaths: 0, missionsCompleted: 0, moneyEarned: 0, secondsPlayed: 0 },
    settings: {
      volumes: {},
      sensitivity: 1,
      fov: 75,
      quality: 'alta',
      invertY: false,
      keybinds: {},
    },
  };
}

/**
 * Settings are sanitised the same way as the rest of the save, and for the same
 * reason: a corrupted `fov` of zero or a sensitivity of NaN would leave the
 * player looking at nothing with no way to reach the options screen.
 */
function normalizeSettings(raw: unknown, fallback: SaveSettings): SaveSettings {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const data = raw as Record<string, unknown>;
  const volumes: Record<string, number> = {};
  if (data.volumes && typeof data.volumes === 'object') {
    for (const [channel, value] of Object.entries(data.volumes as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        volumes[channel] = Math.max(0, Math.min(1, value));
      }
    }
  }
  const keys: Record<string, string> = {};
  if (data.keybinds && typeof data.keybinds === 'object') {
    for (const [action, code] of Object.entries(data.keybinds as Record<string, unknown>)) {
      if (typeof code === 'string') keys[action] = code;
    }
  }
  const quality = typeof data.quality === 'string' ? data.quality : fallback.quality;
  return {
    volumes,
    sensitivity: clampNumber(data.sensitivity, fallback.sensitivity, 0.2, 3),
    fov: clampNumber(data.fov, fallback.fov, 60, 110),
    quality: ['baixa', 'media', 'alta'].includes(quality) ? quality : fallback.quality,
    invertY: data.invertY === true,
    keybinds: keys,
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
  return Math.max(0, num(value, fallback));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Turns whatever came out of storage into a save the game can actually load.
 *
 * Everything here is defensive on purpose. The stored blob is the one input the
 * game cannot control: it may come from an older build, from a hand-edited
 * database, or from a write that was interrupted halfway. Refusing to load is
 * only correct when the data is not a save at all — otherwise a player loses a
 * whole run to one field that went missing.
 */
export function normalizeSave(raw: unknown, seed: number): SaveState | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.version !== 'number') return null;
  // A save from a future build may rely on fields this one cannot honour.
  if (data.version > SAVE_VERSION) return null;

  const base = defaultSave(seed);
  const position = Array.isArray(data.position) ? data.position : [];
  const stats = (data.stats ?? {}) as Record<string, unknown>;

  const inventory: ItemStack[] = [];
  if (Array.isArray(data.inventory)) {
    for (const entry of data.inventory) {
      if (!entry || typeof entry !== 'object') continue;
      const stack = entry as Record<string, unknown>;
      const id = typeof stack.id === 'string' ? stack.id : '';
      const count = Math.floor(nonNegative(stack.count, 0));
      // Items retired from the catalogue drop out instead of loading as holes.
      if (!id || count <= 0 || !itemDef(id)) continue;
      inventory.push({ id, count });
    }
  }

  const attachments: Record<string, string[]> = {};
  if (data.attachments && typeof data.attachments === 'object') {
    for (const [weapon, list] of Object.entries(data.attachments as Record<string, unknown>)) {
      const ids = stringList(list);
      if (ids.length) attachments[weapon] = ids;
    }
  }

  const ammo: Record<string, number> = {};
  if (data.ammo && typeof data.ammo === 'object') {
    for (const [calibre, amount] of Object.entries(data.ammo as Record<string, unknown>)) {
      ammo[calibre] = Math.floor(nonNegative(amount, 0));
    }
  }

  return {
    version: SAVE_VERSION,
    savedAt: num(data.savedAt, base.savedAt),
    // The seed is what ties a save to a map; a save without one belongs here.
    seed: num(data.seed, seed),
    bank: Math.floor(nonNegative(data.bank, 0)),
    carried: Math.floor(nonNegative(data.carried, 0)),
    position: [num(position[0], 0), num(position[1], 0), num(position[2], 0)],
    yaw: num(data.yaw, 0),
    inventory,
    weapons: stringList(data.weapons),
    attachments,
    ammo,
    stats: {
      kills: Math.floor(nonNegative(stats.kills, 0)),
      deaths: Math.floor(nonNegative(stats.deaths, 0)),
      missionsCompleted: Math.floor(nonNegative(stats.missionsCompleted, 0)),
      moneyEarned: Math.floor(nonNegative(stats.moneyEarned, 0)),
      secondsPlayed: nonNegative(stats.secondsPlayed, 0),
    },
    settings: normalizeSettings(data.settings, base.settings),
  };
}

/** Reads the save for this seed, or null when there is none to read. */
export async function loadSave(seed: number): Promise<SaveState | null> {
  const raw = await readRecord<unknown>(SAVE_KEY);
  const save = normalizeSave(raw, seed);
  if (!save) return null;
  // A save made in another world would drop the player into unrelated terrain.
  if (save.seed !== seed) return null;
  return save;
}

export async function storeSave(state: SaveState): Promise<boolean> {
  return writeRecord(SAVE_KEY, { ...state, version: SAVE_VERSION, savedAt: Date.now() });
}

export async function clearSave(): Promise<void> {
  await deleteRecord(SAVE_KEY);
}

export { isPersistenceAvailable };
