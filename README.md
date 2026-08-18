# Wasteland Web

FPS de mundo aberto que roda 100% no navegador. Three.js + Rapier3D, sem engine pesada,
sem asset pago e sem chamada a serviço proprietário. Toda a arte vem do pacote
**Kenney Game Assets All-in-1 3.6.0** (CC0).

Jogo **original**. Não usa nomes, marcas, modelos, mapas, áudio nem código de nenhum
título comercial — as armas têm nomes fictícios e genéricos.

## Rodando

```bash
npm install
```

O pipeline de assets lê o zip da Kenney direto de `~/Downloads`:

```bash
npm run assets:inventory
```

```bash
npm run assets:build
```

```bash
npm run dev
```

Abre em `http://127.0.0.1:5173`.

Build estático em `dist/`:

```bash
npm run build
```

## Cenas isoladas

Cada sistema pode ser iterado sem carregar o mundo inteiro, via query string:

| URL | O que carrega |
|---|---|
| `?scene=sandbox` | Chão, rampa e caixas dinâmicas — valida loop fixo, física e interpolação |
| `?scene=smoke` | Um modelo de cada categoria ao lado de uma referência de 1,80 m — valida o pipeline de assets e a escala dos kits |
| `?scene=world` | **Padrão.** Mundo aberto: terreno 2048×2048 m em streaming, 3 POIs ligados por estradas, ciclo dia/noite e clima |
| `?scene=player` | Circuito de obstáculos (rampas de 15° a 55°, degraus de 0,20 m a 0,70 m, saliência, vão de rastejo) + campo de tiro com alvos a 12/30/65/120/200 m e painéis de madeira, saco de areia, metal e concreto |

## Controles

| Tecla | Ação |
|---|---|
| `W A S D` | Mover |
| `Shift` | Correr |
| `C` | Agachar |
| `X` | Deitar |
| Botão esquerdo | Atirar |
| Botão direito | Mirar (ADS) |
| `R` | Recarregar |
| `B` | Trocar modo de tiro (auto / rajada / semi) |
| `F` | Bandagem |
| `1`–`9` | Trocar de arma (hotbar) |
| Roda do mouse | Arma anterior/próxima |
| `Q` | Voltar à arma anterior |
| `Shift`+`1`–`6` | Aplicar dano de teste na zona (cabeça, torso, braços, pernas) |
| `K` | Renascer e restaurar os alvos |
| `Espaço` | Pular / subir (freecam) |
| `Ctrl` | Descer (freecam) |
| Roda do mouse | Velocidade da freecam |
| Clique | Capturar o mouse (Pointer Lock) |
| `F1` | Mostra/esconde o painel de debug |
| `G` | Gizmos de IA: cone de visão, detecção, cobertura e estado da árvore |
| `H` | Mostra/esconde o HUD |
| `T` | Acelera o tempo 60× (cena `world`) |
| `Y` | Troca o clima: limpo → nublado → chuva → neblina |
| `P` | Pausa o ciclo dia/noite |
| `N` | Próxima animação do personagem (cena `smoke`) |

## Arquitetura

```
navegador
   |
   +-- GameLoop .............. timestep fixo de 60 Hz + render interpolado
   |      |
   |      +-- fixed(dt) ...... física, IA, gameplay          (determinístico)
   |      +-- render(alpha) .. interpola entre os 2 últimos estados fixos
   |
   +-- RenderContext ......... cena, câmera, sol/céu, sombras   (three)
   +-- PhysicsWorld .......... corpos, colisores, raycasts      (rapier)
   +-- Input ................. teclado/mouse + Pointer Lock
   +-- DebugOverlay .......... orçamento por frame + toggles de cada sistema
```

`/src` segue a divisão da especificação:

| Pasta | Responsabilidade |
|---|---|
| `core/` | loop, tempo fixo, event bus, pool, profiler, input, config |
| `render/` | cena, câmeras, luzes, LOD, instancing |
| `physics/` | wrapper Rapier, camadas de colisão, character controller, raycast |
| `world/` | heightmap, chunking, streaming, biomas, ciclo dia/noite |
| `entities/` | Player, NPC, Vehicle, Projectile, LootContainer |
| `combat/` | armas, balística, dano por zona, recuo, dispersão |
| `ai/` | percepção, blackboard, behavior tree, squad, cobertura |
| `vehicles/` | suspensão raycast, motor, dano, assentos |
| `missions/` | gerador dinâmico, tipos, estado, recompensas |
| `ui/` | HUD, inventário, mapa, menus — DOM + CSS, não canvas |
| `audio/` | mixer, áudio espacial, oclusão, música dinâmica |
| `save/` | IndexedDB, serialização |
| `debug/` | overlay, gizmos, free-cam |
| `net/` | stub — multiplayer é a fase 9 |

Regras estruturais:

- **Component-based**, sem herança profunda.
- Física e IA correm em **timestep fixo de 60 Hz**; o render é desacoplado e interpola.
- **Object pooling** para balas, decals, partículas e áudio.
- Todo número de balanceamento vive em `config/*.json` — nunca no código.
- Todo sistema novo registra seu **toggle de debug** no painel do `F1`.

## Documentos

- [`ASSETS_INVENTORY.md`](ASSETS_INVENTORY.md) — inventário dos 269 subpacotes Kenney, com ✅/⛔ e justificativa
- [`PROGRESS.md`](PROGRESS.md) — o que cada fase entregou, o que ficou de fora e por quê
- [`CREDITS.md`](CREDITS.md) — atribuição e licenças
