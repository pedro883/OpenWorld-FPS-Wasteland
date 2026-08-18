/**
 * Zips `dist/` into `release/wasteland-web.zip`, ready to extract into the
 * document root of any static host.
 *
 * The zip holds the *contents* of `dist/`, not the folder itself: extracting it
 * inside `public_html` has to leave `index.html` at the top level, and a wrapper
 * folder is the most common way that goes wrong.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const DIST = 'dist';
const OUT_DIR = 'release';
const OUT = path.join(OUT_DIR, 'wasteland-web.zip');

/** Formats already compressed; deflating them again costs time for nothing. */
const STORE_ONLY = new Set(['.ogg', '.webp', '.png', '.glb', '.jpg', '.jpeg']);

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push({ full, rel });
  }
  return out;
}

// ---- Minimal zip writer ----------------------------------------------------
// A dependency-free writer keeps the release step from needing anything that is
// not already in the project.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day =
    (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

async function main() {
  try {
    await fs.access(DIST);
  } catch {
    console.error('dist/ não existe. Rode `npm run build` primeiro.');
    process.exitCode = 1;
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const files = (await walk(DIST)).sort((a, b) => a.rel.localeCompare(b.rel));
  const stream = createWriteStream(OUT);
  const central = [];
  let offset = 0;
  const { time, day } = dosTime(new Date());

  const write = (buffer) =>
    new Promise((resolve) => {
      if (stream.write(buffer)) resolve();
      else stream.once('drain', resolve);
    });

  let rawTotal = 0;
  for (const file of files) {
    const data = await fs.readFile(file.full);
    rawTotal += data.length;
    const ext = path.extname(file.rel).toLowerCase();
    const store = STORE_ONLY.has(ext);
    const body = store ? data : deflateRawSync(data, { level: 9 });
    const method = store ? 0 : 8;
    const name = Buffer.from(file.rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    await write(Buffer.concat([local, name, body]));

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));
    offset += 30 + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  await write(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(end);
  await new Promise((resolve) => stream.end(resolve));

  const zipped = (await fs.stat(OUT)).size;
  console.log(`${OUT}`);
  console.log(
    `  ${files.length} arquivos · ${(rawTotal / 1024 / 1024).toFixed(1)} MB -> ${(zipped / 1024 / 1024).toFixed(1)} MB`,
  );
  console.log('  Extraia o conteúdo direto em public_html/. Veja DEPLOY.md.');
}

await main();
