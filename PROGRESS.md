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
| 5. IA | ✅ concluída |
| 6. Veículos | ✅ concluída |
| 7. Missões + loot + economia | ✅ concluída |
| 8. Arsenal completo + polimento | ✅ concluída |
| 9. Multiplayer (opcional) | não iniciada |

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

---

## Fase 5 — IA ✅

**Entregue**

- `ai/perception.ts` — detecção é um **medidor de 0 a 100**, não um booleano. O ganho
  por segundo é multiplicado por distância (queda com potência), quão central o alvo
  está no cone, postura (em pé 1,0 / agachado 0,62 / deitado 0,34), movimento
  (parado 0,55 / andando 1,7 / correndo 2,4 / atirando 3,2, ou 1,35 se com supressor)
  e pela **visibilidade que o ciclo dia/noite publica**. Estados
  `unaware → suspicious → searching → aware → engaged` saem todos do mesmo número, o
  que dá um só valor para depurar. Audição por eventos com raio próprio, atenuada — não
  bloqueada — por paredes. Memória de última posição conhecida com decaimento.
- `ai/behaviorTree.ts` — framework com `Sequence`, `Selector`, `PrioritySelector`,
  `ReactiveSequence`, `Condition`, `Action`, `Inverter`, `Cooldown` e `Repeat`.
- `ai/cover.ts` — cobertura **encontrada em tempo real**, amostrando anéis ao redor do
  agente e testando linha de visão real contra a ameaça atual. Classifica cada ponto em
  agachado (escondido agachado, atira em pé), deitado ou totalmente oculto.
- `ai/navigation.ts` — direção por leque de sondas com teste de inclinação no
  heightfield, separação entre companheiros e detecção de travamento.
- `ai/squad.ts` — líder, retransmissão de contato **com atraso e erro de posição**,
  divisão em base de fogo e elemento de flanco, e **bounding overwatch** alternando qual
  metade se move.
- `entities/npc.ts` — o agente: percepção, árvore, arma real do arsenal, disciplina de
  rajada, atraso de reação por nível de perícia, e **timeslicing** (30 Hz perto,
  2 Hz longe).
- `debug/aiGizmos.ts` — cone de visão, medidor de detecção, barra de supressão,
  destino, cobertura escolhida e estado da árvore, na tecla `G`.

**Aceite verificado** — esquadrão veterano de 6 contra o jogador a 58 m

| | |
|---|---|
| Detecção | 1 agente vê → retransmite → 5 vão a `aware` (medidor 72) |
| Manobra | 3 em `suppress`, 2–3 em `flank*` com bounding alternado |
| Cobertura | 0 → 6 agentes em cobertura conforme o combate evolui |
| Fogo | **45 tiros em 7 s** de simulação, com recarga entre rajadas |
| Efeito | jogador sangrando e com 2 membros feridos |
| Desempenho | **180 FPS** com 11 agentes ativos |

**Defeitos encontrados e corrigidos durante a fase**

- **A árvore travava.** `Sequence` guarda o índice do filho em execução e retoma dele,
  então as condições de guarda nunca eram reavaliadas: um agente que entrou em
  "imobilizado" ficava lá para sempre, porque a ação devolve `running` e a condição na
  frente dela era pulada. Foi criada a `ReactiveSequence`, que reavalia todos os filhos
  a cada tick, e todos os ramos guardados passaram a usá-la.
- **Os agentes suprimiam a si mesmos.** O callback de passagem de projétil roda para
  cada tiro, e a boca da arma fica dentro do próprio atirador — todo agente se
  autossuprimia ao abrir fogo, ficando permanentemente "imobilizado" com o jogador
  intacto. A checagem passou a excluir quem disparou.
- **Ordens de esquadrão não chegavam ao combate.** Quem recebia contato retransmitido
  mas não via o alvo caía no ramo de investigar em vez de suprimir. Agora uma ordem
  diferente de `hold` com contato do esquadrão já é razão para lutar, e o alvo acreditado
  cai para o contato compartilhado quando não há visão própria.
- **Cobertura virava esconderijo.** Todos escolhiam pontos *totalmente ocultos*, de onde
  não dá para atirar, e ficavam parados: 0 tiros em 6 s. Durante o combate a busca passou
  a rejeitar pontos sem linha de tiro; o oculto total só vale ao recuar.

**Desvio da especificação — navegação**

A seção 4.5 pede **NavMesh via `recast-navigation-js` gerada no build**. Foi usado
steering com teste de inclinação no heightfield e sondas de obstáculo. O motivo é o que
foi sinalizado como risco no plano: o mundo é procedural e transmitido em chunks de
128 m, então a navmesh teria de ser reconstruída por chunk em tempo de execução. O
terreno aqui é caminhável em quase toda parte exceto encostas íngremes e água — que o
teste de inclinação cobre diretamente — e os únicos obstáculos reais são os prédios dos
POIs e os props, tratados pelas sondas. NavMesh continua sendo a resposta certa para
**interiores de prédios**, e é lá que isso deve ser retomado.

Também ficou de fora desta fase: `ManVehicle` (depende da fase 6) e cura/reanimação
entre companheiros.

---

## Fase 6 — Veículos ✅

**Entregue**

- `vehicles/vehicle.ts` — **suspensão por raycast** sobre um único corpo rígido do
  Rapier. Não há junta nem corpo de roda: cada canto lança um raio para baixo e aplica
  mola-amortecedor mais atrito de pneu no ponto de contato. É a abordagem padrão de
  arcade-sim e é o que mantém o carro estável a 60 Hz — rodas por restrição de verdade
  só param de tremer com uma taxa de solver bem mais alta.
- **Pneu com dois eixos**: atrito lateral (o que impede o carro de deslizar de lado; sem
  ele o veículo vira aerodeslizador) e longitudinal (tração e frenagem), ambos limitados
  pela carga daquele canto.
- **Motor** com curva de torque, câmbio automático por fração da faixa de rotação,
  tempo de troca e arrasto aerodinâmico limitando a velocidade final.
- **Dano localizado**: pneus por proximidade do impacto (furam e perdem aderência),
  motor na dianteira (perde potência e para em 0%) e tanque na traseira — perfurado,
  vaza, pega fogo e explode, ejetando quem estiver dentro.
- **Combustível** consumido por aceleração e marcha lenta, com vazamento quando o tanque
  é perfurado, e reabastecimento por jerrican.
- **Multi-assento** com motorista, passageiro e artilheiro; entrada e saída no `E`, com
  o ocupante colado ao assento e depositado no chão real ao sair.
- Câmeras de terceira e primeira pessoa (`V`), recuperação de capotamento (`Z`).
- 3 tipos: Hatch Civil, Picape Batedora e Buggy Off-Road, com massa, marchas, suspensão
  e aderência próprias em `config/vehicles.json`.

**Aceite verificado**

| | |
|---|---|
| Spawn | 8 veículos distribuídos nos 3 POIs, todos assentados na altura correta |
| Entrar/dirigir | `E` entra, WASD dirige, câmbio sobe de 1ª para 2ª sozinho |
| Dano localizado | pneu furado, motor a 0% e tanque a 31% em combate real |
| Ciclo de destruição | tanque perfurado → incêndio → explosão → ocupante ejetado |
| Freio de estacionamento | deriva de 0,73 m em 1,5 s parado numa encosta |

**Defeitos encontrados e corrigidos durante a fase**

- **Veículos caíam pelo mundo.** Os 5 nascidos em POIs distantes despencavam para
  −700 m, porque o terreno daqueles chunks ainda não havia sido transmitido e não havia
  colisor embaixo. Ganharam um estado **dormente**: enquanto não há chão sob eles, ficam
  presos na posição de spawn e não simulam.
- **Carros estacionados rolavam ladeira abaixo** e sumiam antes de alguém querer usá-los.
  Um veículo desocupado agora mantém o freio de mão puxado.
- A força do motor estava com um fator mágico de `0.02`, o que dava 0,2 m/s² de
  aceleração — um carro de 1150 kg levava um minuto para andar. Virou
  `engineForceScale` em config, calibrado para a faixa de um carro real.

**Nota de método**

A calibração fina da aceleração ficou prejudicada porque o único ponto com terreno
carregado no teste era a vila, onde o esquadrão da fase 5 destrói o motor do carro em
poucos segundos — o que, por si só, é a prova de que o dano localizado e a propagação
tanque → incêndio → explosão funcionam. O valor final foi derivado pela aritmética da
curva de torque e permanece um número de config, ajustável sem tocar em código.

**Correções após teste em jogo**

- **A câmera de dentro do veículo estava muito fora.** Três causas somadas: a orientação
  era montada com `lookAt` seguido de `rotateY`/`rotateX`, e depois do `lookAt` os eixos
  locais da câmera já estão inclinados, então rotacionar em torno deles compunha a
  inclinação e a vista entortava assim que o carro saía do plano; o offset de primeira
  pessoa era fixo, do lado do passageiro e acima do teto; e o free-look reaproveitava o
  `player.yaw`, que acumula sem relação com o carro. Agora a orientação vem de yaw/pitch
  explícitos, o free-look é **relativo ao veículo**, limitado e recentra sozinho, e a
  vista de dentro sai do **assento real do ocupante** — o que vale para qualquer veículo
  e qualquer poltrona, sem offset por modelo.
- **Dava para ver e atirar com a arma dirigindo.** O viewmodel é escondido ao entrar e o
  gatilho, a recarga e a troca de modo ficam inertes enquanto se dirige. Disparar de
  dentro do veículo é uma funcionalidade da seção 4.6 que **não foi implementada**, então
  o correto é ela não responder, e não atirar de uma arma invisível.
- Os modelos de veículo da Kenney não têm interior, então a câmera de primeira pessoa é
  avançada além do para-brisa para não ficar dentro da carcaça.

**Fora do escopo desta fase**

Disparo de dentro do veículo pelas janelas, IA dirigindo (o nó `ManVehicle` da árvore
existe mas não foi ligado), helicóptero e espelho/minimapa.

---

## Correções após teste em jogo — direção e personagens

### O carro dirigia ao contrário

Os modelos de veículo da Kenney apontam para **+Z**: seus nós `wheel-front-*`
ficam em Z positivo e os `wheel-back-*` em Z negativo. O código de direção usava
`-Z` como frente, que é a convenção normal de um objeto three.js. As duas coisas
juntas produziam exatamente o que se via:

- `W` empurrava o carro para o lado da traseira, enquanto a câmera olhava para o
  nariz — ou seja, o carro andava de ré na tela;
- as rodas **traseiras** eram as que esterçavam, e esterçar pelo eixo de trás
  inverte o sentido da curva, então `A` virava para a direita.

Era um sinal só. `forward` passou a ser `+Z` e `right` a acompanhar; a geometria
das rodas já estava certa (dianteiras esterçam, traseiras tracionam). O ângulo
do corpo ganhou dois nomes distintos — `heading`, para onde o nariz aponta, e
`cameraYaw`, meia volta adiante porque uma câmera three.js olha pelo próprio
`-Z`. Sem essa distinção o `recover()` levantava o carro capotado virado ao
contrário, o que também acontecia.

### O carro derrapava como se o chão fosse gelo

O atrito lateral do pneu estava **cerca de duzentas vezes fraco**. A fórmula
multiplicava o impulso por um `0.06` arbitrário *e* dividia a carga da roda pelo
peso do próprio carro, o que já a deixava perto de 0,25 antes de qualquer outra
coisa. O resultado era um veículo que praticamente não resistia a andar de lado.

Agora é atrito de Coulomb honesto: cancelar o escorregamento custa
`massa × velocidade_lateral` de impulso, e o pneu entrega no máximo
`grip × carga_normal × dt`. `gripLateral` e `gripLongitudinal` viraram
coeficientes de atrito de verdade em `config/vehicles.json` (2,0 e 1,8; 1,0 é o
limite de um pneu de rua real, acima disso é aderência de arcade).

O impulso lateral é aplicado **na altura do centro de massa**, não no cubo da
roda. Uma força lateral aplicada abaixo do centro também rola o carro, e com
essa aderência uma curva forte o deitaria; só o braço horizontal é que faz o
carro girar, então achatar o ponto de aplicação preserva a curva e descarta o
capotamento. Tração e freio continuam no cubo, para o carro ainda mergulhar na
freada. O freio também ganhou um limite que impede de arrastar a roda para trás
do zero.

**Medido em jogo** (Hatch Civil, terreno da vila):

| | |
|---|---|
| Acelerar em linha reta | 16,41 m percorridos, **16,41 m na direção do nariz** |
| Arrancada | 0 → 24,3 km/h no primeiro segundo |
| `A` com o carro andando | gira **+88,2°**, ou seja, para a esquerda |
| Derrapagem nessa curva | 20% da velocidade é lateral (era praticamente toda) |

Uma roda também aparecia flutuando um raio acima do chão: `frame()` somava o
raio da roda a uma altura que já o continha.

### Agachar abria os braços dos inimigos

A causa não era a animação de agachar em si: é que ela é um clip de **corpo
inteiro** e anima os braços tanto quanto as pernas. Tocada num inimigo que
segura um fuzil, as tracks de braço do agachamento simplesmente sobrescreviam a
pose da arma.

Trocamos o pack de personagens, como pedido, para o **Animated Characters
Bundle** — que é o único da Kenney com rig humanoide de verdade (46 ossos de
deformação, com coluna, ombro, antebraço, mão e dedos, contra os 7 nós do Mini
Characters) e com `crouchIdle`, `crouchWalk` e `shoot` como clips separados. É
esse rig que torna possível a correção de verdade: `src/anim/characterAnimator.ts`
divide cada clip por osso e toca **duas camadas** — pernas e quadril de um clip,
coluna para cima de outro. Como os dois conjuntos de tracks são disjuntos, eles
compõem sem peso de blend nenhum. O quadril fica na camada de baixo, então
agachar continua baixando o corpo inteiro.

Medido no corpo que *empresta* o rig (o caso arriscado), comparando a mão
direita em relação ao quadril:

| | mão em relação ao quadril | quadril |
|---|---|---|
| Em pé, mirando | 0,185 / 0,115 / 0,307 | 24,803 |
| Agachado, mirando | 0,175 / 0,116 / 0,312 | 24,530 |
| Agachado com o clip inteiro (o bug) | **0,548** / **0,316** / 0,128 | 24,530 |

O quadril desce 27 cm nos dois casos — o agachamento é real. Mas com o clip
inteiro a mão salta **37 cm para fora e 20 cm para cima**: os braços abrindo,
medidos. Com a máscara ela anda 1 cm.

### O pipeline de FBX

O bundle só vem em `.fbx` e `.blend`, e não há Blender nem conversor nativo
nesta máquina. `tools/build-characters.mjs` resolve isso com o próprio three:
`FBXLoader` lê os arquivos em Node e `GLTFExporter` reescreve em GLB, com dois
`globalThis` de fachada porque o exportador relê o próprio Blob por `FileReader`.
Depois disso o `build-assets.mjs` trata o resultado como qualquer outro kit
Kenney.

Duas economias fazem isso caber no orçamento:

- **Keyframes constantes viram um só.** Um clip humanoide carrega posição,
  rotação e escala dos 58 ossos, mas na maioria deles nada se mexe. Descartar
  essas tracks seria errado — uma track constante ainda precisa *pôr* o osso
  naquele ângulo, e sem ela o osso volta para a bind pose, de braços abertos.
  Guardar um keyframe preserva a pose e joga fora a repetição: 64.032 → 12.295.
- **Um único conjunto de clips.** Os quatro corpos dividem o mesmo esqueleto, e
  clips casam por nome de osso, então só o `character-medium` carrega os 17
  clips; os outros apontam para ele pelo campo `rig` do manifest.

O merge de quatro corpos num GLB só colide os nomes de osso e o pipeline os
sufixa (`Hips` vira `Hips_2`). Um clip carrega o sufixo do corpo com que foi
exportado, então ele só casaria com aquele corpo — e todos os outros cairiam na
bind pose, de braços abertos outra vez. O animador rebinda por nome base, o que
imuniza contra isso.

`characters.glb`: 787 KB com 17 clips e 4 corpos (o pack anterior eram 560 KB).

### Arma na mão, e não flutuando ao lado

O fuzil agora é filho do osso `RightHand`, então acompanha a mira, o agachamento
e o recuo. Duas coisas tiveram de sair de números mágicos:

- o rig Kenney tem uma escala de cem vezes própria, então o fator a desfazer vem
  da escala **do osso**, não da escala do corpo;
- a orientação é derivada uma vez, na pose de mira: `mão⁻¹ × corpo` alinha o cano
  (o `+Z` da arma) com a frente do personagem. Nenhum Euler ajustado à mão.

O clip `shoot` da Kenney não serve inteiro para um fuzil: em 1,07 s o braço leva
a arma até a **vertical** e volta, e o inimigo passaria metade da rajada
apontando para o céu. Só os 0,1 s iniciais são recuo de verdade, e recortados em
ping-pong a arma chuta e assenta enquanto o gatilho estiver preso. Medido
atirando agachado, o cano fica entre 0,87 e 0,99 de alinhamento com a frente.

**Pendências que isto deixa:** o bundle não tem clip de deitar (`prone`) — nem o
pack anterior tinha —, então o inimigo agacha mas não deita; os acessórios do
pack (capacete, mochila, colete militares) estão convertíveis mas não foram
ligados; e `character-large-male` e `character-large-female` saem do zip com a
mesma malha, o que parece ser do pack e não da conversão.

---

## Fase 7 — Missões, loot e economia ✅

**Entregue**

- **Itens e mochila por peso** (`config/items.json`, `entities/inventory.ts`). 31 itens:
  munição por calibre, bandagem e kit médico, mochilas que aumentam a carga,
  coletes e capacete com nível de proteção, jerrican, kit de reparo, gazua, os
  nove acessórios de arma e itens de valor. O limite é **peso**, não número de
  espaços — um jerrican são 15,5 kg, então levar combustível custa a munição que
  você não trouxe. A mochila entrega **parcialmente**: um contêiner com 40
  cartuchos quando só cabem 10 passa os 10 e deixa o resto, em vez de recusar a
  pilha inteira.
- **Tabelas de loot por tier** (`config/loot.json`, `loot/lootTable.ts`) — civil,
  policial e militar, com sorteio ponderado. Cada contêiner rola a partir de uma
  semente derivada do **próprio id**, então ele guarda o que guarda: reabrir ou
  recarregar o save não re-sorteia para algo melhor.
- **Contêineres e corpos** (`entities/lootContainer.ts`) — 30 contêineres
  espalhados pelos POIs conforme o tier da área, mais caixas de missão, mais o
  corpo de todo inimigo que cai (o tier vem da perícia dele). Tudo responde ao
  mesmo `E`, com o mais próximo ganhando; um contêiner esvaziado escurece.
- **Economia com banco** (`economy/wallet.ts`, `economy/shop.ts`) — dinheiro no
  bolso e dinheiro no banco. **Morrer leva o bolso e a mochila, nunca o banco.**
  Depositar só acontece na zona segura, que é o que transforma "voltar vivo" numa
  decisão em vez de uma formalidade.
- **Arsenal** — compra de armas, equipamento e veículos, e venda do saque por 55%
  do valor. A ordem das checagens importa: nada é cobrado antes de se saber que
  cabe, então mochila cheia não engole o dinheiro.
- **Gerador de missões** (`missions/`) — **7 tipos** (a spec pede 5): posto
  avançado, alvo de alto valor, comboio, queda de suprimentos, sabotagem, resgate
  e captura de setor. O diretor mantém 3 a 5 no quadro, cada uma expira e reaparece
  em outro lugar, e a recompensa sobe com a dificuldade **e com a distância de
  casa**. As guarnições só nascem quando o jogador chega a 320 m — trinta NPCs no
  orçamento de IA para brigas que ninguém está tendo seria desperdício.
- **Save em IndexedDB** (`save/`) — banco, bolso, mochila, armas compradas,
  munição por calibre, posição e estatísticas, gravados a cada 20 s e na morte.
- **UI** — mapa em tela cheia (`M`) com o relevo desenhado a partir da própria
  função de altura, estradas, POIs, círculos de missão com o prêmio, zona segura e
  waypoint clicável; mochila (`I`) com peso, depósito e uso de consumíveis;
  arsenal (`L`) com compra e venda.

**Aceite verificado — o laço fechado que a spec pede**

| | |
|---|---|
| Saquear | contêiner rendeu $18 e 2 itens; ficou vazio |
| Cumprir | eliminar a guarnição fechou a missão |
| Receber | $1286 caíram no bolso |
| Depositar | $1304 → banco $1704, só dentro da zona segura |
| Comprar | SMG por $620 entrou no loadout; medkit na mochila |
| Salvar + recarregar | após F5: banco $1014, a SMG no loadout, 3,06 kg na mochila, 1 missão contabilizada |

**Defeito encontrado no teste**

A zona segura era um disco de 45 m no centro da vila, mas o jogador **nasce na
borda**, a 66 m do centro. Ou seja: começava e renascia *fora* dela, com o
arsenal recusando atendimento e sem nada na tela explicando por quê. A zona agora
cobre o POI inteiro, e o raio do config virou um piso em vez de um valor fixo.

**Testes** — 121 no total, 55 novos nesta fase: gerador determinístico, tabelas de
loot (todo item citado existe no catálogo, o mesmo contêiner sempre rola igual,
militar rende mais que civil), mochila por peso, serialização do save (recusa o
que não é save, recusa versão futura, preenche o que falta em vez de perder a run,
descarta item retirado do catálogo), carteira e loja, gerador de missões (7 tipos,
recompensa por dificuldade e distância, comboio cai na estrada, missões espalhadas)
e o diretor (expira, repõe, conta abates, progresso só corre dentro do círculo).

**Fora do escopo desta fase**

Inventário arrastar-e-soltar (a mochila é lista com botões), fome e sede — a spec
as marca como opcionais por config —, e as missões de escolta e sabotagem existem
no gerador com objetivo e temporizador, mas ainda não têm o NPC prisioneiro nem a
carga plantável como entidades no mundo: hoje resolvem pelo tempo dentro da área.

---

## Fase 8 — Áudio, menus e controles ✅

O escopo desta fase era "arsenal completo + polimento". O arsenal já estava
pronto desde antes: **20 armas** contra as 12 pedidas, **9 acessórios** modulares
e o clima no ciclo dia/noite. O que faltava era o áudio, os menus e os controles.

**Áudio**

- **Mixer com canais** (`audio/mixer.ts`): geral, efeitos, veículos, vozes, música
  e interface, cada um com seu ganho. O contexto começa suspenso porque o
  navegador exige um gesto do usuário — o mesmo clique que trava o ponteiro é o
  que liga o som.
- **Ducking**: ataque imediato e liberação lenta. É isso que faz um tiroteio
  sentar **em cima** da música em vez de brigar com ela: o primeiro tiro abre o
  espaço e o fogo contínuo o mantém aberto.
- **Espacialização** com `PannerNode` HRTF e rolloff inverso, com teto de vozes:
  um tiroteio sem limite pede duzentas fontes simultâneas e engasga a thread de
  áudio, e passando de duas dúzias ninguém ouve diferença.
- **Tiro em três camadas** (`audio/gameAudio.ts`): o mecanismo é seco e pertence a
  quem puxou o gatilho, não ao mundo; o estampido é o que viaja e é espacializado;
  a cauda é o ambiente respondendo, **atrasada pela distância**, que é o que faz o
  mesmo fuzil soar diferente na floresta e no descampado.
- **Crack-thump**: a bala é supersônica, então o estalo da passagem chega antes do
  estampido de quem atirou. O atraso é a distância dividida pela velocidade do som,
  e o ponto de passagem sai do mesmo segmento que a supressão já calcula.
- **Passos por material** conforme o bioma, **motor com pitch amarrado ao RPM**,
  **ambiente por bioma e hora** (com camada extra de noite) e **música dinâmica**
  que troca para a faixa de combate ao primeiro contato e volta depois de 8 s sem.

**Controles**

- **Ações nomeadas** (`core/keybinds.ts`): o jogo pergunta por `forward`, nunca por
  `KeyW`. Essa indireção é o que torna tudo remapeável — e o que faz um teclado
  não-QWERTY funcionar, já que `code` é posição física.
- Remapear **tira a tecla de quem a tinha**: deixar duplicata daria dois
  significados a uma tecla, com o vencedor decidido por ordem de iteração — um bug
  que parece aleatório de fora.
- Teclas reservadas (`Esc`, `F1`, `F5`, `F11`, `F12`, `Tab`) são recusadas.
- **Gamepad**: analógico esquerdo anda, direito olha com resposta quadrática (mira
  fina no centro, giro rápido na borda), gatilhos atiram e miram. O pad é lido uma
  vez por frame, porque o navegador devolve um objeto novo a cada chamada e
  consultar de vários lugares leria instantes diferentes.

**Menus**

- **Opções** (`O`): sensibilidade, campo de visão, inverter eixo Y, seis sliders de
  volume, qualidade gráfica e a lista de teclas remapeáveis.
- **Qualidade** mira o alvo do aceite (GPU integrada): "baixa" desliga a sombra —
  o mapa de sombra direcional é a coisa mais cara da cena —, reduz o pixel ratio e
  **puxa o horizonte** do streaming para 60% do raio.
- **Tela de morte** com o que se perdeu, o que o banco preservou e as estatísticas
  da run.
- Tudo isso vai para o save, junto com as teclas.

**Aceite verificado**

| | |
|---|---|
| Contexto de áudio | ativo; vozes acumulam a cada evento (tiro 2, +impacto e explosão 3, +crack-thump 5, +passos 10) |
| Ducking | vai a 100% na explosão e relaxa sozinho |
| Música dinâmica | fora de combate `Flowing Rocks` (exploração) → contato → `Alpha Dance` (combate) |
| Remapear | `forward`→Z tira o Z de "desvirar veículo" |
| Tecla reservada | `F5` recusada, `jump` continua em Espaço |
| Qualidade | "baixa" desliga a sombra; "alta" religa |
| FOV | slider chega na câmera |
| Build de produção | roda sem erro no console e sem 404 |

**Defeito encontrado no teste**

Morri para o esquadrão da vila enquanto o painel de opções estava aberto, e as
duas telas ficaram **empilhadas** — pior, `Esc` estava bloqueado pela tela de
morte, então não havia saída óbvia. Morrer agora fecha o que estiver aberto.

**Limite do material, não do código**

O pacote Kenney é CC0 e estilizado: **não existe tiro realista nele**. As camadas
usam o que há (lasers, impactos, motores). A arquitetura é a que a spec pede, e
trocar os samples é mexer só em `config/audio.json` — nenhum id de som está
escrito em código.

**Fora do escopo desta fase**

Normalização a −16 LUFS (precisa de ffmpeg, que não está instalado) e reverb por
convolução — a cauda hoje é um sample por ambiente, não um `ConvolverNode`.
