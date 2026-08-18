/**
 * Converts Kenney's Animated Characters Bundle from FBX to GLB, with no Blender
 * and no native converter in the loop.
 *
 * The bundle is the only Kenney character pack with a proper humanoid rig —
 * spine, shoulders, forearms, hands and toes, 46 deform bones against the 7
 * nodes of Mini Characters — and the only one with `crouchIdle`, `crouchWalk`
 * and `shoot` as separate clips. That is what lets an NPC crouch with its legs
 * while its arms keep holding a rifle. It only ships `.fbx` and `.blend`, so
 * this step parses the FBX with three's own loader and re-emits GLB with its
 * exporter; `build-assets.mjs` then treats the result as any other Kenney kit.
 *
 * Run through `npm run assets:build`, which chains this first.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as THREE from 'three';
import sharp from 'sharp';
import { open } from 'yauzl-promise';
import { ZIP_PATH } from './zip-utils.mjs';

const PACK = '3D assets/Animated Characters Bundle';
const RAW = path.join('_assets_raw', '3D', 'Animated Characters Bundle');
const FBX_DIR = path.join('_assets_raw', '_fbx', 'AnimatedCharacters');
const SKIN_OUT = path.join('public', 'assets', 'skins');

/** Body meshes. All four share one skeleton, so they share one clip set. */
const BODIES = {
  'character-medium': 'Models/characterMedium.fbx',
  'character-large-male': 'Models/characterLargeMale.fbx',
  'character-large-female': 'Models/characterLargeFemale.fbx',
  'character-small': 'Models/characterSmall.fbx',
};

/**
 * The clips ride on this body alone. Emitting all sixteen onto each of the four
 * would quadruple the animation data for nothing, since they bind by bone name;
 * the manifest points the other bodies here through their `rig` field.
 */
const RIG_OWNER = 'character-medium';

/** Kenney's file names on the right, the names the game asks for on the left. */
const CLIPS = {
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  crouch: 'crouch',
  'crouch-idle': 'crouchIdle',
  'crouch-walk': 'crouchWalk',
  shoot: 'shoot',
  attack: 'attack',
  punch: 'punch',
  kick: 'kick',
  die: 'death',
  jump: 'jump',
  'interact-ground': 'interactGround',
  'interact-standing': 'interactStanding',
  drive: 'racingIdle',
  'drive-left': 'racingLeft',
  'drive-right': 'racingRight',
};

/** Wasteland-appropriate skins; the mesh is shared and the map swaps at runtime. */
const SKINS = [
  'militaryMaleA',
  'militaryMaleB',
  'militaryFemaleA',
  'militaryFemaleB',
  'survivorMaleA',
  'survivorMaleB',
  'survivorFemaleA',
  'survivorFemaleB',
  'criminalMaleA',
  'criminalMaleB',
  'zombieA',
  'zombieB',
  'zombieC',
];

// ---- FBX parsing needs a couple of browser globals -------------------------

globalThis.self = globalThis;
if (!globalThis.FileReader) {
  // GLTFExporter reads its own output Blob back through FileReader, which Node
  // has no need for: Blob.arrayBuffer() does the same job.
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }
  };
}
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');

// ---- Extraction ------------------------------------------------------------

/** Pulls just the bundle files we use out of the 90k-entry archive. */
async function extract() {
  const wanted = new Map();
  for (const rel of Object.values(BODIES)) wanted.set(`${PACK}/${rel}`, path.basename(rel));
  for (const file of Object.values(CLIPS)) {
    wanted.set(`${PACK}/Animations/${file}.fbx`, `${file}.fbx`);
  }
  for (const skin of SKINS) wanted.set(`${PACK}/Skins/${skin}.png`, `${skin}.png`);

  await fs.mkdir(FBX_DIR, { recursive: true });
  const zip = await open(ZIP_PATH);
  let written = 0;
  try {
    for await (const entry of zip) {
      const out = wanted.get(entry.filename);
      if (!out) continue;
      const stream = await entry.openReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      await fs.writeFile(path.join(FBX_DIR, out), Buffer.concat(chunks));
      written++;
    }
  } finally {
    await zip.close();
  }
  const missing = [...wanted.values()].length - written;
  if (missing > 0) console.warn(`  aviso: ${missing} arquivo(s) do bundle não encontrados no zip`);
  return written;
}

// ---- Conversion ------------------------------------------------------------

const loader = new FBXLoader();

async function parseFbx(file) {
  const buf = await fs.readFile(path.join(FBX_DIR, file));
  return loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
}

/**
 * Collapses tracks that never change into a single keyframe.
 *
 * A humanoid clip carries position, rotation and scale for all 58 bones, but in
 * a given clip most of them hold still — scale always does. Dropping those
 * tracks outright would be wrong: a track that holds a bone at a constant angle
 * still has to *set* that angle, and without it the bone snaps back to the bind
 * pose, arms out. Keeping one keyframe preserves the pose and throws away the
 * repetition, which is where nearly all the bytes are.
 */
function collapseConstantTracks(clip) {
  let framesBefore = 0;
  let framesAfter = 0;
  for (const track of clip.tracks) {
    const stride = track.getValueSize();
    const count = track.times.length;
    framesBefore += count;
    let constant = true;
    for (let i = 1; i < count && constant; i++) {
      for (let c = 0; c < stride; c++) {
        if (Math.abs(track.values[i * stride + c] - track.values[c]) > 1e-4) {
          constant = false;
          break;
        }
      }
    }
    if (constant && count > 1) {
      track.times = new track.times.constructor([0]);
      track.values = new track.values.constructor(track.values.slice(0, stride));
    }
    framesAfter += track.times.length;
  }
  return { framesBefore, framesAfter };
}

/** Strips the FBX materials down to something the exporter can write without a canvas. */
function neutralMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const replaced = mats.map(
      (m) =>
        new THREE.MeshStandardMaterial({
          name: m?.name || 'character',
          color: 0xffffff,
          roughness: 0.85,
          metalness: 0,
        }),
    );
    obj.material = replaced.length === 1 ? replaced[0] : replaced;
  });
}

async function loadClips() {
  const clips = [];
  let before = 0;
  let after = 0;
  for (const [name, file] of Object.entries(CLIPS)) {
    const group = await parseFbx(`${file}.fbx`);
    // Every animation file also carries a one-frame "Targeting Pose" take.
    const clip = group.animations.find((a) => !/targeting/i.test(a.name));
    if (!clip) {
      console.warn(`  aviso: ${file}.fbx não trouxe clip utilizável`);
      continue;
    }
    clip.name = name;
    const stats = collapseConstantTracks(clip);
    before += stats.framesBefore;
    after += stats.framesAfter;
    clips.push(clip);
  }
  console.log(`  ${clips.length} clips, keyframes ${before} -> ${after}`);
  return clips;
}

async function exportBody(id, fbxFile, clips) {
  const group = await parseFbx(path.basename(fbxFile));
  neutralMaterials(group);
  group.name = id;

  const exporter = new GLTFExporter();
  const glb = await new Promise((resolve, reject) => {
    exporter.parse(group, resolve, reject, { binary: true, animations: clips });
  });
  const out = path.join(RAW, `${id}.glb`);
  await fs.writeFile(out, Buffer.from(glb));

  const box = new THREE.Box3().setFromObject(group);
  let triangles = 0;
  group.traverse((o) => {
    if (o.isMesh) triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
  });
  console.log(
    `  ${id}.glb  ${(glb.byteLength / 1024).toFixed(0)} KB  ${triangles.toFixed(0)} tri  ` +
      `altura ${box.max.y.toFixed(1)}u  clips ${clips.length}`,
  );
  return box;
}

/** Skins stay outside the GLB: one mesh, many looks, swapped at runtime. */
async function exportSkins() {
  await fs.mkdir(SKIN_OUT, { recursive: true });
  const map = {};
  for (const skin of SKINS) {
    const src = path.join(FBX_DIR, `${skin}.png`);
    try {
      await fs.access(src);
    } catch {
      continue;
    }
    const file = `${skin}.webp`;
    await sharp(src).webp({ quality: 90 }).toFile(path.join(SKIN_OUT, file));
    map[skin] = `assets/skins/${file}`;
  }
  await fs.writeFile(path.join(SKIN_OUT, 'index.json'), JSON.stringify(map, null, 2));
  console.log(`  ${Object.keys(map).length} skins -> ${SKIN_OUT}`);
  return map;
}

// ---- Entry point -----------------------------------------------------------

async function main() {
  console.log('Animated Characters Bundle: FBX -> GLB');
  await fs.mkdir(RAW, { recursive: true });

  const extracted = await extract();
  console.log(`  ${extracted} arquivos extraídos do zip`);

  const clips = await loadClips();
  for (const [id, file] of Object.entries(BODIES)) {
    await exportBody(id, file, id === RIG_OWNER ? clips : []);
  }
  await exportSkins();

  await fs.writeFile(
    path.join(RAW, 'License.txt'),
    'Kenney Animated Characters Bundle — CC0 1.0 Universal. https://kenney.nl\n',
  );
  console.log('pronto: rode o merge com tools/build-assets.mjs');
}

await main();
