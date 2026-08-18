import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { World as WorldCfg } from '../core/config';
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
    this.ballistics.onImpact = this.effects.handleImpact;
    this.ballistics.onExplosion = this.explosions.handle;
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
      'Clique para jogar · WASD · Shift correr · C/X postura · 1-5 armas · T hora · Y clima · F1 debug';
    this.pointerHint.addEventListener('click', () => void input.requestLock());
    document.body.appendChild(this.pointerHint);

    // Build the POIs before the first frame so the village is never empty.
    this.pois = new PoiBuilder(ctx.render.scene, ctx.physics, this.layout);
    await this.pois.buildAll();
    await this.spawnPatrol();

    this.navigator = new Navigator(ctx.physics, this.terrain);
    this.coverFinder = new CoverFinder(ctx.physics, this.terrain);
    this.gizmos = new AiGizmos(ctx.render.scene);
    await this.spawnSquads();

    // A round passing close to an agent is what suppression is made of.
    this.ballistics.onPass = (from, to, shooter) => this.applySuppression(from, to, shooter);

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
    this.player.queueIntents(intent);
    this.player.fixed(dt, intent);

    this.handleWeaponSwitching();
    if (input.pressed('KeyT')) this.cycle.timeScale = this.cycle.timeScale >= 60 ? 1 : 60;
    if (input.pressed('KeyY')) this.cycle.cycleWeather();

    const weapon = this.loadout.current;
    weapon.setTrigger(input.isMouseDown(MOUSE_LEFT) && input.locked && this.loadout.ready);
    if (input.pressed('KeyR')) weapon.reload();
    if (input.pressed('KeyB')) weapon.cycleFireMode();
    if (input.pressed('KeyF')) this.player.health.bandage();
    if (input.pressed('KeyK')) this.player.respawn(this.spawn);

    const origin = new THREE.Vector3();
    const eye = this.player.controller.eyePosition;
    origin.set(eye.x, eye.y, eye.z);
    const direction = new THREE.Vector3();
    this.ctx.render.camera.getWorldDirection(direction);

    const recoil = this.loadout.ready
      ? weapon.tryFire(origin, direction, this.shooterState())
      : null;
    if (recoil) {
      this.player.pitch = Math.min(this.player.pitch + recoil.pitch, Math.PI / 2 - 0.02);
      this.player.yaw += recoil.yaw;
      this.viewmodel.addRecoil(recoil.pitch * 1.6, recoil.yaw * 1.6);
      this.muzzle.trigger(this.viewmodel.muzzleWorld());
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
    this.player.applyLook();
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
        : '',
    );
    this.pointerHint.classList.toggle('hidden', input.locked);

    this.gizmos.update(this.npcs, this.ctx.render.camera);
    this.hud.setBlindness(this.effects2.blindnessOf(this.player));

    const p = this.player.position;
    this.ctx.render.followShadowTarget(p.x, p.y, p.z);
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
    for (const name of ['mundo', 'ciclo', 'player', 'arma', 'ia']) {
      debugOverlay.removeSection(name);
    }
  }
}
