#!/usr/bin/env node
/**
 * Asset pipeline: Kenney zip -> merged, optimised GLBs + manifest.
 *
 * Models are merged per category rather than shipped one file per model. Every
 * Kenney kit already shares a single `colormap` material and texture, so the
 * merge collapses hundreds of files into one request with a handful of
 * materials, which is what actually costs frames (draw calls), not triangles.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  mergeDocuments,
  quantize,
  reorder,
  prune,
  resample,
  textureCompress,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import sharp from 'sharp';
import { MeshoptEncoder } from 'meshoptimizer';
import { SELECTED_3D, SELECTED_AUDIO, CATEGORIES } from './asset-selection.mjs';
import { humanSize } from './zip-utils.mjs';
import { extractSelected } from './extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, '_assets_raw');
const OUT = path.join(ROOT, 'public', 'assets');
const MAX_TEXTURE = 1024;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
});

/**
 * Categories fetched during boot. Everything else is pulled the first time the
 * world actually needs it, which keeps the initial download small even though
 * props_city alone holds 1100 models.
 */
const BOOT_CATEGORIES = new Set(['characters', 'weapons', 'props_nature']);

/**
 * three.js strips `[ ] . : /` from node names when loading a glTF, so the id
 * used inside the GLB replaces the slash. The manifest keeps the readable
 * `<kit>/<model>` form as the key and stores the sanitised name in `node`.
 */
export function nodeNameFor(id) {
  return id.replace(/\//g, '__');
}

/** Stable, collision-free id: `<kit-slug>/<model>`. */
function slug(pack) {
  return pack
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function listModels() {
  const byCategory = new Map(CATEGORIES.map((c) => [c, []]));
  for (const [pack, cfg] of Object.entries(SELECTED_3D)) {
    const dir = path.join(RAW, '3D', pack);
    let files;
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.glb'));
    } catch {
      console.warn(`  ! kit ausente em _assets_raw: ${pack}`);
      continue;
    }
    for (const file of files.sort()) {
      const base = path.basename(file, '.glb');
      byCategory.get(cfg.category).push({
        id: `${slug(pack)}/${base}`,
        pack,
        file: path.join(dir, file),
      });
    }
  }
  return byCategory;
}

/** World-space bounds of a node subtree, from accessor min/max. */
function nodeBounds(node) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (n, parentMatrix) => {
    const m = multiply(parentMatrix, trsMatrix(n));
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const lo = pos.getMin([0, 0, 0]);
        const hi = pos.getMax([0, 0, 0]);
        // Eight corners, so rotation in the node chain is accounted for.
        for (let i = 0; i < 8; i++) {
          const p = [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
          const w = transform(m, p);
          for (let a = 0; a < 3; a++) {
            if (w[a] < min[a]) min[a] = w[a];
            if (w[a] > max[a]) max[a] = w[a];
          }
        }
      }
    }
    for (const child of n.listChildren()) visit(child, m);
  };
  visit(node, identity());
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min: min.map(round3), max: max.map(round3) };
}

const round3 = (v) => Math.round(v * 1000) / 1000;
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function trsMatrix(node) {
  const [tx, ty, tz] = node.getTranslation();
  const [qx, qy, qz, qw] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function transform(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function countTriangles(node) {
  let tris = 0;
  const visit = (n) => {
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices();
        const pos = prim.getAttribute('POSITION');
        tris += Math.floor((idx ? idx.getCount() : (pos?.getCount() ?? 0)) / 3);
      }
    }
    for (const child of n.listChildren()) visit(child);
  };
  visit(node);
  return tris;
}

/**
 * Merges every model of a category into one document, each under a group node
 * named with its logical id. Animation names are namespaced the same way so a
 * character's "idle" cannot collide with another kit's.
 */
async function buildCategory(category, models) {
  const target = new Document();
  target.createBuffer();
  const scene = target.createScene(category);
  const entries = {};
  const animations = {};
  let rawBytes = 0;

  for (const model of models) {
    rawBytes += (await fs.stat(model.file)).size;
    const source = await io.read(model.file);

    // mergeDocuments returns source-property -> target-property, which is how
    // we know exactly which scene and clips this particular file contributed.
    const mapping = mergeDocuments(target, source);
    const srcRoot = source.getRoot();
    const srcScene = srcRoot.getDefaultScene() ?? srcRoot.listScenes()[0];

    const nodeName = nodeNameFor(model.id);
    const group = target.createNode(nodeName);
    const mergedScene = srcScene ? mapping.get(srcScene) : null;
    if (mergedScene) {
      for (const child of mergedScene.listChildren()) group.addChild(child);
      mergedScene.dispose();
    }
    // Any scene the source did not mark as default still came across.
    for (const other of srcRoot.listScenes()) {
      const mapped = mapping.get(other);
      if (!mapped || mapped === scene || mapped.isDisposed()) continue;
      for (const child of mapped.listChildren()) group.addChild(child);
      mapped.dispose();
    }
    scene.addChild(group);

    const names = [];
    for (const srcAnim of srcRoot.listAnimations()) {
      const anim = mapping.get(srcAnim);
      if (!anim) continue;
      const name = srcAnim.getName() || 'clip';
      anim.setName(`${nodeName}|${name}`);
      names.push(name);
    }
    if (names.length) animations[model.id] = names;

    // Bodies that share a skeleton also share one clip set: emitting all of it
    // per body would multiply the animation data for nothing, since clips bind
    // by bone name. The clip-less ones point at the body that carries them.
    const rig = SELECTED_3D[model.pack]?.rig;
    const borrowsRig = rig && !names.length ? `${slug(model.pack)}/${rig}` : null;

    entries[model.id] = {
      category,
      node: nodeName,
      pack: model.pack,
      bounds: nodeBounds(group),
      triangles: countTriangles(group),
      ...(names.length ? { animations: names } : {}),
      ...(borrowsRig && borrowsRig !== model.id ? { rig: borrowsRig } : {}),
    };
  }

  target.getRoot().setDefaultScene(scene);

  await target.transform(
    // Kits share one colormap texture and one material, so dedup collapses the
    // whole category down to a handful of GPU resources — and, for characters,
    // folds the 12 identical animation tracks into one set of accessors.
    dedup(),
    weld(),
    // Each merged source arrived with its own buffer; GLB allows only one.
    unpartition(),
    resample(),
    prune({ keepAttributes: false, keepLeaves: false }),
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [MAX_TEXTURE, MAX_TEXTURE],
      resizeFilter: 'lanczos3',
    }),
    // Meshopt: reorder for vertex-cache locality, quantize to smaller integer
    // attributes, then compress. Roughly halves the geometry payload.
    reorder({ encoder: MeshoptEncoder }),
    quantize(),
  );

  target
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });

  const bytes = await io.writeBinary(target);
  const outFile = path.join(OUT, `${category}.glb`);
  await fs.writeFile(outFile, bytes);

  return {
    file: `assets/${category}.glb`,
    bytes: bytes.byteLength,
    rawBytes,
    models: Object.keys(entries).length,
    materials: target.getRoot().listMaterials().length,
    textures: target.getRoot().listTextures().length,
    entries,
    animations,
  };
}

async function collectAudio() {
  const audio = {};
  let bytes = 0;
  for (const pack of Object.keys(SELECTED_AUDIO)) {
    const src = path.join(RAW, 'Audio', pack);
    let files;
    try {
      files = (await fs.readdir(src)).filter((f) => f.endsWith('.ogg'));
    } catch {
      continue;
    }
    const destDir = path.join(OUT, 'audio', slug(pack));
    await fs.mkdir(destDir, { recursive: true });
    for (const file of files) {
      // Already .ogg at source; re-encoding would only lose quality.
      const from = path.join(src, file);
      const to = path.join(destDir, file);
      await fs.copyFile(from, to);
      bytes += (await fs.stat(to)).size;
      audio[`${slug(pack)}/${path.basename(file, '.ogg')}`] =
        `assets/audio/${slug(pack)}/${file}`;
    }
  }
  return { audio, bytes };
}

/** Weapon sprites become hotbar icons, keyed by the model id they depict. */
async function collectIcons() {
  const src = path.join(RAW, 'UI', 'weapons');
  const destDir = path.join(OUT, 'icons', 'weapons');
  const icons = {};
  let bytes = 0;
  let files;
  try {
    files = (await fs.readdir(src)).filter((f) => f.endsWith('.png'));
  } catch {
    return { icons, bytes };
  }
  await fs.mkdir(destDir, { recursive: true });
  for (const file of files) {
    const base = path.basename(file, '.png');
    const out = `${base}.webp`;
    // The renders are small; WebP keeps the whole icon set well under 200 KB.
    await sharp(path.join(src, file))
      .resize(128, 128, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 88 })
      .toFile(path.join(destDir, out));
    bytes += (await fs.stat(path.join(destDir, out))).size;
    icons[`weapon-pack/${base}`] = `assets/icons/weapons/${out}`;
  }
  return { icons, bytes };
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(full) : (await fs.stat(full)).size;
  }
  return total;
}

async function main() {
  console.log('1/5  Extraindo os subpacotes selecionados do zip…');
  const extracted = await extractSelected(RAW, { force: process.argv.includes('--force') });
  console.log(
    `     ${extracted.files} arquivos (${humanSize(extracted.bytes)}): ` +
      `${extracted.models} modelos, ${extracted.audio} sons, ${extracted.ui} sprites`,
  );

  await fs.mkdir(OUT, { recursive: true });

  console.log('2/5  Mesclando e otimizando por categoria…');
  const models = await listModels();
  const manifest = {
    generatedAt: new Date().toISOString(),
    license: 'CC0-1.0 — Kenney (kenney.nl). Ver CREDITS.md.',
    categories: {},
    models: {},
    animations: {},
    audio: {},
    icons: {},
  };

  let totalRaw = 0;
  let totalOut = 0;
  let bootBytes = 0;
  for (const category of CATEGORIES) {
    const list = models.get(category) ?? [];
    if (!list.length) continue;
    const result = await buildCategory(category, list);
    manifest.categories[category] = {
      file: result.file,
      bytes: result.bytes,
      models: result.models,
      materials: result.materials,
      textures: result.textures,
      preload: BOOT_CATEGORIES.has(category),
    };
    Object.assign(manifest.models, result.entries);
    Object.assign(manifest.animations, result.animations);
    totalRaw += result.rawBytes;
    totalOut += result.bytes;
    if (BOOT_CATEGORIES.has(category)) bootBytes += result.bytes;
    const pct = ((1 - result.bytes / result.rawBytes) * 100).toFixed(0);
    console.log(
      `     ${category.padEnd(13)} ${String(result.models).padStart(4)} modelos  ` +
        `${humanSize(result.rawBytes).padStart(9)} -> ${humanSize(result.bytes).padStart(9)} (-${pct}%)  ` +
        `${result.materials} mat, ${result.textures} tex`,
    );
  }

  console.log('3/5  Copiando áudio (.ogg da origem, sem reencodificar)…');
  const { audio, bytes: audioBytes } = await collectAudio();
  manifest.audio = audio;
  console.log(`     ${Object.keys(audio).length} arquivos, ${humanSize(audioBytes)}`);

  console.log('4/5  Convertendo ícones de arma…');
  const { icons, bytes: iconBytes } = await collectIcons();
  manifest.icons = icons;
  console.log(`     ${Object.keys(icons).length} ícones, ${humanSize(iconBytes)}`);

  console.log('5/5  Escrevendo manifest…');
  await fs.writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  const total = await dirSize(OUT);
  const boot = [...BOOT_CATEGORIES].join(', ');
  console.log('');
  console.log(`Modelos:  ${humanSize(totalRaw)} -> ${humanSize(totalOut)}`);
  console.log(`Áudio:    ${humanSize(audioBytes)} (streamado sob demanda)`);
  console.log(`Total em public/assets: ${humanSize(total)}`);
  console.log(`Payload inicial (${boot}): ${humanSize(bootBytes)} ` +
      `${bootBytes < 25 * 1048576 ? 'OK, dentro dos 25 MB' : 'ACIMA dos 25 MB'}`);
  console.log(`Sob demanda: ${humanSize(totalOut - bootBytes)} de modelos + ${humanSize(audioBytes)} de áudio`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
