/**
 * Selective extraction from the Kenney zip into `_assets_raw/`.
 *
 * The archive holds 88k files and ships every model in six formats. Only the
 * GLB of each selected kit is pulled out — plus audio, fonts and UI sprites —
 * which is roughly 3% of the archive and keeps the working tree navigable.
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { open } from 'yauzl-promise';
import { ZIP_PATH, parseEntry } from './zip-utils.mjs';
import { SELECTED_3D, SELECTED_AUDIO } from './asset-selection.mjs';

const UI_WANTED = [
  // Kenney ships a rendered sprite of every weapon; they are exactly what the
  // hotbar needs, so no icon has to be drawn by hand.
  { prefix: '3D assets/Weapon Pack/Sprites/Render/', exts: ['.png'], out: 'weapons' },
  { prefix: 'UI assets/UI Pack/PNG/', exts: ['.png'] },
  { prefix: 'Icons/Game Icons/PNG/White/2x/', exts: ['.png'] },
  { prefix: 'Icons/Input Prompts/Keyboard & Mouse/Default/', exts: ['.png'] },
  { prefix: 'Other/Fonts/', exts: ['.ttf'] },
];

/** Decides whether a zip entry is worth writing to disk, and where it lands. */
export function classify(name) {
  const { category, pack, rest } = parseEntry(name);
  const ext = path.extname(name).toLowerCase();

  // UI rules run first: some of them live *inside* a 3D pack (the weapon
  // sprites), and the model rules below would reject those paths outright.
  for (const want of UI_WANTED) {
    if (name.startsWith(want.prefix) && want.exts.includes(ext)) {
      return {
        kind: 'ui',
        pack,
        base: path.basename(name, ext),
        out: path.join('UI', want.out ?? '', name.slice(want.prefix.length)),
      };
    }
  }

  if (category === '3D assets' && SELECTED_3D[pack] && rest.startsWith('Models/')) {

    // Kenney GLBs reference their colormap by relative URI, so the texture has
    // to land in `<pack>/Textures/` next to the flattened models. The same PNG
    // is duplicated under each format folder; whichever we hit is fine.
    if (ext === '.png' && rest.includes('/Textures/')) {
      const file = path.basename(name);
      return { kind: 'texture', pack, base: file, out: path.join('3D', pack, 'Textures', file) };
    }

    // Kits disagree on the folder name ("GLB format" vs "GLTF format"), so we
    // match on the extension and only require that it sits under Models/.
    if (ext !== '.glb') return null;
    const base = path.basename(name, '.glb');
    const filter = SELECTED_3D[pack].include;
    if (filter && !filter.test(base)) return null;
    return { kind: 'model', pack, base, out: path.join('3D', pack, `${base}.glb`) };
  }

  if (category === 'Audio' && SELECTED_AUDIO[pack] && ext === '.ogg') {
    return { kind: 'audio', pack, base: path.basename(name, '.ogg'), out: path.join('Audio', pack, path.basename(name)) };
  }

  if (name.startsWith('3D assets/') && path.basename(name) === 'License.txt' && SELECTED_3D[pack]) {
    return { kind: 'license', pack, base: 'License', out: path.join('3D', pack, 'License.txt') };
  }

  return null;
}

export async function extractSelected(rawDir, { force = false } = {}) {
  const marker = path.join(rawDir, '.extracted');
  if (!force) {
    try {
      const previous = JSON.parse(await fs.readFile(marker, 'utf8'));
      console.log(`  _assets_raw/ já populado (${previous.files} arquivos) — pulando extração.`);
      return previous;
    } catch {
      /* not extracted yet */
    }
  }

  const zip = await open(ZIP_PATH);
  const stats = { files: 0, bytes: 0, models: 0, textures: 0, audio: 0, ui: 0 };
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith('/')) continue;
      const target = classify(entry.filename);
      if (!target) continue;

      const dest = path.join(rawDir, target.out);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      const read = await entry.openReadStream();
      await pipeline(read, createWriteStream(dest));

      stats.files++;
      stats.bytes += entry.uncompressedSize;
      if (target.kind === "model") stats.models++;
      else if (target.kind === "texture") stats.textures++;
      else if (target.kind === 'audio') stats.audio++;
      else if (target.kind === 'ui') stats.ui++;
    }
  } finally {
    await zip.close();
  }

  await fs.writeFile(marker, JSON.stringify(stats, null, 2), 'utf8');
  return stats;
}
