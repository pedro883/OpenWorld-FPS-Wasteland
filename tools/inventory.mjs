#!/usr/bin/env node
/**
 * Generates ASSETS_INVENTORY.md straight from the Kenney zip. The full
 * inventory is produced without extracting anything — only the packs marked
 * with a checkmark are ever written to disk (by build-assets.mjs).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEntries, parseEntry, humanSize, ZIP_PATH } from './zip-utils.mjs';
import {
  SELECTED_3D,
  SELECTED_AUDIO,
  SELECTED_OTHER,
  REJECTION_NOTES,
} from './asset-selection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_EXTS = new Set(['.glb', '.gltf', '.obj', '.fbx', '.dae', '.stl', '.blend']);

function groupPacks(entries) {
  const packs = new Map();
  for (const entry of entries) {
    const { category, pack } = parseEntry(entry.name);
    if (!pack) continue;
    const key = `${category}/${pack}`;
    let rec = packs.get(key);
    if (!rec) {
      rec = { category, pack, key, bytes: 0, files: 0, exts: new Map(), glb: 0 };
      packs.set(key, rec);
    }
    rec.bytes += entry.size;
    rec.files++;
    rec.exts.set(entry.ext, (rec.exts.get(entry.ext) ?? 0) + 1);
    if (entry.ext === '.glb') rec.glb++;
  }
  return packs;
}

function formatsOf(rec) {
  const formats = [...rec.exts.entries()]
    .filter(([ext]) => MODEL_EXTS.has(ext))
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${ext} ${n}`);
  return formats.length ? formats.join(', ') : '—';
}

function statusOf(rec) {
  if (rec.category === '3D assets' && SELECTED_3D[rec.pack]) {
    return { mark: '✅', note: SELECTED_3D[rec.pack].why };
  }
  if (rec.category === 'Audio' && SELECTED_AUDIO[rec.pack]) {
    return { mark: '✅', note: SELECTED_AUDIO[rec.pack] };
  }
  if (SELECTED_OTHER[rec.key]) return { mark: '✅', note: SELECTED_OTHER[rec.key] };
  if (REJECTION_NOTES[rec.pack]) return { mark: '⛔', note: REJECTION_NOTES[rec.pack] };
  if (rec.category === '2D assets') {
    return { mark: '⛔', note: 'Arte 2D de outro gênero; o jogo é 3D em primeira pessoa.' };
  }
  if (rec.category === 'Archive') {
    return { mark: '⛔', note: 'Versão legada, superada por um kit atual.' };
  }
  if (rec.category === 'Early access') {
    return { mark: '⛔', note: 'Conteúdo instável de acesso antecipado.' };
  }
  if (rec.category === 'Goodies') {
    return { mark: '⛔', note: 'Brindes (wallpaper/PDF), sem uso no jogo.' };
  }
  if (rec.category === 'Audio') {
    return { mark: '⛔', note: 'Tema sonoro fora do tom militar/pós-apocalíptico.' };
  }
  if (rec.category === '3D assets') {
    return { mark: '⛔', note: 'Tema fora do cenário pós-apocalíptico terrestre.' };
  }
  return { mark: '⛔', note: 'Não usado nas fases 0–5.' };
}

function section(title, records, opts = {}) {
  const lines = [`### ${title}`, ''];
  lines.push(
    opts.models
      ? '| | Subpacote | Modelos (glb) | Formatos | Tamanho | Decisão |'
      : '| | Subpacote | Arquivos | Tamanho | Decisão |',
  );
  lines.push(opts.models ? '|---|---|---|---|---|---|' : '|---|---|---|---|---|');
  for (const rec of records) {
    const { mark, note } = statusOf(rec);
    lines.push(
      opts.models
        ? `| ${mark} | ${rec.pack} | ${rec.glb} | ${formatsOf(rec)} | ${humanSize(rec.bytes)} | ${note} |`
        : `| ${mark} | ${rec.pack} | ${rec.files} | ${humanSize(rec.bytes)} | ${note} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

const SUBSTITUTIONS = [
  '| Pedido no prompt | Usado no projeto | Motivo |',
  '|---|---|---|',
  '| *Vehicle Pack* | **Car Kit** + **Racing Kit** | Não existe subpacote com esse nome no 3.6.0. |',
  '| *Fence Kit* | **Survival Kit** (fence*.glb) + **Tower Defense Kit** | Não existe subpacote de cercas isolado. |',
  '| *Tools* | **Survival Kit** + **Food Kit** | Ferramentas e consumíveis vivem dentro desses kits. |',
  '| *Roads/Race Track* | **Road Pack** + **City Kit - Roads** | Nomes reais dos kits de via. |',
  '| *Kenney Fonts* | **Other/Fonts** | As fontes ficam na raiz Other/, fora de 2D assets. |',
  '| *Animated Characters* para o jogador | **Animated Characters Bundle** | É o pack pedido. Só vem em FBX, então `tools/build-characters.mjs` converte para GLB com o FBXLoader do próprio three — sem Blender. |',
  '| Conversão de áudio para .ogg via ffmpeg | cópia direta | Todo o áudio Kenney **já é .ogg**; converter seria reencodificar com perda, sem ganho. |',
];

async function main() {
  console.log(`Lendo ${ZIP_PATH} ...`);
  const entries = await listEntries();
  const packs = groupPacks(entries);
  const all = [...packs.values()].sort((a, b) => a.pack.localeCompare(b.pack, 'pt-BR'));

  const byCategory = (name) => all.filter((r) => r.category === name);
  const selected = all.filter((r) => statusOf(r).mark === '✅');
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  const selectedBytes = selected.reduce((sum, r) => sum + r.bytes, 0);

  const out = [];
  out.push('# Inventário de assets — Kenney Game Assets All-in-1 3.6.0');
  out.push('');
  out.push(
    'Gerado por `npm run assets:inventory`, lendo o zip diretamente — **nada é extraído para gerar este arquivo**. ' +
      'A extração para `_assets_raw/` é seletiva e cobre apenas os subpacotes marcados com ✅ (ver `PROGRESS.md`).',
  );
  out.push('');
  out.push(`- Origem: \`${ZIP_PATH}\``);
  out.push(`- Arquivos no pacote: **${entries.length.toLocaleString('pt-BR')}**`);
  out.push(`- Tamanho descompactado: **${humanSize(totalBytes)}**`);
  out.push(`- Subpacotes: **${all.length}** — usados: **${selected.length}** (${humanSize(selectedBytes)} crus)`);
  out.push('- Licença: **CC0 1.0 Universal** (uso comercial e modificação livres). Ver `CREDITS.md`.');
  out.push('');
  out.push('## 3D/');
  out.push('');
  out.push(section('3D assets', byCategory('3D assets'), { models: true }));
  out.push('## Audio/');
  out.push('');
  out.push(section('Audio', byCategory('Audio')));
  out.push('## UI/');
  out.push('');
  out.push(section('UI assets', byCategory('UI assets')));
  out.push(section('Icons', byCategory('Icons')));
  out.push('## Fonts/');
  out.push('');
  out.push(section('Other (inclui Other/Fonts)', byCategory('Other')));
  out.push('## 2D/');
  out.push('');
  out.push(section('2D assets', byCategory('2D assets')));
  out.push('## Categorias descartadas por inteiro');
  out.push('');
  out.push(section('Archive', byCategory('Archive')));
  out.push(section('Early access', byCategory('Early access')));
  out.push(section('Goodies', byCategory('Goodies')));
  out.push('## Substituições em relação ao prompt original');
  out.push('');
  out.push(SUBSTITUTIONS.join('\n'));
  out.push('');

  await fs.writeFile(path.join(ROOT, 'ASSETS_INVENTORY.md'), out.join('\n'), 'utf8');
  console.log(
    `ASSETS_INVENTORY.md gerado: ${all.length} subpacotes, ${selected.length} selecionados.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
