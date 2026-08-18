# Progresso

Escopo desta execução: **fases 0 a 5**. As fases 6–9 (veículos, missões/economia,
arsenal completo e multiplayer) ficam para depois; os módulos correspondentes existem
como stub visível, nunca como TODO silencioso.

| Fase | Estado |
|---|---|
| 0. Setup | ✅ concluída |
| 1. Pipeline de assets | ⏳ em andamento |
| 2. Jogador | ⬜ |
| 3. Combate base | ⬜ |
| 4. Mundo | ⬜ |
| 5. IA | ⬜ |
| 6–9 | fora do escopo desta execução |

---

## Fase 0 — Setup ✅

**Entregue**

- Projeto Vite + TypeScript **strict** (`noUncheckedIndexedAccess`, `noImplicitOverride`),
  isolado em `D:\WastelandWeb` com git próprio.
- `core/loop.ts` — timestep fixo de 60 Hz com acumulador, `alpha` de interpolação,
  clamp de 5 passos por frame e descarte do resto para não entrar em espiral de morte.
  Um dt maior que 250 ms (aba em segundo plano) é cortado antes do acumulador.
- `core/profiler.ts` — orçamento por subsistema com média exponencial
  (render ≤ 8 ms, física ≤ 3 ms, IA ≤ 2 ms, mundo ≤ 2 ms, resto ≤ 3 ms).
- `core/events.ts` (pub/sub tipado), `core/pool.ts` (pool de capacidade fixa que
  devolve `null` quando esgota, em vez de alocar).
- `core/input.ts` — teclado/mouse com Pointer Lock, estado de borda
  (`pressed`/`released`) e limpeza no `blur`.
- `render/renderer.ts` — cena, câmera, sol direcional com sombra PCF, luz hemisférica,
  ACES tone mapping, névoa exponencial.
- `physics/world.ts` + `physics/layers.ts` — wrapper do Rapier, camadas de colisão
  empacotadas no u32 do Rapier, raycast com normal e resolução de dono do colisor,
  helper de linha de visão para a IA.
- `debug/overlay.ts` — painel único (`F1`) com FPS, orçamento por subsistema,
  draw calls, triângulos, heap, seções e toggles registráveis por cada sistema.
- `scenes/` — roteador por `?scene=`, com a cena `sandbox` de aceite.
- `tools/inventory.mjs` + `tools/zip-utils.mjs` + `tools/asset-selection.mjs` —
  gera `ASSETS_INVENTORY.md` lendo o zip **sem extrair nada**.

**Aceite verificado**

`npm run dev` renderiza chão, rampa e 8 caixas dinâmicas caindo e assentando, com
sombras corretas e o overlay ativo: **180 FPS**, render 0,11 ms, física 0,03 ms,
18 draw calls, 216 triângulos, sem erro no console.
`ASSETS_INVENTORY.md` lista **269 subpacotes** (88.346 arquivos, 975 MB descompactados),
31 marcados com ✅.

**Defeitos encontrados e corrigidos durante a fase**

- A direção do sol derivava a cada frame: `followShadowTarget` renormalizava a própria
  posição do sol, então mover o alvo girava a luz. A direção agora é um vetor próprio
  (`sunDirection`) e a posição é derivada dela, não o contrário.
- A freecam integrava com `1/60` fixo em vez do dt real do frame.

**Desvios da especificação**

1. **`tools/build-assets.mjs` não usa ffmpeg.** Todo o áudio do pacote Kenney já é
   `.ogg`; converter seria reencodificar com perda, sem ganho. A normalização a
   −16 LUFS fica pendente e depende de instalar ffmpeg.
2. **Extração seletiva.** O zip tem 88 mil arquivos; extrair tudo custa tempo e disco
   sem benefício. O inventário completo exigido pela seção 2.1 é gerado lendo o zip
   direto, e só os subpacotes ✅ vão para `_assets_raw/`.
3. **Personagens.** Os packs `Animated Characters *` só trazem `.fbx`/`.blend`. O
   `Mini Characters` já vem em GLB com rig e 32 animações nomeadas, um set maior que
   o dos packs animados — é ele que o jogo usa.
