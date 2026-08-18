import { assets } from '../core/assets';
import type { ItemBase, ItemTag } from '../inventory/types';

/**
 * An icon for every item, from two sources.
 *
 * The Weapon Pack ships rendered sprites, which is exactly what a weapon, a
 * magazine or a grenade should look like in a grid. Nothing in the Kenney set
 * depicts a helmet, a vest or a medkit, so those get a drawn glyph instead of a
 * broken image: a silhouette the player can read at a glance beats a generic
 * placeholder repeated across half the inventory.
 *
 * The glyphs are inline SVG rather than files — they are a few hundred bytes
 * each, they inherit the panel's colour, and they stay sharp at any cell size.
 */

/** Sprite id per item, when the Weapon Pack has one that genuinely depicts it. */
const SPRITE_BY_ITEM: Record<string, string> = {
  ammo_9mm: 'weapon-pack/ammo_pistol',
  ammo_556: 'weapon-pack/ammo_machinegun',
  ammo_762: 'weapon-pack/ammo_sniper',
  ammo_12g: 'weapon-pack/ammo_shotgun',
  ammo_40mm: 'weapon-pack/ammo_machinegunLauncher',
  ammo_rocket: 'weapon-pack/ammo_rocket',
  muzzle_suppressor: 'weapon-pack/pistolSilencer',
};

const GLYPHS: Partial<Record<ItemTag, string>> = {
  helmet:
    '<path d="M4 14a8 8 0 0 1 16 0v3H4z"/><path d="M4 17h16v2H4z" opacity=".55"/>',
  armour:
    '<path d="M12 3 5 6v6c0 4 3 7.5 7 9 4-1.5 7-5 7-9V6z"/><path d="M12 3v18" opacity=".4" stroke="currentColor" stroke-width="1" fill="none"/>',
  backpack:
    '<path d="M8 5h8v2a5 5 0 0 1 3 4.5V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7.5A5 5 0 0 1 8 7z"/><rect x="9" y="12" width="6" height="4" rx="1" opacity=".45"/>',
  rig: '<path d="M6 5h12v14H6z"/><rect x="8" y="8" width="3" height="4" opacity=".45"/><rect x="13" y="8" width="3" height="4" opacity=".45"/>',
  headset:
    '<path d="M5 14v-2a7 7 0 0 1 14 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="4" height="6" rx="1"/><rect x="17" y="13" width="4" height="6" rx="1"/>',
  medical:
    '<rect x="4" y="7" width="16" height="12" rx="2"/><path d="M11 10h2v6h-2z" fill="#1b1d20"/><path d="M9 12h6v2H9z" fill="#1b1d20"/>',
  attachment:
    '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4v4M12 16v4M4 12h4M16 12h4"/>',
  valuable: '<path d="m12 3 2.6 5.7 6.4.7-4.8 4.3 1.3 6.3L12 17l-5.5 3 1.3-6.3L3 9.4l6.4-.7z"/>',
  tool: '<path d="m14 4 6 6-3 3-2-2-7 7-4 1 1-4 7-7-2-2z"/>',
  food: '<path d="M7 4h10l-1 16H8z"/><path d="M9 8h6" fill="none" stroke="#1b1d20" stroke-width="1.5"/>',
  container: '<rect x="4" y="7" width="16" height="12" rx="1"/><path d="M4 11h16" fill="none" stroke="#1b1d20" stroke-width="1.5"/>',
  magazine: '<rect x="9" y="4" width="6" height="16" rx="1"/><path d="M9 8h6M9 12h6M9 16h6" fill="none" stroke="#1b1d20" stroke-width="1.2"/>',
  ammo: '<path d="M12 3c2 2 3 4 3 7v6H9v-6c0-3 1-5 3-7z"/><rect x="9" y="16" width="6" height="5" rx="1" opacity=".55"/>',
  throwable: '<circle cx="12" cy="14" r="6"/><path d="M11 4h2v4h-2z"/>',
  weapon: '<path d="M3 10h13l2 3h3v3h-6l-2-2H8v3H5v-3H3z"/>',
  pistol: '<path d="M4 9h12v3h-3l-2 6H8l1-6H4z"/>',
};

const FALLBACK_GLYPH = '<rect x="6" y="6" width="12" height="12" rx="2"/>';

export interface ItemIcon {
  kind: 'sprite' | 'glyph';
  /** URL for a sprite, or the inner SVG markup for a glyph. */
  value: string;
}

/** The sprite for an item, or the glyph that stands in for its category. */
export function iconFor(base: ItemBase): ItemIcon {
  const spriteId = SPRITE_BY_ITEM[base.id];
  const url = spriteId ? assets.iconUrl(spriteId) : undefined;
  if (url) return { kind: 'sprite', value: url };

  // Tags are ordered from specific to generic in the catalogue, so the first
  // one with a glyph is the most descriptive available.
  for (const tag of base.tags) {
    const glyph = GLYPHS[tag];
    if (glyph) return { kind: 'glyph', value: glyph };
  }
  return { kind: 'glyph', value: FALLBACK_GLYPH };
}

/** Builds the element to drop into a grid tile or a slot. */
export function iconElement(base: ItemBase, sizePx: number): Element {
  const icon = iconFor(base);
  if (icon.kind === 'sprite') {
    const img = document.createElement('img');
    img.className = 'inv-icon';
    img.src = icon.value;
    img.alt = base.name;
    img.draggable = false;
    img.style.maxWidth = `${sizePx}px`;
    img.style.maxHeight = `${sizePx}px`;
    return img;
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'inv-icon inv-glyph');
  svg.setAttribute('width', String(Math.min(sizePx, 34)));
  svg.setAttribute('height', String(Math.min(sizePx, 34)));
  svg.setAttribute('fill', 'currentColor');
  svg.innerHTML = icon.value;
  return svg;
}
