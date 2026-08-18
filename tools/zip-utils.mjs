import { open } from 'yauzl-promise';
import os from 'node:os';
import path from 'node:path';

export const ZIP_PATH = path.join(
  os.homedir(),
  'Downloads',
  'Kenney Game Assets All-in-1 3.6.0.zip',
);

/** Reads every entry's metadata without inflating any of the file bodies. */
export async function listEntries(zipPath = ZIP_PATH) {
  const zip = await open(zipPath);
  const entries = [];
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith('/')) continue;
      entries.push({
        name: entry.filename,
        size: entry.uncompressedSize,
        ext: path.extname(entry.filename).toLowerCase(),
      });
    }
  } finally {
    await zip.close();
  }
  return entries;
}

/** Splits "3D assets/Car Kit/Models/GLB format/sedan.glb" into its parts. */
export function parseEntry(name) {
  const parts = name.split('/');
  return { category: parts[0] ?? '', pack: parts[1] ?? '', rest: parts.slice(2).join('/') };
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}
