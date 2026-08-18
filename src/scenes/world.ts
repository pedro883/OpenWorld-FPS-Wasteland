import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { Player as PlayerCfg, World as WorldCfg } from '../core/config';
import { input, MOUSE_LEFT } from '../core/input';
import { debugOverlay } from '../debug/overlay';
import { profiler } from '../core/profiler';
import { Player, readPlayerInput } from '../entities/player';
import { Loadout } from '../entities/loadout';
import { TargetDummy } from '../entities/targetDummy';
import { Viewmodel } from '../render/viewmodel';
import { Hud } from '../ui/hud';
import { BallisticsSystem } from '../combat/ballistics';
import { ExplosionSystem } from '../combat/explosions';
import { ImpactEffects, MuzzleFlash } from '../combat/impacts';
import { LOADOUT } from '../combat/arsenal';
import { StatusEffects } from '../combat/statusEffects';
import { Vehicle } from '../vehicles/vehicle';
import { Inventory, itemDef } from '../entities/inventory';
import { LootField, type LootSource } from '../entities/lootContainer';
import { Wallet } from '../economy/wallet';
import { SAFE_ZONE, sellAllValuables, type ShopContext } from '../economy/shop';
import { MissionDirector, type ActiveMission } from '../missions/director';
import type { MissionWorld } from '../missions/generator';
import { MapPanel } from '../ui/mapPanel';
import { InventoryPanel } from '../ui/inventoryPanel';
import { ShopPanel } from '../ui/shopPanel';
import { defaultSave, loadSave, storeSave, type SaveState } from '../save/saveGame';
import { GameAudio, type ShotEnvironment } from '../audio/gameAudio';
import type { Loop } from '../audio/sfx';
import { keybinds } from '../core/keybinds';
import { OptionsPanel, type GameSettings, type Quality } from '../ui/optionsPanel';
import { DeathScreen } from '../ui/deathScreen';
import vehicleConfig from '../../config/vehicles.json';
import { Terrain } from '../world/terrain';
import { WorldLayout } from '../world/layout';
import { TerrainStreamer } from '../world/streamer';
import { PoiBuilder } from '../world/poiBuilder';
import { DayNightCycle } from '../world/daynight';
import { Water } from '../world/water';
import { Navigator } from '../ai/navigation';
import { CoverFinder } from '../ai/cover';
import { Squad } from '../ai/squad';
import { Npc, type SkillLevel } from '../entities/npc';
import { AiGizmos } from '../debug/aiGizmos';
import aiConfig from '../../config/ai.json';

/**
 * The open world: streamed terrain, three POIs joined by roads, a day/night
 * cycle and the full player/combat stack from phases 2 and 3.
 */
export class WorldScene implements Scene {
  readonly name = 'world';
  private ctx!: SceneContext;

  private terrain!: Terrain;
  private layout!: WorldLayout;
  private streamer!: TerrainStreamer;
  private pois!: PoiBuilder;
  private cycle!: DayNightCycle;
  private water!: Water;

  private player!: Player;
  private loadout!: Loadout;
  private viewmodel!: Viewmodel;
  private hud!: Hud;
  private ballistics!: BallisticsSystem;
  private explosions!: ExplosionSystem;
  private effects!: ImpactEffects;
  private muzzle!: MuzzleFlash;
  private pointerHint!: HTMLDivElement;

  private readonly dummies: TargetDummy[] = [];
  private navigator!: Navigator;
  private coverFinder!: CoverFinder;
  private gizmos!: AiGizmos;
  private readonly squads: Squad[] = [];
  private readonly npcs: Npc[] = [];
  private gizmosOn = false;
  private effects2!: StatusEffects;
  private readonly vehicles: Vehicle[] = [];
  private readonly inventory = new Inventory();
  private readonly wallet = new Wallet();
  private lootField!: LootField;
  private director!: MissionDirector;
  private mapPanel!: MapPanel;
  private inventoryPanel!: InventoryPanel;
  private shopPanel!: ShopPanel;
  private safeZone: { x: number; z: number; radius: number } | null = null;
  /** Garrisons already put in the world, keyed by mission id. */
  private readonly missionNpcs = new Map<string, Npc[]>();
  /** Corpses already turned into loot, so a body is only harvested once. */
  private readonly harvested = new Set<number>();
  private readonly ownedWeapons = new Set<string>();
  private save: SaveState = defaultSave(WorldCfg.seed);
  private autosaveTimer = 0;
  private readonly audio = new GameAudio();
  private optionsPanel!: OptionsPanel;
  private deathScreen!: DeathScreen;
  private settings: GameSettings = { sensitivity: 1, fov: 75, quality: 'alta', invertY: false };
  private ambienceTimer = 0;
  private awaitingRespawn = false;
  private engineLoop: Loop | null = null;
  private toast = '';
  private toastTimer = 0;
  private ridingVehicle: Vehicle | null = null;
  private ridingSeat = -1;
  private firstPersonDrive = false;
  /** Free-look while riding, measured *relative to the vehicle*. */
  private driveYaw = 0;
  private drivePitch = 0;
  private readonly lastLook = { x: 0, y: 0 };
  private hudVisible = true;
  private lastHit = 'nenhum';
  private spawn = new THREE.Vector3();

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    this.terrain = new Terrain({
      seed: WorldCfg.seed,
      sizeMeters: WorldCfg.sizeMeters,
      heightScale: WorldCfg.heightScale,
      waterLevel: WorldCfg.waterLevel,
    });
    // Layout first: it levels the ground the POIs and roads will sit on, and
    // the streamer must be created only after those discs exist.
    this.layout = new WorldLayout(this.terrain);

    this.streamer = new TerrainStreamer(ctx.render.scene, ctx.physics, this.terrain, this.layout);
    await this.streamer.prepare();

    this.cycle = new DayNightCycle(ctx.render);
    this.water = new Water(ctx.render.scene);

    this.ballistics = new BallisticsSystem(ctx.physics, WorldCfg.gravity);
    this.effects = new ImpactEffects(ctx.render.scene);
    this.muzzle = new MuzzleFlash(ctx.render.scene);
    this.explosions = new ExplosionSystem(ctx.physics, ctx.render.scene);
    this.effects2 = new StatusEffects(ctx.render.scene);
    this.ballistics.onImpact = (e) => {
      this.effects.handleImpact(e);
      this.audio.impact(e.point, e.material);
      // Rounds that strike a vehicle feed its localised damage model.
      const owner = e.owner as { vehicle?: Vehicle } | null;
      if (owner?.vehicle && e.damage) owner.vehicle.applyHit(e.point, e.damage);
    };
    this.ballistics.onExplosion = (e) => {
      this.audio.explosion(e.point);
      this.explosions.handle(e);
    };
    this.ballistics.onDamage = (e) => {
      this.lastHit = `${e.zone} · ${e.amount.toFixed(0)} · ${e.distance.toFixed(0)} m`;
      this.hud.flashHit(e.zone === 'head');
      // A flamethrower round sets the target alight for as long as configured.
      const burn = e.special?.burn;
      if (burn) {
        const victim = e.entity as { health?: { alive: boolean } } | null;
        if (victim?.health) {
          this.effects2.applyBurn(
            victim.health as never,
            burn.damagePerSecond,
            burn.seconds,
          );
        }
      }
    };
    this.ballistics.onSpecial = (e) => this.handleSpecial(e.point, e.payload);
    this.explosions.onDamage = (_entity, zone, amount) => {
      this.lastHit = `explosão · ${zone} · ${amount.toFixed(0)}`;
      this.hud.flashHit(false);
    };

    // Spawn on the edge of the village, facing in. The terrain there has to
    // exist before the player does, or they fall through on frame one.
    const village = this.layout.pois[0]!;
    this.spawn.set(village.x + village.radius * 0.85, village.groundHeight + 1.5, village.z);
    await this.streamer.warmup(this.spawn);
    const ground = this.streamer.groundAt(this.spawn.x, this.spawn.z);
    if (ground !== null) this.spawn.y = ground + 1.0;
    this.player = new Player(ctx.physics, this.spawn);
    this.player.yaw = Math.PI / 2;

    this.loadout = new Loadout(this.ballistics, this.player, Object.values(LOADOUT.default));
    this.viewmodel = new Viewmodel(ctx.render);
    await this.viewmodel.setWeapon(this.loadout.current.id);
    this.loadout.onWeaponChanged = (weapon) => void this.viewmodel.setWeapon(weapon.id);

    this.hud = new Hud();
    this.pointerHint = document.createElement('div');
    this.pointerHint.id = 'pointer-hint';
    this.pointerHint.textContent =
      'Clique para jogar · WASD · Shift correr · C/X postura · 1-5 armas · E interagir · M mapa · I mochila · L arsenal · F1 debug';
    this.pointerHint.addEventListener('click', () => void input.requestLock());
    // Browsers keep an AudioContext suspended until a real gesture, so the same
    // click that grabs the pointer is what starts the sound.
    window.addEventListener('pointerdown', () => void this.audio.start(), { once: false });
    document.body.appendChild(this.pointerHint);

    // Build the POIs before the first frame so the village is never empty.
    this.pois = new PoiBuilder(ctx.render.scene, ctx.physics, this.layout);
    await this.pois.buildAll();
    await this.spawnPatrol();

    await this.spawnVehicles();
    this.navigator = new Navigator(ctx.physics, this.terrain);
    this.coverFinder = new CoverFinder(ctx.physics, this.terrain);
    this.gizmos = new AiGizmos(ctx.render.scene);
    await this.spawnSquads();

    // A round passing close to an agent is what suppression is made of.
    this.ballistics.onPass = (from, to, shooter) => this.applySuppression(from, to, shooter);

    await this.setupEconomyAndMissions();
    this.registerDebug();
  }

  private async spawnPatrol(): Promise<void> {
    const village = this.layout.pois[0]!;
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const radius = village.radius * 0.3;
      this.dummies.push(
        await TargetDummy.spawn(
          this.ctx.physics,
          this.ctx.render.scene,
          new THREE.Vector3(
            village.x + Math.cos(angle) * radius,
            village.groundHeight,
            village.z + Math.sin(angle) * radius,
          ),
          angle + Math.PI,
          i,
        ),
      );
    }
  }

  /** Two fireteams: one holding the military POI, one patrolling the village. */
  private async spawnSquads(): Promise<void> {
    const deps = {
      physics: this.ctx.physics,
      scene: this.ctx.render.scene,
      ballistics: this.ballistics,
      navigator: this.navigator,
      cover: this.coverFinder,
      medium: this.effects2,
    };
    const weapons = aiConfig.spawn.weaponsBySkill as Record<string, string[]>;
    const plans: Array<{ poiIndex: number; size: number; skill: SkillLevel }> = [
      { poiIndex: 1, size: 6, skill: 'veteran' },
      { poiIndex: 0, size: 5, skill: 'regular' },
    ];

    for (let s = 0; s < plans.length; s++) {
      const plan = plans[s]!;
      const poi = this.layout.pois[plan.poiIndex]!;
      const squad = new Squad(s + 1);
      for (let i = 0; i < plan.size; i++) {
        const angle = (i / plan.size) * Math.PI * 2;
        const radius = poi.radius * 0.55;
        const x = poi.x + Math.cos(angle) * radius;
        const z = poi.z + Math.sin(angle) * radius;
        const list = weapons[plan.skill] ?? ['rifle_m4x'];
        const npc = await Npc.spawn(
          deps,
          new THREE.Vector3(x, this.terrain.heightAt(x, z), z),
          plan.skill,
          list[i % list.length]!,
          i,
        );
        npc.squad = squad;
        squad.add(npc);
        this.npcs.push(npc);
      }
      this.squads.push(squad);
    }
  }

  /**
   * Near-miss detection against the round's path segment for this tick. Using
   * the segment rather than its endpoint matters because a bullet crosses ~14 m
   * per tick and would otherwise skip past everyone it nearly hit.
   */
  private applySuppression(from: THREE.Vector3, to: THREE.Vector3, shooter: unknown): void {
    const segment = to.clone().sub(from);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 1e-6) return;
    // A round going past the player is the other half of a crack-thump: the
    // segment we already have is exactly where it passed.
    if (shooter !== this.player) this.playerCrackThump(from, segment, lengthSq);


    const radius = aiConfig.suppression.nearMissRadiusMeters;
    const relative = new THREE.Vector3();
    for (const npc of this.npcs) {
      // The muzzle sits inside the shooter, so without this every agent
      // suppresses itself the instant it pulls the trigger.
      if (!npc.isAlive || npc === shooter) continue;
      relative.set(npc.position.x, npc.position.y + 1.2, npc.position.z).sub(from);
      const t = Math.max(0, Math.min(1, relative.dot(segment) / lengthSq));
      const closest = segment.clone().multiplyScalar(t).sub(relative);
      if (closest.length() <= radius) npc.registerNearMiss();
    }
  }

  /**
   * Smoke and flash detonations. Flash exposure is computed per target from
   * distance, facing and line of sight, so turning away or ducking behind a
   * wall genuinely saves your eyes.
   */
  private handleSpecial(
    point: THREE.Vector3,
    payload: { smoke?: unknown; flash?: unknown },
  ): void {
    const smoke = payload.smoke as
      | { radiusMeters: number; seconds: number; blocksVisionFactor: number }
      | null
      | undefined;
    if (smoke) {
      this.effects2.spawnSmoke(
        point,
        smoke.radiusMeters,
        smoke.seconds,
        smoke.blocksVisionFactor,
      );
    }

    const flash = payload.flash as
      | { radiusMeters: number; blindSeconds: number; deafSeconds: number }
      | null
      | undefined;
    if (!flash) return;

    const eye = this.player.controller.eyePosition;
    const playerEye = new THREE.Vector3(eye.x, eye.y, eye.z);
    const playerForward = new THREE.Vector3();
    this.ctx.render.camera.getWorldDirection(playerForward);
    this.effects2.applyFlash(
      this.player,
      playerEye,
      playerForward,
      point,
      flash.radiusMeters,
      flash.blindSeconds,
      flash.deafSeconds,
      this.ctx.physics.hasLineOfSight(playerEye, point, 3),
    );

    for (const npc of this.npcs) {
      if (!npc.isAlive) continue;
      this.effects2.applyFlash(
        npc,
        npc.eyePosition,
        npc.forward,
        point,
        flash.radiusMeters,
        flash.blindSeconds,
        flash.deafSeconds,
        this.ctx.physics.hasLineOfSight(npc.eyePosition, point, 3),
      );
    }
  }

  /** Vehicles parked at each POI, per config/vehicles.json. */
  private async spawnVehicles(): Promise<void> {
    const spawns = vehicleConfig.spawns as unknown as Record<string, Record<string, number>>;
    for (const poi of this.layout.pois) {
      const plan = spawns[poi.id];
      if (!plan) continue;
      let slot = 0;
      for (const [typeId, count] of Object.entries(plan)) {
        for (let i = 0; i < count; i++) {
          const angle = (slot / 6) * Math.PI * 2;
          const radius = poi.radius * 0.68;
          const x = poi.x + Math.cos(angle) * radius;
          const z = poi.z + Math.sin(angle) * radius;
          this.vehicles.push(
            await Vehicle.spawn(
              this.ctx.physics,
              this.ctx.render.scene,
              typeId,
              new THREE.Vector3(x, poi.groundHeight + 0.4, z),
              -angle,
            ),
          );
          slot++;
        }
      }
    }
  }

  /** Nearest vehicle the player could climb into, or null. */
  private vehicleInReach(): Vehicle | null {
    const p = this.player.position;
    let best: Vehicle | null = null;
    let bestDistance = 3.6;
    for (const vehicle of this.vehicles) {
      if (vehicle.destroyed) continue;
      const d = vehicle.position.distanceTo(p);
      if (d < bestDistance) {
        bestDistance = d;
        best = vehicle;
      }
    }
    return best;
  }

  private enterVehicle(vehicle: Vehicle): void {
    const seat = vehicle.enter(this.player);
    if (seat < 0) return;
    this.ridingVehicle = vehicle;
    this.ridingSeat = seat;
    void this.audio.engine(vehicle.position).then((loop) => {
      // Entering and leaving quickly can land the loop after the exit.
      if (this.ridingVehicle === vehicle) this.engineLoop = loop;
      else loop?.stop(0.1);
    });
    this.driveYaw = 0;
    this.drivePitch = 0;
    // The weapon is stowed while riding; firing from inside is not implemented.
    this.viewmodel.setVisible(false);
  }

  private exitVehicle(): void {
    if (!this.ridingVehicle) return;
    const drop = this.ridingVehicle.exitWorldPosition();
    this.ridingVehicle.exit(this.player);
    // Put the player down beside the car, on the actual ground.
    const ground = this.streamer.groundAt(drop.x, drop.z);
    this.player.respawnKeepingHealth(new THREE.Vector3(drop.x, (ground ?? drop.y) + 0.2, drop.z));
    this.engineLoop?.stop(0.3);
    this.engineLoop = null;
    this.ridingVehicle = null;
    this.ridingSeat = -1;
    this.viewmodel.setVisible(true);
  }

  /** Drives the vehicle and keeps the player glued to their seat. */
  private updateDriving(dt: number): void {
    const vehicle = this.ridingVehicle;
    if (!vehicle) return;

    const isDriver = vehicle.def.seats[this.ridingSeat]?.role === 'driver';
    vehicle.setInput(
      isDriver && !vehicle.destroyed
        ? {
            throttle: Math.max(Number(input.actionDown('forward')), Math.max(0, input.padMove.forward)),
            brake: Math.max(Number(input.actionDown('back')), Math.max(0, -input.padMove.forward)),
            steer: Number(input.actionDown('left')) - Number(input.actionDown('right')) - input.padMove.strafe,
            handbrake: input.actionDown('jump'),
          }
        : { throttle: 0, brake: 0, steer: 0, handbrake: false },
    );

    if (isDriver && input.actionPressed('vehicleRecover') && vehicle.isUpsideDown) vehicle.recover();
    if (input.actionPressed('vehicleCamera')) this.firstPersonDrive = !this.firstPersonDrive;

    // The player rides the seat; their own controller is parked meanwhile.
    if (this.engineLoop) {
      this.engineLoop.setPlaybackRate(GameAudio.engineRate(vehicle.rpmValue, 800, 6200));
      this.engineLoop.setPosition(vehicle.position);
    }

    const seatPos = vehicle.seatWorldPosition(this.ridingSeat);
    this.player.controller.setPosition(new THREE.Vector3(seatPos.x, seatPos.y - 1.0, seatPos.z));

    if (vehicle.destroyed) this.exitVehicle();
    void dt;
  }

  /** Loot on the ground, the mission board, the panels and the save. */
  private async setupEconomyAndMissions(): Promise<void> {
    this.lootField = new LootField({
      scene: this.ctx.render.scene,
      groundAt: (x, z) => this.streamer.groundAt(x, z) ?? this.terrain.heightAt(x, z),
    });
    for (const poi of this.layout.pois) this.lootField.spawnAtPoi(poi);

    // The safe zone is the village: the one place with a bank and an arsenal,
    // which is what makes walking home with a full bag a decision.
    const home = this.layout.pois.find((poi) => poi.kind === SAFE_ZONE.poiKind);
    if (home) {
      // The zone has to cover the whole village, not a disc at its centre: the
      // player spawns at the village edge, so a smaller radius would start and
      // respawn them outside it, with the arsenal refusing service and no
      // visible reason why.
      this.safeZone = {
        x: home.x,
        z: home.z,
        radius: Math.max(SAFE_ZONE.radiusMeters, home.radius),
      };
    }

    const missionWorld: MissionWorld = {
      pois: this.layout.pois.map((poi) => ({
        id: poi.id,
        name: poi.name,
        kind: poi.kind,
        x: poi.x,
        z: poi.z,
        radius: poi.radius,
      })),
      roads: this.layout.roads.map((road) => ({
        ax: road.ax,
        az: road.az,
        bx: road.bx,
        bz: road.bz,
      })),
      halfExtent: WorldCfg.sizeMeters / 2,
      homeX: this.spawn.x,
      homeZ: this.spawn.z,
    };

    this.director = new MissionDirector(WorldCfg.seed, missionWorld, {
      onSpawn: (mission) => this.onMissionSpawned(mission),
      onCompleted: (mission) => this.onMissionCompleted(mission),
      onEnd: (mission) => this.onMissionEnded(mission),
    });
    this.director.start();

    this.mapPanel = new MapPanel(
      this.terrain,
      this.layout.pois,
      this.layout.roads,
      WorldCfg.sizeMeters / 2,
    );
    this.inventoryPanel = new InventoryPanel(this.inventory, this.wallet, {
      use: (id) => this.useItem(id),
      drop: (id) => void this.inventory.remove(id, 1),
      inSafeZone: () => this.isInSafeZone(),
      deposit: () => {
        const moved = this.wallet.deposit();
        this.showToast(`Depositado $${moved}.`);
      },
    });
    this.shopPanel = new ShopPanel(() => this.shopContext());
    this.optionsPanel = new OptionsPanel(this.audio.mixer, {
      settings: () => this.settings,
      apply: (partial) => this.applySettings(partial),
      save: () => void this.persist(),
    });
    this.deathScreen = new DeathScreen();
    this.deathScreen.onRespawn = () => this.respawnPlayer();
    for (const panel of [this.mapPanel, this.inventoryPanel, this.shopPanel, this.optionsPanel]) {
      panel.onClose = () => void input.requestLock();
    }

    await this.restoreSave();
  }

  /** Pushes a settings change into the systems that own it. */
  private applySettings(partial: Partial<GameSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.ctx.render.setQuality(this.settings.quality as Quality);
    this.ctx.render.setFov(this.settings.fov);
    this.streamer.setQuality?.(this.settings.quality);
  }

  private shopContext(): ShopContext {
    return {
      wallet: this.wallet,
      inventory: this.inventory,
      inSafeZone: this.isInSafeZone(),
      ownsWeapon: (id) => this.ownedWeapons.has(id) || this.loadout.all.some((s) => s.weapon.id === id),
      grantWeapon: (id) => {
        this.ownedWeapons.add(id);
        this.loadout.addWeapon(id);
        this.showToast('Arma adicionada ao arsenal.');
      },
      grantVehicle: (id) => this.deliverVehicle(id),
    };
  }

  private isInSafeZone(): boolean {
    if (!this.safeZone) return false;
    const p = this.player.position;
    return Math.hypot(p.x - this.safeZone.x, p.z - this.safeZone.z) <= this.safeZone.radius;
  }

  /** A bought vehicle is parked at the edge of the safe zone. */
  private deliverVehicle(typeId: string): boolean {
    if (!this.safeZone) return false;
    const angle = this.vehicles.length * 0.7;
    const x = this.safeZone.x + Math.cos(angle) * (this.safeZone.radius * 0.75);
    const z = this.safeZone.z + Math.sin(angle) * (this.safeZone.radius * 0.75);
    const ground = this.streamer.groundAt(x, z);
    if (ground === null) return false;
    void Vehicle.spawn(
      this.ctx.physics,
      this.ctx.render.scene,
      typeId,
      new THREE.Vector3(x, ground + 0.4, z),
      -angle,
    ).then((vehicle) => this.vehicles.push(vehicle));
    this.showToast('Veículo entregue na zona segura.');
    return true;
  }

  /** Consumables. Returns the line to show, or null when nothing happened. */
  private useItem(id: string): string | null {
    const def = itemDef(id);
    if (!def || !this.inventory.has(id)) return null;

    if (def.fuelLitres) {
      const vehicle = this.vehicleInReach();
      if (!vehicle) return 'Nenhum veículo por perto.';
      vehicle.refuel(def.fuelLitres);
      this.inventory.remove(id, 1);
      return `Abastecido +${def.fuelLitres} L.`;
    }
    if (def.repairs) {
      const vehicle = this.vehicleInReach();
      if (!vehicle) return 'Nenhum veículo por perto.';
      vehicle.engineHealth = Math.min(100, vehicle.engineHealth + def.repairs);
      this.inventory.remove(id, 1);
      return `Motor reparado para ${vehicle.engineHealth.toFixed(0)}%.`;
    }
    if (def.healsZone) {
      const healed = this.player.health.heal(def.healsZone, def.stopsBleeding === true);
      if (!healed) return 'Nada para tratar.';
      this.inventory.remove(id, 1);
      return def.stopsBleeding ? 'Ferimento tratado.' : 'Recuperado.';
    }
    return null;
  }

  // ---- Missões -----------------------------------------------------------

  private onMissionSpawned(mission: ActiveMission): void {
    for (let i = 0; i < mission.spec.lootCaches; i++) {
      const angle = (i / Math.max(1, mission.spec.lootCaches)) * Math.PI * 2;
      const radius = mission.spec.radiusMeters * 0.5;
      const id = `${mission.spec.id}-caixa-${i}`;
      this.lootField.spawnCache(
        id,
        mission.spec.x + Math.cos(angle) * radius,
        mission.spec.z + Math.sin(angle) * radius,
        mission.spec.lootTier,
      );
      mission.cacheIds.push(id);
    }
  }

  private onMissionCompleted(mission: ActiveMission): void {
    this.audio.ui('mission');
    this.wallet.earn(mission.spec.reward);
    this.save.stats.missionsCompleted++;
    this.showToast(`${mission.spec.name} concluída · $${mission.spec.reward}`);
  }

  private onMissionEnded(mission: ActiveMission): void {
    const garrison = this.missionNpcs.get(mission.spec.id);
    if (garrison) {
      // The fight is over; its agents go with it rather than wandering the map.
      for (const npc of garrison) {
        npc.dispose();
        const index = this.npcs.indexOf(npc);
        if (index >= 0) this.npcs.splice(index, 1);
      }
      this.missionNpcs.delete(mission.spec.id);
    }
    if (mission.status === 'expired') this.showToast(`${mission.spec.name} expirou.`);
  }

  /**
   * Garrisons appear only once the player is close enough to matter.
   *
   * Spawning every mission's agents up front would put thirty NPCs on the AI
   * budget for fights nobody is having yet.
   */
  private async updateMissionGarrisons(): Promise<void> {
    const p = this.player.position;
    for (const mission of this.director.missions) {
      if (mission.status !== 'active') continue;
      if (this.missionNpcs.has(mission.spec.id)) continue;
      const distance = Math.hypot(p.x - mission.spec.x, p.z - mission.spec.z);
      if (distance > 320) continue;
      // Reserve the slot before awaiting, or the next tick spawns them twice.
      this.missionNpcs.set(mission.spec.id, []);
      const garrison = await this.spawnGarrison(mission);
      this.missionNpcs.set(mission.spec.id, garrison);
    }
  }

  private async spawnGarrison(mission: ActiveMission): Promise<Npc[]> {
    const deps = {
      physics: this.ctx.physics,
      scene: this.ctx.render.scene,
      ballistics: this.ballistics,
      navigator: this.navigator,
      cover: this.coverFinder,
      medium: this.effects2,
    };
    const weapons = aiConfig.spawn.weaponsBySkill as Record<string, string[]>;
    const list = weapons[mission.spec.enemySkill] ?? ['rifle_m4x'];
    const squad = new Squad(100 + this.squads.length);
    const garrison: Npc[] = [];

    for (let i = 0; i < mission.spec.enemyCount; i++) {
      const angle = (i / mission.spec.enemyCount) * Math.PI * 2;
      const radius = mission.spec.radiusMeters * 0.6;
      const x = mission.spec.x + Math.cos(angle) * radius;
      const z = mission.spec.z + Math.sin(angle) * radius;
      const ground = this.streamer.groundAt(x, z) ?? this.terrain.heightAt(x, z);
      const npc = await Npc.spawn(
        deps,
        new THREE.Vector3(x, ground, z),
        mission.spec.enemySkill as SkillLevel,
        list[i % list.length]!,
        i,
      );
      npc.missionId = mission.spec.id;
      npc.squad = squad;
      squad.add(npc);
      this.npcs.push(npc);
      garrison.push(npc);
    }
    this.squads.push(squad);
    return garrison;
  }

  /** Turns freshly dead agents into lootable corpses and mission progress. */
  private harvestTheDead(): void {
    for (const npc of this.npcs) {
      if (npc.isAlive || this.harvested.has(npc.id)) continue;
      this.harvested.add(npc.id);
      this.save.stats.kills++;
      this.lootField.registerCorpse(`npc-${npc.id}`, npc.position, npc.skillLevel);
      if (npc.missionId) this.director.reportKill(npc.missionId);
    }
  }

  // ---- Interação e painéis ------------------------------------------------

  private anyPanelOpen(): boolean {
    return (
      this.mapPanel.isOpen ||
      this.inventoryPanel.isOpen ||
      this.shopPanel.isOpen ||
      this.optionsPanel.isOpen ||
      this.deathScreen.isOpen
    );
  }

  private handlePanelKeys(): void {
    // The death screen owns the input while it is up: dismissing it is the only
    // thing to do, and opening the map over a corpse reads as a bug.
    if (this.deathScreen.isOpen) return;
    const toggled =
      (input.actionPressed('map') && (this.mapPanel.toggle(), true)) ||
      (input.actionPressed('inventory') && (this.inventoryPanel.toggle(), true)) ||
      (input.actionPressed('shop') && (this.shopPanel.toggle(), true)) ||
      (input.actionPressed('options') && (this.optionsPanel.toggle(), true));
    if (toggled) this.audio.ui('click');
    if (input.pressed('Escape')) {
      const wasOpen = this.anyPanelOpen();
      this.mapPanel.hide();
      this.inventoryPanel.hide();
      this.shopPanel.hide();
      this.optionsPanel.hide();
      if (wasOpen) this.audio.ui('back');
    }
  }

  /** `E` looks for loot first, then a vehicle: the closer thing wins. */
  private handleInteraction(): void {
    if (this.ridingVehicle) {
      this.exitVehicle();
      return;
    }
    const loot = this.lootField.nearest(this.player.position);
    if (loot) {
      const result = loot.takeAll(this.inventory, this.wallet);
      this.audio.ui(result.items.length || result.money ? 'loot' : 'error');
      this.showToast(LootField.describe(result));
      return;
    }
    const vehicle = this.vehicleInReach();
    if (vehicle) this.enterVehicle(vehicle);
  }

  private interactionHint(): string {
    if (this.ridingVehicle) return 'E sair do veículo';
    const loot: LootSource | null = this.lootField.nearest(this.player.position);
    if (loot) return `E ${loot.label}`;
    if (this.vehicleInReach()) return 'E entrar no veículo';
    if (this.isInSafeZone()) {
      return this.wallet.carried > 0
        ? `Zona segura · I para depositar $${this.wallet.carried} · L arsenal`
        : 'Zona segura · L arsenal';
    }
    return '';
  }

  private showToast(text: string): void {
    this.toast = text;
    this.toastTimer = 3.5;
  }

  // ---- Save ---------------------------------------------------------------

  private async restoreSave(): Promise<void> {
    const loaded = await loadSave(WorldCfg.seed);
    if (!loaded) {
      this.showToast('Nova run. O banco começa com o saldo inicial.');
      return;
    }
    this.save = loaded;
    this.audio.mixer.load(loaded.settings.volumes);
    keybinds.load(loaded.settings.keybinds);
    this.applySettings({
      sensitivity: loaded.settings.sensitivity,
      fov: loaded.settings.fov,
      quality: loaded.settings.quality as Quality,
      invertY: loaded.settings.invertY,
    });
    this.wallet.bank = loaded.bank;
    this.wallet.carried = loaded.carried;
    this.inventory.load(loaded.inventory);
    for (const id of loaded.weapons) {
      this.ownedWeapons.add(id);
      this.loadout.addWeapon(id);
    }
    for (const [calibre, amount] of Object.entries(loaded.ammo)) {
      this.loadout.pouch.setReserve(calibre, amount);
    }
    const [x, y, z] = loaded.position;
    if (x !== 0 || z !== 0) {
      await this.streamer.warmup(new THREE.Vector3(x, y, z));
      const ground = this.streamer.groundAt(x, z);
      this.player.respawnKeepingHealth(new THREE.Vector3(x, (ground ?? y) + 0.5, z));
      this.player.yaw = loaded.yaw;
    }
    this.showToast(`Save carregado · banco $${loaded.bank}`);
  }

  private snapshot(): SaveState {
    const p = this.player.position;
    return {
      ...this.save,
      seed: WorldCfg.seed,
      bank: this.wallet.bank,
      carried: this.wallet.carried,
      position: [p.x, p.y, p.z],
      yaw: this.player.yaw,
      inventory: this.inventory.toJSON(),
      weapons: [...this.ownedWeapons],
      attachments: this.save.attachments,
      ammo: this.loadout.pouch.reserveSnapshot(),
      stats: { ...this.save.stats, moneyEarned: this.wallet.earned },
      settings: {
        volumes: this.audio.mixer.snapshot(),
        sensitivity: this.settings.sensitivity,
        fov: this.settings.fov,
        quality: this.settings.quality,
        invertY: this.settings.invertY,
        keybinds: keybinds.toJSON(),
      },
    };
  }

  private async persist(): Promise<void> {
    this.save = this.snapshot();
    await storeSave(this.save);
  }

  private registerDebug(): void {
    debugOverlay.registerSection('mundo', () => {
      const p = this.player.position;
      const near = this.layout.nearestPoi(p.x, p.z);
      return [
        `bioma ${this.terrain.biomeAt(p.x, p.z)}  altitude ${p.y.toFixed(1)} m`,
        `${near.poi.name} a ${near.distance.toFixed(0)} m`,
        this.streamer.debugText,
        this.pois.stats,
      ].join('\n');
    });
    debugOverlay.registerSection('audio', () =>
      [
        `contexto ${this.audio.isRunning ? 'ativo' : 'suspenso'}  vozes ${this.audio.sfx.voiceCount}`,
        `ducking ${(this.audio.mixer.duckAmount * 100).toFixed(0)}%  ${this.audio.inCombat ? 'combate' : 'exploração'}`,
        `gamepad ${input.padConnected ? 'conectado' : 'ausente'}`,
      ].join('\n'),
    );
    debugOverlay.registerSection('economia', () =>
      [
        `bolso $${this.wallet.carried}  banco $${this.wallet.bank}`,
        `mochila ${this.inventory.weightKg.toFixed(1)}/${this.inventory.capacityKg.toFixed(0)} kg`,
        `loot ${this.lootField.remaining}/${this.lootField.count} por abrir`,
        `missões ${this.director.activeCount} ativas`,
      ].join('\n'),
    );
    debugOverlay.registerSection('veiculo', () =>
      this.ridingVehicle
        ? this.ridingVehicle.debugText
        : `${this.vehicles.length} veiculos · ${this.vehicleInReach() ? 'E para entrar' : 'nenhum por perto'}`,
    );
    debugOverlay.registerSection(
      'ciclo',
      () => `${this.cycle.debugText}\n${this.effects2.debugText}`,
    );
    debugOverlay.registerSection('player', () => this.player.debugText);
    debugOverlay.registerSection(
      'arma',
      () => `${this.loadout.current.debugText}\n${this.loadout.pouch.debugText}\núltimo ${this.lastHit}`,
    );
    debugOverlay.registerToggle('KeyH', 'HUD', () => this.hudVisible, (v) => {
      this.hudVisible = v;
      this.hud.setVisible(v);
    });
    debugOverlay.registerToggle('KeyP', 'pausar ciclo dia/noite', () => this.cycle.paused, (v) => {
      this.cycle.paused = v;
    });
    debugOverlay.registerSection('ia', () => {
      const alive = this.npcs.filter((n) => n.isAlive).length;
      return [`agentes ${alive}/${this.npcs.length}`, ...this.squads.map((s) => s.debugText)].join(
        '\n',
      );
    });
    debugOverlay.registerToggle('KeyG', 'gizmos de IA', () => this.gizmosOn, (v) => {
      this.gizmosOn = v;
      this.gizmos.setEnabled(v);
    });
  }

  private shooterState() {
    return {
      stance: this.player.stance,
      moving: this.player.speed > 0.5,
      grounded: this.player.isGrounded,
      ads: this.player.ads,
      swayMultiplier: this.player.swayMultiplier,
      ignore: this.player.controller.collider,
    };
  }

  fixed(dt: number): void {
    const intent = readPlayerInput();
    if (this.anyPanelOpen()) {
      // The world keeps running while a panel is open, but the legs do not.
      intent.forward = 0;
      intent.strafe = 0;
      intent.jump = false;
      intent.sprint = false;
    }
    if (this.ridingVehicle) {
      // While riding, WASD drives the car instead of the legs.
      intent.forward = 0;
      intent.strafe = 0;
      intent.jump = false;
    }
    this.player.queueIntents(intent);
    this.player.fixed(dt, intent);

    this.handlePanelKeys();
    if (input.actionPressed('interact')) this.handleInteraction();
    this.updateDriving(dt);
    for (const vehicle of this.vehicles) {
      // A vehicle only simulates once there is ground beneath it.
      const p = vehicle.position;
      vehicle.dormant = this.streamer.groundAt(p.x, p.z) === null;
      vehicle.fixed(dt);
    }

    this.handleWeaponSwitching();
    if (input.pressed('KeyT')) this.cycle.timeScale = this.cycle.timeScale >= 60 ? 1 : 60;
    if (input.pressed('KeyY')) this.cycle.cycleWeather();

    const weapon = this.loadout.current;
    // Firing from inside a vehicle is not implemented, so the trigger is
    // dead while riding rather than shooting from an invisible weapon.
    const canShoot =
      input.locked && this.loadout.ready && !this.ridingVehicle && !this.anyPanelOpen();
    weapon.setTrigger(input.isMouseDown(MOUSE_LEFT) && canShoot);
    if (!this.ridingVehicle) {
      if (input.actionPressed('reload')) weapon.reload();
      if (input.actionPressed('fireMode')) weapon.cycleFireMode();
    }
    if (input.pressed('KeyF')) this.player.health.bandage();
    if (input.pressed('KeyK')) this.player.respawn(this.spawn);

    const origin = new THREE.Vector3();
    const eye = this.player.controller.eyePosition;
    origin.set(eye.x, eye.y, eye.z);
    const direction = new THREE.Vector3();
    this.ctx.render.camera.getWorldDirection(direction);

    const recoil = canShoot ? weapon.tryFire(origin, direction, this.shooterState()) : null;
    if (recoil) {
      this.player.pitch = Math.min(this.player.pitch + recoil.pitch, Math.PI / 2 - 0.02);
      this.player.yaw += recoil.yaw;
      this.viewmodel.addRecoil(recoil.pitch * 1.6, recoil.yaw * 1.6);
      this.muzzle.trigger(this.viewmodel.muzzleWorld());
      this.audio.shot(origin, weapon.def.class, this.shotEnvironment(), 0, true);
    }
    this.loadout.update(dt);

    this.ctx.physics.step();
    this.ballistics.update(dt);
    this.explosions.update(dt);
    for (const dummy of this.dummies) dummy.update(dt);

    this.water.applyDrowning(dt, eye.y, this.player.health);
    this.cycle.update(dt);
    this.effects2.update(dt);
    this.updateAi(dt, recoil !== null);
  }

  /** Feeds every agent its view of the world, then ticks squads and agents. */
  private updateAi(dt: number, playerFired: boolean): void {
    const eye = this.player.controller.eyePosition;
    const weapon = this.loadout.current;
    const target = {
      position: this.player.position.clone(),
      eyePosition: new THREE.Vector3(eye.x, eye.y, eye.z),
      stance: this.player.stance,
      speed: this.player.speed,
      isSprinting: this.player.speed > 5,
      firing: playerFired,
      firingSuppressed: weapon.def.suppressed,
      isAlive: this.player.health.alive,
    };
    const visibility = this.cycle.visibility;

    // A shot is a sound event carrying the weapon's own noise radius, so a
    // suppressor genuinely changes who comes looking.
    if (playerFired) {
      for (const npc of this.npcs) {
        if (npc.isAlive) npc.hearGunshot(target.eyePosition, weapon.def.noiseRadiusMeters);
      }
    }

    const positions = this.npcs.filter((n) => n.isAlive).map((n) => n.position);
    for (const npc of this.npcs) {
      if (!npc.isAlive) {
        npc.update(dt, 0);
        continue;
      }
      npc.blindness = this.effects2.blindnessOf(npc);
      npc.setContext(target, visibility, positions);
      npc.update(dt, npc.position.distanceTo(this.player.position));
    }
    for (const squad of this.squads) squad.update(dt);

    // Any agent that can see the player counts as contact for the music.
    if (this.npcs.some((npc) => npc.isAlive && npc.awareness === 'engaged')) {
      this.audio.reportContact();
    }

    this.harvestTheDead();
    this.director.update(dt, this.player.position);
    void this.updateMissionGarrisons();
    this.updatePlayerDeath();

    // Autosave on a timer rather than on every event: the write is cheap but
    // not free, and a run that saves twice a second stutters for nothing.
    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = 20;
      void this.persist();
    }
    this.save.stats.secondsPlayed += dt;
    if (this.toastTimer > 0) this.toastTimer -= dt;
  }

  /**
   * Death costs the pocket and the bag, never the bank.
   *
   * That is the whole risk curve of a run: everything looted is at stake until
   * it is deposited, and the bank is what makes a bad run survivable.
   */
  private updatePlayerDeath(): void {
    if (this.player.health.alive || this.awaitingRespawn) return;
    this.awaitingRespawn = true;
    const lost = this.wallet.die();
    const bagValue = this.inventory.value;
    this.inventory.clear();
    this.save.stats.deaths++;
    void this.audio.playDeathTrack();
    void this.persist();
    // Death interrupts whatever was open: two stacked panels leave the player
    // reading a shop over their own corpse, with Escape gated behind the death
    // screen and no obvious way back.
    this.mapPanel.hide();
    this.inventoryPanel.hide();
    this.shopPanel.hide();
    this.optionsPanel.hide();
    this.deathScreen.present({
      moneyLost: lost,
      gearLost: bagValue,
      bank: this.wallet.bank,
      killer: this.lastHit ? `último dano: ${this.lastHit}` : '',
      stats: this.save.stats,
    });
  }

  private respawnPlayer(): void {
    this.player.respawn(this.spawn);
    this.awaitingRespawn = false;
    void input.requestLock();
  }

  /** How close a round came to the player's ear, and how far the shooter was. */
  private playerCrackThump(from: THREE.Vector3, segment: THREE.Vector3, lengthSq: number): void {
    const ear = this.player.controller.eyePosition;
    const earVec = new THREE.Vector3(ear.x, ear.y, ear.z);
    const t = THREE.MathUtils.clamp(earVec.clone().sub(from).dot(segment) / lengthSq, 0, 1);
    const closest = from.clone().addScaledVector(segment, t);
    const miss = closest.distanceTo(earVec);
    if (miss > 8) return;
    this.audio.crackThump(closest, miss, from.distanceTo(earVec));
    // Being shot at is contact as far as the music is concerned.
    this.audio.reportContact();
  }

  /** Open ground, trees or walls — what the shot's tail should sound like. */
  private shotEnvironment(): ShotEnvironment {
    const p = this.player.position;
    if (this.layout.pois.some((poi) => Math.hypot(p.x - poi.x, p.z - poi.z) < poi.radius * 0.6)) {
      return 'interior';
    }
    return this.terrain.biomeAt(p.x, p.z) === 'floresta' ? 'floresta' : 'aberto';
  }

  private handleWeaponSwitching(): void {
    for (let i = 0; i < Math.min(9, this.loadout.count); i++) {
      if (input.pressed(`Digit${i + 1}`)) {
        this.loadout.select(i);
        return;
      }
    }
    if (input.pressed('KeyQ')) this.loadout.swapToPrevious();
    if (input.wheelDelta > 0) this.loadout.next();
    else if (input.wheelDelta < 0) this.loadout.prev();
  }

  frame(alpha: number, dt: number): void {
    this.lastLook.x = input.mouseDX;
    this.lastLook.y = input.mouseDY;
    this.player.applyLook(PlayerCfg.camera.sensitivity * this.settings.sensitivity, this.settings.invertY);
    this.player.updateCamera(this.ctx.render.camera, alpha, dt);

    const weapon = this.loadout.current;
    this.viewmodel.update(dt, {
      ads: this.player.ads && !this.loadout.isSwitching,
      speed: this.player.speed,
      grounded: this.player.isGrounded,
      swayMultiplier: this.player.swayMultiplier,
      lookDelta: this.lastLook,
      reload: weapon.isReloading ? weapon.reloadProgress : 0,
      switching: this.loadout.switchProgress,
    });

    profiler.begin('world');
    this.streamer.update(this.player.position);
    profiler.end('world');

    const fog = this.ctx.render.scene.fog as THREE.FogExp2;
    this.water.update(dt, fog.color, fog.density);
    this.effects.update(dt, this.ballistics);
    this.muzzle.update(dt);

    this.hud.update(this.player, weapon.spreadDegrees(this.shooterState()), weapon);
    this.hud.updateHotbar(this.loadout);
    this.hud.setHint(
      this.water.isUnderwater(this.player.controller.eyePosition.y)
        ? `AR ${(this.water.breathFraction * 100).toFixed(0)}%`
        : this.toastTimer > 0
          ? this.toast
          : this.interactionHint(),
    );
    this.hud.setWallet(this.wallet.carried, this.wallet.bank, this.isInSafeZone());
    this.hud.setMissions(this.director.trackerLines(this.player.position));
    this.mapPanel.setContext({
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
      playerYaw: this.player.yaw,
      missions: this.director.missions,
      safeZone: this.safeZone,
    });
    this.pointerHint.classList.toggle('hidden', input.locked);

    // Footsteps come from the travelled speed, so they stay in step with the
    // legs whether the player is walking, sprinting or sliding down a slope.
    const here = this.player.position;
    this.audio.footsteps(
      dt,
      here,
      this.ridingVehicle ? 0 : this.player.speed,
      this.terrain.biomeAt(here.x, here.z),
      this.player.isGrounded,
    );
    this.audio.update(dt, this.ctx.render.camera);

    this.ambienceTimer -= dt;
    if (this.ambienceTimer <= 0) {
      this.ambienceTimer = 2;
      void this.audio.setAmbience(this.terrain.biomeAt(here.x, here.z), this.cycle.isNight);
      void this.audio.updateMusic();
    }

    for (const vehicle of this.vehicles) vehicle.frame();
    this.applyVehicleCamera(dt);
    this.gizmos.update(this.npcs, this.ctx.render.camera);
    this.hud.setBlindness(this.effects2.blindnessOf(this.player));

    const p = this.player.position;
    this.ctx.render.followShadowTarget(p.x, p.y, p.z);
  }

  /**
   * Chase or cockpit camera while riding; on foot this does nothing.
   *
   * The orientation is built from explicit yaw/pitch rather than `lookAt`
   * followed by `rotateY`: after `lookAt` the camera's local axes are already
   * tilted, so rotating around them compounds the tilt and the view ends up
   * skewed the moment the car is not perfectly level.
   */
  private applyVehicleCamera(dt: number): void {
    const vehicle = this.ridingVehicle;
    if (!vehicle) return;
    const camera = this.ctx.render.camera;
    const cfg = vehicleConfig.defaults.camera;

    // Free-look is relative to the vehicle and clamped, so the view always
    // returns to looking where the car is going.
    const yawLimit = (cfg.freeLookYawLimitDegrees * Math.PI) / 180;
    const pitchLimit = (cfg.freeLookPitchLimitDegrees * Math.PI) / 180;
    if (input.locked) {
      this.driveYaw -= input.mouseDX * PlayerCfg.camera.sensitivity;
      this.drivePitch -= input.mouseDY * PlayerCfg.camera.sensitivity;
    }
    this.driveYaw = THREE.MathUtils.clamp(this.driveYaw, -yawLimit, yawLimit);
    this.drivePitch = THREE.MathUtils.clamp(this.drivePitch, -pitchLimit, pitchLimit);
    // Recentres when the mouse is still, like a head returning to the road.
    if (Math.abs(input.mouseDX) < 0.5) this.driveYaw *= Math.max(0, 1 - dt * 1.6);

    const yaw = vehicle.cameraYaw + this.driveYaw;
    const pitch = this.drivePitch;

    if (this.firstPersonDrive) {
      // Cockpit view comes from the occupant's actual seat, so it is correct
      // for every vehicle and every seat without a per-vehicle offset.
      const seat = vehicle.seatWorldPosition(this.ridingSeat);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(vehicle.root.quaternion);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(vehicle.root.quaternion);
      camera.position
        .copy(seat)
        .addScaledVector(up, cfg.firstPersonEyeHeight)
        .addScaledVector(forward, cfg.firstPersonForward);
    } else {
      const focus = vehicle.root.position.clone();
      focus.y += 1.0;
      // Orbit behind the car along the look direction.
      const back = new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch),
        -Math.sin(pitch),
        Math.cos(yaw) * Math.cos(pitch),
      );
      camera.position
        .copy(focus)
        .addScaledVector(back, cfg.thirdPersonDistance)
        .add(new THREE.Vector3(0, cfg.thirdPersonHeight, 0));
    }

    camera.rotation.set(0, 0, 0);
    camera.rotateY(yaw);
    camera.rotateX(pitch);
    if (!this.firstPersonDrive) {
      // Aim the chase camera slightly down at the car.
      camera.rotateX(-0.16);
    }
  }

  dispose(): void {
    for (const dummy of this.dummies) dummy.dispose();
    this.dummies.length = 0;
    this.streamer.dispose();
    this.pois.dispose();
    this.water.dispose();
    this.player.dispose();
    this.viewmodel.dispose();
    this.effects.dispose();
    this.explosions.dispose();
    this.muzzle.dispose();
    this.hud.dispose();
    this.pointerHint.remove();
    for (const npc of this.npcs) npc.dispose();
    this.npcs.length = 0;
    this.gizmos.dispose();
    this.effects2.dispose();
    for (const vehicle of this.vehicles) vehicle.dispose();
    this.vehicles.length = 0;
    this.lootField.dispose();
    this.mapPanel.dispose();
    this.inventoryPanel.dispose();
    this.shopPanel.dispose();
    this.optionsPanel.dispose();
    this.deathScreen.dispose();
    this.audio.dispose();
    for (const name of ['mundo', 'ciclo', 'player', 'arma', 'ia', 'veiculo', 'economia', 'audio']) {
      debugOverlay.removeSection(name);
    }
  }
}
