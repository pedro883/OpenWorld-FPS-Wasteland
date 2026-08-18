# Progresso

Escopo desta execução: **fases 0 a 5**. As fases 6–9 (veículos, missões/economia,
arsenal completo e multiplayer) ficam para depois; os módulos correspondentes existem
como stub visível, nunca como TODO silencioso.

| Fase | Estado |
|---|---|
| 0. Setup | ✅ concluída |
| 1. Pipeline de assets | ✅ concluída |
| 2. Jogador | ✅ concluída |
| 3. Combate base | ⏳ em andamento |
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

---

## Fase 1 — Pipeline de assets ✅

**Entregue**

- `tools/extract.mjs` — extração seletiva do zip: só o `.glb` de cada kit ✅, mais
  áudio, texturas, fontes e sprites de UI. 4.047 arquivos (65,8 MB) em vez dos 88.346
  do pacote. É incremental: reexecuções pulam a extração salvo com `--force`.
- `tools/build-assets.mjs` — mescla os modelos **por categoria** em seis GLBs
  (`characters, weapons, vehicles, props_nature, props_city, props_loot`), cada modelo
  virando um nó nomeado. Cadeia: `dedup → weld → unpartition → resample → prune →
  textureCompress(WebP, teto 1024) → reorder → quantize → EXTMeshoptCompression`.
- `config/asset-scales.json` — fator por kit para converter as unidades nativas em
  metros, aplicado na instanciação. Ajustável sem rebuild.
- `src/core/assets.ts` — carrega o manifest, busca as categorias sob demanda, cacheia,
  clona com `SkeletonUtils` quando o modelo é skinned, resolve clipes de animação e
  expõe bbox/triângulos/escala por id.
- `src/scenes/smoke.ts` — cena de aceite com um modelo de cada categoria, grade de 1 m,
  referência humana de 1,80 m e ciclador de animações (`N`).

**Resultado medido**

| | |
|---|---|
| Modelos mesclados | **2.107** em 6 arquivos |
| Geometria | 45,6 MB → **11,1 MB** (−76%) |
| Materiais após o merge | 1 (characters), 12 (weapons), 14 (vehicles), 19–21 (props) |
| **Payload inicial** | **2,2 MB** (characters + weapons + props_nature) — orçamento era 25 MB |
| Sob demanda | 8,9 MB de modelos + 18,0 MB de áudio |
| Total em `public/assets` | 30,0 MB — orçamento de streaming era 150 MB |
| Bundle de código (gzip) | 1,25 MB, dos quais 1,08 MB é o WASM do Rapier |

**Decisões de arquitetura tomadas aqui**

- **Carregamento por categoria, sob demanda.** `props_city` sozinho tem 1.107 modelos e
  6 MB; exigi-lo no boot desperdiçaria a maior parte do download. Só
  `characters`, `weapons` e `props_nature` são marcados `preload`.
- **Escala por kit, não global.** Os kits Kenney não compartilham escala: o Building Kit
  já é métrico (porta de 2,10 m), o Road Pack usa tiles de 1×1 unidade, o Mini
  Characters tem 0,67 unidade de altura e o sedã do Car Kit, 2,55. Cada kit tem seu
  fator em `config/asset-scales.json`, conferido a olho na cena `smoke`.
- **Building Kit e City Kit convivem com propósitos diferentes:** o primeiro é métrico e
  serve para interiores percorríveis; o segundo é volume de fundo (casa de 6,8 m).

**Defeitos encontrados e corrigidos durante a fase**

- Os GLBs da Kenney referenciam `Textures/colormap.png` por **URI relativa**, não
  embutida. A extração inicial trazia só os `.glb` e o build quebrava; passou a extrair
  também as texturas, preservando o caminho relativo.
- O three.js remove `[ ] . : /` dos nomes de nó ao carregar glTF
  (`PropertyBinding.sanitizeNodeName`), então o id `kit/modelo` virava `kitmodelo` e a
  busca falhava. O GLB agora usa `kit__modelo`; o manifest guarda o id legível como
  chave e o nome sanitizado em `node`.
- A API de merge do glTF-Transform v4 é `mergeDocuments(target, source)`, não
  `document.merge()`. O retorno mapeia propriedade-origem → propriedade-destino, o que
  passou a ser usado para identificar com precisão a cena e os clipes de cada arquivo.
- GLB aceita no máximo um buffer; cada arquivo mesclado trazia o seu. Resolvido com
  `unpartition()`.
- O sedã a ×1,73 ficava com 2,2 m de altura ao lado de um humano de 1,80 m. O Car Kit é
  proporcionalmente atarracado, então casar o comprimento real exagera altura e largura;
  o fator caiu para ×1,35 (2,0 × 1,8 × 3,4 m), que lê melhor em jogo.

**Desvio confirmado**

O áudio é copiado como está. Todos os 580 arquivos já são `.ogg`; a conversão pedida na
seção 2.3 seria reencodificação com perda. A normalização a −16 LUFS continua pendente e
depende de instalar ffmpeg.

---

## Fase 2 — Jogador ✅

**Entregue**

- `physics/characterController.ts` — cápsula cinemática sobre o
  `KinematicCharacterController` do Rapier. Trabalha em posição de **pés**, não do
  centro da cápsula, porque toda regra de jogo (altura dos olhos, postura, snap ao
  chão) é sobre os pés. Autostep de 0,45 m faz as vezes de mantle; troca de postura
  usa `setHalfHeight`, mantendo o handle do colisor estável.
- `entities/player.ts` — aceleração/atrito separados em solo e ar, três posturas,
  sprint com stamina, pulo, e interpolação da câmera entre os dois últimos estados
  fixos. A leitura de teclado sai num struct de intenção (`PlayerInput`), para que os
  bots da fase de simulação usem exatamente o mesmo código de movimento.
- `entities/health.ts` — vida por zona (cabeça, torso, 2 braços, 2 pernas) com
  multiplicador por zona, sangramento com chance proporcional à severidade, bandagem e
  os efeitos de membro ferido (perna = lento, braço = sway).
- `render/viewmodel.ts` + **passada de render própria** — o viewmodel foi para uma
  cena/câmera separadas com FOV de 65° (45° na mira). Com o FOV de 75° do mundo, uma
  arma a 70 cm da lente ocupa metade da tela; a passada separada resolve isso e ainda
  a isola da névoa, das sombras e do far plane.
- `ui/hud.ts` — HUD em DOM+CSS: silhueta com as seis zonas coloridas por vida,
  barra de stamina, postura, aviso de sangramento, retículo que abre com a dispersão e
  vinheta que escurece conforme as zonas letais caem.
- `scenes/playerTest.ts` — circuito de obstáculos que *afirma* o comportamento:
  rampas de 15/25/35/45/55° e degraus de 0,20/0,35/0,45/0,55/0,70 m, escolhidos em
  torno dos limites configurados (50° de inclinação, 0,45 m de autostep).
- `tests/health.test.ts` — 17 testes do modelo de dano, com `Math.random` fixado para
  tornar o sangramento determinístico.

**Aceite verificado** (dirigindo o jogador por eventos de teclado reais)

| Obstáculo | Esperado | Medido |
|---|---|---|
| Degraus 0,20 / 0,35 / 0,45 m | sobe (≤ autostep) | sobe até 0,82 / 1,07 / 1,18 m |
| Degraus 0,55 / 0,70 m | recusa (> autostep) | para em z=12, y=0,02 |
| Rampas 15 / 25 / 35 / 45° | sobe (≤ 50°) | sobe |
| Rampa 55° | recusa (> 50°) | não sai do chão |
| Vão de 1,05 m | só deitado | bloqueado em pé, passa deitado |
| Levantar sob o vão | recusado | continua deitado |
| Andar / correr | 3,6 / 6,4 m/s | bate com a config |
| Pulo | sobe e pousa, custa 8 de stamina | 0,64 m, stamina 100→92 |
| Sangramento | 1,6 HP/s no torso | exatamente 8,0 HP em 5 s |
| Bandagem | estanca | estanca e recupera a pior zona |

Desempenho no circuito: **180 FPS**, render 0,53 ms, física 0,47 ms, 6 draw calls.

**Defeitos encontrados e corrigidos durante a fase**

- **Bordas de input eram perdidas.** `input.endFrame()` limpava `pressed()` no fim de
  cada frame de render. Como o render roda a ~180 FPS e a simulação a 60 Hz, 2 de cada
  3 frames não executam nenhum passo fixo — a tecla era limpa antes de qualquer passo
  fixo lê-la. Pulo, agachar, deitar e recarregar simplesmente não respondiam. O input
  passou a ter dois consumos: `endFixedStep()` para bordas de tecla/botão e
  `endFrame()` para os deltas de mouse.
- **Realimentação que matava o autostep.** O jogador travava num degrau de 20 cm. A
  causa não era o Rapier: ao colidir, o código amortecia a própria velocidade (e, numa
  segunda tentativa, a sobrescrevia com o movimento resolvido). Nos dois casos a
  velocidade colapsava, o passo seguinte pedia um deslocamento micrométrico e o
  autostep nunca recebia movimento horizontal suficiente para erguer a cápsula. O
  controlador cinemático agora mantém a própria velocidade e deixa o solver só limitar
  o deslocamento.
- **Circuito de testes com dois erros de montagem**, que mascaravam o comportamento
  real: as rampas estavam giradas em Z (subiam no eixo X, perpendicular ao caminho do
  jogador) e a escadaria tinha o degrau mais alto de frente para o jogador, virando um
  muro. Além disso, centrar a laje da rampa deixava um ressalto de ~0,5 m na ponta —
  acima do autostep — e a rampa falhava por um motivo que nada tinha a ver com
  inclinação. As rampas agora nascem rentes ao chão.
- O jogador nascia **dentro** da escadaria.
- Ordem do sol: `followShadowTarget` renormalizava a própria posição do sol, girando a
  luz a cada frame (corrigido ainda na fase 0, mas só visível aqui).

**Desvio da especificação**

A seção 4.4 pede **braços em primeira pessoa**. Os personagens Kenney são uma única
malha skinned — não há como isolar os braços — e não existe pack de braços FPS no
acervo. O viewmodel é, portanto, só a arma, com sway, bob, ADS e recuo procedurais.
As alternativas seriam modelar braços do zero (fora do escopo CC0 do projeto) ou
renderizar o corpo inteiro em primeira pessoa, o que fica esquisito num personagem
tão estilizado.
