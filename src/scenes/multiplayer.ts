import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { World as WorldCfg } from '../core/config';
import { input, MOUSE_LEFT } from '../core/input';
import { debugOverlay } from '../debug/overlay';
import { assets } from '../core/assets';
import { CharacterAnimator } from '../anim/characterAnimator';
import { NetClient } from '../net/client';
import { INTERPOLATION_DELAY_MS, type PlayerState } from '../net/protocol';
import { eyeHeightOf } from '../net/movement';
import { Terrain } from '../world/terrain';
import { WorldLayout } from '../world/layout';
import { TerrainStreamer } from '../world/streamer';
import { DayNightCycle } from '../world/daynight';

const BODY_ID = 'animated-characters-bundle/character-medium';
const BODY_HEIGHT_METRES = 1.78;
const DEFAULT_URL = 'ws://localhost:8787';

interface RemoteAvatar {
  root: THREE.Group;
  animator: CharacterAnimator | null;
  lastState: PlayerState | null;
}

/**
 * Multiplayer scene: `?scene=mp` (optionally `&server=ws://host:port`).
 *
 * Separate from the single-player world on purpose. The world scene moves the
 * player with a Rapier capsule, which the server cannot reproduce without
 * shipping a physics world and the whole map; here the local player runs the
 * *same* deterministic model the server does, which is the only way prediction
 * and authority can agree. Merging the two so one controller serves both is the
 * work this scene leaves behind — it is written up in PROGRESS.md rather than
 * hidden.
 */
export class MultiplayerScene implements Scene {
  readonly name = 'mp';
  private ctx!: SceneContext;
  private terrain!: Terrain;
  private layout!: WorldLayout;
  private streamer!: TerrainStreamer;
  private cycle!: DayNightCycle;
  private net!: NetClient;

  private readonly avatars = new Map<number, RemoteAvatar>();
  private readonly pendingAvatars = new Set<number>();
  private yaw = 0;
  private pitch = 0;
  private sinceInput = 0;
  private sincePing = 0;
  private status = 'conectando…';
  private lastHit = '—';
  private hud!: HTMLDivElement;

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;
    this.terrain = new Terrain({
      seed: WorldCfg.seed,
      sizeMeters: WorldCfg.sizeMeters,
      heightScale: WorldCfg.heightScale,
      waterLevel: WorldCfg.waterLevel,
    });
    this.layout = new WorldLayout(this.terrain);
    this.streamer = new TerrainStreamer(ctx.render.scene, ctx.physics, this.terrain, this.layout);
    await this.streamer.prepare();
    this.cycle = new DayNightCycle(ctx.render);

    const ground = (x: number, z: number): number => this.terrain.heightAt(x, z);
    this.net = new NetClient(ground, {
      onWelcome: (id) => {
        this.status = `conectado como jogador ${id}`;
      },
      onReject: (reason) => {
        this.status = `recusado: ${reason}`;
      },
      onHit: (targetId, damage, zone, killed) => {
        this.lastHit = `acertou ${targetId} · ${zone} · ${damage}${killed ? ' · abate' : ''}`;
      },
      onDamaged: (byId, damage) => {
        this.lastHit = `levou ${damage} de ${byId}`;
      },
      onLeft: (id) => this.removeAvatar(id),
      onDisconnect: () => {
        this.status = 'desconectado';
      },
    });

    const url = new URLSearchParams(location.search).get('server') ?? DEFAULT_URL;
    this.status = `conectando a ${url}…`;
    this.net.connect(url, `jogador-${Math.floor(Math.random() * 1000)}`);

    await this.streamer.warmup(new THREE.Vector3(this.net.body.x, 0, this.net.body.z));
    this.buildHud();
    this.registerDebug();
  }

  private buildHud(): void {
    this.hud = document.createElement('div');
    this.hud.id = 'mp-hud';
    this.hud.style.cssText =
      'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:20;' +
      'font:12px/1.5 ui-monospace,monospace;color:#e8e2d2;background:rgba(12,14,16,.55);' +
      'padding:6px 12px;border-radius:4px;text-align:center;pointer-events:none';
    document.body.append(this.hud);
  }

  private registerDebug(): void {
    debugOverlay.registerSection('rede', () =>
      [this.status, this.net.debugText, `último: ${this.lastHit}`].join('\n'),
    );
  }

  /** A remote player's body, loaded once and then reused. */
  private async ensureAvatar(id: number): Promise<void> {
    if (this.avatars.has(id) || this.pendingAvatars.has(id)) return;
    this.pendingAvatars.add(id);
    const root = new THREE.Group();
    this.ctx.render.scene.add(root);
    // Registered before the model resolves, so a second snapshot in the same
    // frame cannot start a duplicate load.
    this.avatars.set(id, { root, animator: null, lastState: null });

    try {
      const scale = assets.scaleToHeight(BODY_ID, BODY_HEIGHT_METRES);
      const model = await assets.instantiate(BODY_ID, { scale });
      root.add(model);
      const clips = assets.clips(BODY_ID);
      const avatar = this.avatars.get(id);
      if (avatar && clips.length) {
        avatar.animator = new CharacterAnimator(model, clips);
        avatar.animator.set('idle', 'aim');
      }
    } catch {
      /* A missing model leaves an invisible but still-tracked player. */
    } finally {
      this.pendingAvatars.delete(id);
    }
  }

  private removeAvatar(id: number): void {
    const avatar = this.avatars.get(id);
    if (!avatar) return;
    this.ctx.render.scene.remove(avatar.root);
    avatar.animator?.dispose();
    this.avatars.delete(id);
  }

  fixed(dt: number): void {
    this.sinceInput += dt;
    this.sincePing += dt;

    // Inputs go out at the server's tick rate, not at render rate: sending 180
    // commands a second to a 30 Hz server only inflates the queue.
    if (this.sinceInput >= 1 / 30) {
      const cmd = {
        dt: this.sinceInput,
        forward: Number(input.actionDown('forward')) - Number(input.actionDown('back')),
        strafe: Number(input.actionDown('right')) - Number(input.actionDown('left')),
        yaw: this.yaw,
        pitch: this.pitch,
        jump: input.actionDown('jump'),
        sprint: input.actionDown('sprint'),
        crouch: input.actionDown('crouch'),
      };
      this.sinceInput = 0;
      if (this.net.connected) this.net.sendInput(cmd);
    }

    if (this.sincePing >= 1) {
      this.sincePing = 0;
      if (this.net.connected) this.net.ping();
    }

    if (input.mousePressed(MOUSE_LEFT) && this.net.connected && input.locked) this.shoot();
  }

  /** Fires at whatever the crosshair is on, from the server-known eye. */
  private shoot(): void {
    const camera = this.ctx.render.camera;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    this.net.fire({
      ox: this.net.body.x,
      oy: this.net.body.y + eyeHeightOf(this.net.body),
      oz: this.net.body.z,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      weapon: 'rifle_m4x',
      damage: 30,
      rangeMeters: 300,
    });
  }

  frame(_alpha: number, dt: number): void {
    this.net.update(dt * 1000);

    if (input.locked) {
      const sensitivity = 0.0022;
      this.yaw -= input.mouseDX * sensitivity;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - input.mouseDY * sensitivity,
        -Math.PI / 2 + 0.02,
        Math.PI / 2 - 0.02,
      );
    }

    const body = this.net.body;
    const camera = this.ctx.render.camera;
    camera.position.set(body.x, body.y + eyeHeightOf(body), body.z);
    camera.rotation.set(0, 0, 0);
    camera.rotateY(this.yaw);
    camera.rotateX(this.pitch);

    this.streamer.update(new THREE.Vector3(body.x, body.y, body.z));
    this.cycle.update(dt);

    for (const state of this.net.remoteStates()) {
      void this.ensureAvatar(state.id);
      const avatar = this.avatars.get(state.id);
      if (!avatar) continue;
      avatar.root.position.set(state.x, state.y, state.z);
      // Remote yaw is the direction they walk; the model faces +Z.
      avatar.root.rotation.y = state.yaw + Math.PI;
      avatar.lastState = state;
      if (avatar.animator) {
        avatar.animator.set(state.speed > 0.3 ? 'walk' : 'idle', 'aim');
        avatar.animator.update(dt);
      }
    }

    this.hud.textContent =
      `${this.status} · rtt ${this.net.roundTripMs.toFixed(0)} ms · ` +
      `${this.avatars.size} remoto(s) · atraso ${INTERPOLATION_DELAY_MS} ms · ` +
      `correções ${this.net.correctionCount} · ${this.lastHit}`;
  }

  dispose(): void {
    this.net.disconnect();
    for (const id of [...this.avatars.keys()]) this.removeAvatar(id);
    this.streamer.dispose();
    this.hud.remove();
  }
}
