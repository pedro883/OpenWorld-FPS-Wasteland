# Progresso

Escopo desta execução: **fases 0 a 5**. As fases 6–9 (veículos, missões/economia,
arsenal completo e multiplayer) ficam para depois; os módulos correspondentes existem
como stub visível, nunca como TODO silencioso.

| Fase | Estado |
|---|---|
| 0. Setup | ✅ concluída |
| 1. Pipeline de assets | ✅ concluída |
| 2. Jogador | ✅ concluída |
| 3. Combate base | ✅ concluída |
| 3.5 Arsenal (adiantado da fase 8) | ✅ concluída |
| 4. Mundo | ✅ concluída |
| 5. IA | ⏳ em andamento |
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

---

## Fase 3 — Combate base ✅

**Entregue**

- `combat/ballistics.ts` — **projétil real, não hitscan**: velocidade finita, gravidade e
  arrasto quadrático (`a = -k·|v|·v`). Cada passo fixo é varrido como **segmento**, não
  como ponto: a 880 m/s a bala anda 14,6 m por tick, e sem isso atravessaria qualquer
  parede fina. O laço resolve vários impactos dentro do mesmo tick.
- **Penetração com espessura real**: ao acertar, um raio é lançado de dentro do colisor
  com `solid = false` para achar a saída; o custo é `espessura × dureza do material` e
  sai de um orçamento de energia do projétil. **Ricochete** em ângulo rasante contra
  material duro, com dispersão para não virar espelho perfeito.
- `combat/weapon.ts` — cadência, modos (auto/rajada/semi), dispersão por
  postura/mira/movimento/salto com bloom acumulado, **padrão de recuo determinístico**
  (curva por índice de tiro, portanto memorizável e contra-atacável) e duas recargas
  (tática mantém a bala na câmara, vazia não).
- `combat/impacts.ts` — traçantes, decals e faíscas, cada tipo num único
  `InstancedMesh` com ring buffer. Um tiroteio gera centenas por segundo; uma draw call
  por tipo é a diferença entre orçamento e engasgo.
- `entities/hitboxes.ts` — as seis zonas de dano como colisores-sensor numa **camada
  HITBOX própria**, agachando junto com a postura. `entities/targetDummy.ts` e o
  jogador usam o mesmo conjunto.
- HUD de munição com modo de tiro, barra de recarga e confirmação de acerto no retículo
  (marca distinta para cabeça).
- `tests/ballistics.test.ts` — 18 testes com um mundo-stub de lajes, cobrindo queda,
  tempo de voo, varredura contra parede fina, penetração e dano por zona.

**Aceite verificado**

| O que | Medido |
|---|---|
| Acerto no torso a 12 m | 100 → 74 HP (26 de dano, multiplicador 1,0) |
| Acerto na cabeça | 40 → 0 HP (26 × 2,6 = 67,6) |
| Queda a 100 m | **15,1 cm** (5,56 real: 10–20 cm) |
| Queda a 300 m | **1,33 m** (5,56 real: ~1,2–1,5 m) |
| Tempo de voo a 300 m | **0,367 s** (5,56 real: ~0,39 s) |
| Arrasto | bandas de 200 m levam 0,250 s → 0,250 s → 0,283 s |
| Madeira 12 cm | atravessa; alvo atrás leva 18 de dano (×0,7 de saída) |
| Metal 6 cm | atravessa; alvo atrás leva 14 (×0,55) |
| Saco de areia 35 cm | para |
| Concreto 30 cm | para |
| Ricochete em terra (limiar 12°) | quica a 3° e 8°; para a 20° e 45° |
| Desempenho | 180 FPS, render 0,52 ms, física 0,22 ms, 120 draws, 24,7k tri |

**Defeitos encontrados e corrigidos durante a fase**

- **A bala acertava o próprio atirador.** O cano nasce dentro da cápsula do jogador, e o
  raycast retornava o próprio colisor na distância 0 — todo tiro morria na saída. Duas
  correções: `ShotSpec.ignore` exclui o corpo de quem atirou, e as caixas de dano foram
  para uma **camada HITBOX separada**, de modo que a bala atravessa a cápsula grossa de
  movimento e resolve contra a zona precisa. Sem isso, todo acerto viraria "torso".
- **O painel de debug mentia.** Com duas passadas de render (mundo + viewmodel), o
  three zera `renderer.info` no início de cada `render()`, então o painel mostrava só os
  números do viewmodel: 6 draws e 486 triângulos, quando o real era 120 e 24.724. Agora
  `info.autoReset = false` e o reset é manual, uma vez por frame.
- Um teste de arrasto comparava `t(400) > 2·t(200)`, o que é frágil: a 60 Hz o tempo é
  quantizado em 16,7 ms e nessa faixa o efeito do arrasto é menor que um tick. Passou a
  medir bandas sucessivas de 200 m — a mesma afirmação física, sem a fragilidade.

**Nota de método**

O painel embutido do navegador estrangula o `requestAnimationFrame` enquanto um script
roda, o que fazia medições feitas com `await` parecerem "sem impacto algum". Os testes
de balística passaram a **avançar o sistema manualmente** (`ballistics.update(1/60)` em
laço), o que é determinístico e imune a isso.

---

## Fase 3.5 — Arsenal ✅ *(adiantada da fase 8, a pedido)*

A spec coloca o arsenal completo na fase 8. Foi puxado para cá porque a base de
combate estava fresca e a IA da fase 5 precisa de armas variadas de qualquer forma.

**Entregue**

- **19 armas** do Weapon Pack, com nomes fictícios (seção 9): pistolas PX-9 e PX-9
  Silenciada, SMG Víbora e Víbora-S, Carabina Falcão, Fuzil M4X / M4X-GL / Lince,
  Marcador Corvo, Precisão TR-8, Escopetas Brecha-12 e Curta, Metralhadora Touro,
  Lança-Foguetes RPX, Lança-Granadas 40 mm, Lança-Chamas Salamandra, granadas de
  fragmentação/fumaça/efeito moral e Faca Lâmina.
- `config/weapons.json` com **herança por classe**: cada arma declara só o que difere
  do seu `classDefaults`. Quinze blocos completos de dispersão e recuo repetidos
  seriam inmantíveis.
- `combat/arsenal.ts` — resolução das definições e **munição em pool por calibre**:
  duas armas 9 mm dividem a mesma reserva, o que dá peso à escolha do que carregar.
  Arremessáveis usam contagem discreta em vez de pool.
- **Tipos de disparo**: automático, rajada de 3, semi, ferrolho (TR-8, 1,15 s de
  cicloagem), bombeamento e **múltiplos bagos** (escopetas lançam 8–9 projéteis por
  tiro, cada um com seu próprio cone).
- **Explosivos**: foguetes detonam no contato, granadas **quicam** e detonam no
  estopim. `combat/explosions.ts` aplica dano em área com queda por
  `(1 − d/raio)^expoente` e **corta o dano a 25% quando não há linha de visão** — uma
  explosão que ignora paredes transforma todo foguete em morte garantida.
- `entities/loadout.ts` — troca de arma com **custo de tempo** (0,55 s): a arma atual
  coldreia, o modelo troca no fundo do mergulho e a nova sobe. Não se atira durante a
  troca. Teclas 1–9, roda do mouse e Q (arma anterior).
- **Hotbar** com os *sprites renderizados da própria Kenney* como ícones, indexados
  pelo mesmo id de modelo que o viewmodel 3D usa — os dois não podem divergir.
- **Animação de recarga e troca procedural**: as armas Kenney são malhas estáticas,
  sem osso de carregador e sem clipe de recarga, então não há o que reproduzir.
  Mergulhar a arma para fora do quadro e rolá-la para a mão de apoio lê como recarga
  nessa escala de arte, e não custa asset nenhum.

**Aceite verificado**

| O que | Medido |
|---|---|
| Troca de arma pela tecla | `4` → índice 3 (Carabina Falcão), 0,55 s |
| Escopeta | 8 bagos lançados, 5 acertos em 3 zonas distintas, alvo a 61% |
| Explosão a 1 / 4 / 7 m | 170 / 56 / 2 de dano — queda conforme configurada |
| Explosão atrás de concreto | 22 em vez de ~130 (checagem de cobertura) |
| Autodano | jogador a 2 m levou 100 na perna = 220 × (1−2/7,5)^1,8 × 0,8 ✔ |
| Foguete | voo de 0,23 s a 90 m/s, com queda visível |
| Ícones | 19/19 resolvidos (`sniperSand` sem sprite → cai para `sniper`) |

**Correção de mira (ADS)**

A pose de mira estava desalinhada. Em vez de calibrar 19 offsets à mão, ela passou a
ser **derivada do bounding box do modelo** no carregamento: a arma é centrada no eixo
óptico e o topo do receptor — a única coisa parecida com uma alça de mira nesses
modelos low-poly — vai para a altura do retículo. Isso se auto-corrige para qualquer
arma nova.

**Pendente desta frente**

Acessórios modulares (miras, supressores acopláveis, empunhaduras) do Blaster Kit,
fumaça e cegueira das granadas não-letais, e dano por queimadura contínua do
lança-chamas — os campos já existem em `config/weapons.json`, mas o efeito não foi
implementado.

---

## Fase 4 — Mundo ✅

**Entregue**

- `world/terrain.ts` — o terreno é uma **função pura de (seed, x, z)**. O módulo não
  importa three, Rapier nem DOM, porque é carregado também pelo Web Worker: se as duas
  cópias divergissem em um bit, o colisor e a malha discordariam.
  Continente + colinas + cristas *ridged* mascaradas pelo continente + detalhe fino.
- `world/layout.ts` — POIs e estradas são calculados **antes** do terreno e o
  *dirigem*: cada POI e cada trecho de estrada registra um disco de achatamento, então
  o chão já nasce nivelado. Colocar prédios sobre um terreno pronto os deixaria
  flutuando ou enterrados em qualquer encosta.
- `world/terrainWorker.ts` — gera posições, normais (a partir do próprio campo de
  altura, exato e mais barato que acumular normais de face), cores por vértice e
  índices, e devolve tudo por *transfer* de buffers.
- `world/streamer.ts` — chunks de 128 m com 3 LODs (32/16/8 quads), raio de carga 5 e
  descarga 7, **1 chunk aplicado por frame**, e colisor `heightfield` do Rapier em
  resolução fixa de 16 — o LOD visual muda, a física não.
- `world/scatter.ts` — vegetação e props num **`InstancedMesh` por modelo para o mundo
  inteiro**, não por chunk: um chunk de floresta tem 64 props, e com 80 chunks
  carregados o instancing por chunk custaria centenas de draw calls.
- `world/daynight.ts` — ciclo de 60 min por interpolação de keyframes, 4 climas, e
  expõe `visibility`, o número único que a IA da fase 5 lê para saber até onde enxerga.
  Noite e neblina precisam cegar o inimigo de verdade, senão escuridão é decoração.
- `world/water.ts` — plano com shader de duas ondas cruzadas, fôlego e afogamento.
- `world/poiBuilder.ts` — os 3 POIs montados dos kits, com colisor de caixa derivado do
  bounding box de cada modelo (dezenas de prédios por POI; trimesh sairia caro demais
  para uma parede sólida). Estradas como fita de quads seguindo o grade já nivelado.

**Aceite verificado** — travessia de 2.545 m na diagonal do mapa

| | |
|---|---|
| Chunks construídos na travessia | **624** |
| Chunks simultaneamente carregados | **85–108** (limitado, sem vazar) |
| Crescimento de heap | **+1,9 MB** (98,2 → 100,1) |
| FPS | **180**, orçamento `world` 0,83/2 ms |
| Props instanciados | 470–2.778 conforme o bioma |
| Água | ~2% da superfície; relevo de −3 m a +76 m |
| Noite + neblina | visibilidade cai a **8%** |

**Defeitos encontrados e corrigidos durante a fase**

- **A vila afundava 36 m.** As estradas saem do centro dos POIs, e eu calculava a
  altura das pontas amostrando o terreno **bruto** (−28 m), enquanto o disco do POI já
  usava a altura corrigida (+8 m). Como os discos de estrada são aplicados depois, eles
  sobrescreviam o POI. As estradas passaram a herdar a altura dos POIs que ligam.
- **O jogador caía pelo mundo no spawn.** A geração é assíncrona; chamar `update()` em
  laço não espera o worker. Foi adicionado um `warmup()` que aguarda os chunks ao redor
  do spawn antes de criar o jogador, e o spawn é reposicionado sobre o colisor real.
- **O mapa era um oceano.** O campo de ruído é centrado em zero, então metade da
  superfície ficava abaixo da linha d'água e só 10 props apareciam em 80 chunks
  (tudo era mar). A distribuição foi comprimida e elevada; ficou em ~2% de água.

**Fora do escopo desta fase**

Imposters para distância (os LODs 0–2 já cobrem o alcance útil), e as estradas usam uma
fita procedural em vez das peças do Road Pack — o terreno já está nivelado ao longo do
traçado, e as peças exigiriam lógica de orientação e cruzamento sem ganho visível nessa
escala de arte.
