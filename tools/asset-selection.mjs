/**
 * Which Kenney subpacks ship in the game, and why. Shared by inventory.mjs
 * (which documents the decision) and build-assets.mjs (which acts on it).
 *
 * `category` drives the merged GLB the models are packed into.
 */
export const SELECTED_3D = {
  'Mini Characters': {
    category: 'characters',
    why: 'Único pack de personagem já em GLB com rig e 32 animações nomeadas (idle/walk/sprint/crouch/holding-both-shoot/die/drive). Nós nomeados head/torso/arm-*/leg-* servem de base para a vida por zonas.',
    include: /^character-/,
  },
  'Weapon Pack': {
    category: 'weapons',
    why: 'Base do arsenal: pistola, uzi, escopeta, sniper, metralhadora, lança-foguetes, lança-chamas, granadas e facas.',
  },
  'Blaster Kit': {
    category: 'weapons',
    why: 'Peças modulares (canos, miras, carregadores, coronhas) para montar os acessórios da seção 4.3.',
  },
  'Car Kit': {
    category: 'vehicles',
    why: 'Civis e utilitários com body e wheel-front/back-left/right em nós separados — pronto para suspensão raycast.',
  },
  'Racing Kit': {
    category: 'vehicles',
    why: 'Buggies off-road, pneus e barreiras de pista.',
  },
  'Nature Kit': {
    category: 'props_nature',
    why: 'Árvores, arbustos, pedras e formações — vegetação instanciada dos biomas campo e floresta.',
  },
  'Survival Kit': {
    category: 'props_loot',
    why: 'Barris, caixas, baús, cercas e fogueiras: contêineres de loot e cobertura destrutível.',
  },
  'Food Kit': {
    category: 'props_loot',
    why: 'Consumíveis para as tabelas de loot civil.',
  },
  'Furniture Kit': {
    category: 'props_loot',
    why: 'Mobília dos interiores dos POIs.',
  },
  'Road Pack': {
    category: 'props_city',
    why: 'Malha viária modular que conecta os POIs.',
  },
  'City Kit - Roads': {
    category: 'props_city',
    why: 'Cruzamentos e faixas urbanas complementares ao Road Pack.',
  },
  'City Kit - Suburban': {
    category: 'props_city',
    why: 'Casas e quintais da vila costeira.',
  },
  'City Kit - Commercial': {
    category: 'props_city',
    why: 'Lojas e prédios do centro do POI urbano.',
  },
  'City Kit - Industrial': {
    category: 'props_city',
    why: 'Galpões e silos da área industrial.',
  },
  'Factory Kit': {
    category: 'props_city',
    why: 'Tubulações, tanques e passarelas do POI industrial.',
  },
  'Modular Buildings': {
    category: 'props_city',
    why: 'Paredes, portas e escadas para montar interiores percorríveis.',
  },
  'Building Kit': {
    category: 'props_city',
    why: 'Blocos de fachada e telhado para variar os prédios dos POIs.',
  },
  'Tower Defense Kit': {
    category: 'props_city',
    why: 'Sacos de areia, torres e barreiras — fortificações da base militar e pontos de cobertura da IA.',
  },
  'Prototype Kit': {
    category: 'props_city',
    why: 'Blocos neutros para bloquear layout e para as cenas de teste isoladas.',
  },
};

export const SELECTED_AUDIO = {
  'Impact Sounds': 'Impactos de bala por material, explosões e destroços.',
  'Foley Sounds': 'Passos, roupa, manuseio de equipamento e recargas.',
  'Digital Audio': 'Estampidos e mecanismos de arma (camada de tiro).',
  'Sci-Fi Sounds': 'Camadas extras de arma e zumbidos de veículo.',
  'Interface Sounds': 'Cliques e confirmações de HUD.',
  'UI Audio': 'Alertas, erros e transições de menu.',
  'Voiceover Pack': 'Rádio de comando do esquadrão e chamadas da IA.',
  'Music Loops': 'Música ambiente e de combate.',
};

export const SELECTED_OTHER = {
  'UI assets/UI Pack': 'HUD, painéis, botões e barras (DOM + CSS).',
  'Icons/Game Icons': 'Ícones de inventário, munição e missão.',
  'Icons/Input Prompts': 'Prompts de tecla e de gamepad.',
  'Other/Fonts': 'Tipografia do jogo (Kenney Future Narrow / Kenney Mini).',
};

/** Packs worth an explicit rejection note rather than the generic one. */
export const REJECTION_NOTES = {
  'Animated Characters Bundle':
    'Só FBX/blend; o rig e as animações que ele traz já existem, em GLB, no Mini Characters.',
  'Animated Characters Protagonists': 'Só FBX e apenas 3 animações; redundante com Mini Characters.',
  'Animated Characters Retro': 'Só FBX e apenas 3 animações; redundante com Mini Characters.',
  'Animated Characters Survivors': 'Só FBX e apenas 3 animações; redundante com Mini Characters.',
  'Blocky Characters':
    'Rigado e barato (72 tri), mas o estilo bloco destoa do Mini Characters escolhido. Candidato a LOD distante no futuro.',
  'Nature Kit (Classic)': 'Substituído pela versão nova do Nature Kit.',
  'Space Kit': 'Ficção científica fora do tom pós-apocalíptico terrestre.',
  'Modular Space Kit': 'Ficção científica fora do tom.',
  'Space Station Kit': 'Ficção científica fora do tom.',
  'Watercraft Pack': 'Sem gameplay náutico nas fases 0–5; reavaliar se surgir POI portuário.',
  'Train Kit': 'Sem ferrovia no mapa das fases 0–5.',
  'Retro Urban Kit': 'Estilo retrô conflita com a paleta dos City Kits já escolhidos.',
  'Toy Car Kit': 'Escala de brinquedo, incompatível com veículos dirigíveis.',
};

export const CATEGORIES = [
  'characters',
  'weapons',
  'vehicles',
  'props_nature',
  'props_city',
  'props_loot',
];
