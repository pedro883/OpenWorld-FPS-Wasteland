import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { Player, readPlayerInput } from '../entities/player';
import { ZONES, type Zone } from '../entities/health';
import { Viewmodel } from '../render/viewmodel';
import { Hud } from '../ui/hud';
import { assets } from '../core/assets';
import { input } from '../core/input';
import { Layer } from '../physics/world';
import { debugOverlay } from '../debug/overlay';
import { Player as PlayerCfg } from '../core/config';

// Clear of every obstacle, facing -Z so the whole course is ahead on spawn.
const START = new THREE.Vector3(4, 1, 24);

/** Keys 1..6 damage the matching zone, so the wound model can be exercised. */
const DAMAGE_KEYS: Array<[string, Zone]> = [
  ['Digit1', 'head'],
  ['Digit2', 'torso'],
  ['Digit3', 'armLeft'],
  ['Digit4', 'armRight'],
  ['Digit5', 'legLeft'],
  ['Digit6', 'legRight'],
];

/**
 * Obstacle course for the character controller: slopes at increasing angles,
 * a staircase of increasing step heights, a mantle ledge and a prone crawl.
 */
export class PlayerTestScene implements Scene {
  readonly name = 'player';
  private ctx!: SceneContext;
  private player!: Player;
  private viewmodel!: Viewmodel;
  private hud!: Hud;
  private pointerHint!: HTMLDivElement;
  private readonly trash: Array<{ dispose(): void }> = [];
  private lastLook = { x: 0, y: 0 };

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;
    this.buildCourse();

    this.player = new Player(ctx.physics, START);
    this.player.yaw = 0;

    this.viewmodel = new Viewmodel(ctx.render);
    await this.viewmodel.setWeapon('rifle_m4x');

    this.hud = new Hud();

    this.pointerHint = document.createElement('div');
    this.pointerHint.id = 'pointer-hint';
    this.pointerHint.textContent = 'Clique para jogar  ·  WASD mover  ·  C agachar  ·  X deitar  ·  F1 debug';
    this.pointerHint.addEventListener('click', () => void input.requestLock());
    document.body.appendChild(this.pointerHint);

    debugOverlay.registerSection('player', () => this.player.debugText);
    debugOverlay.registerSection('saude', () => this.player.health.debugText);
    debugOverlay.registerToggle(
      'KeyH',
      'HUD',
      () => this.hudVisible,
      (v) => {
        this.hudVisible = v;
        this.hud.setVisible(v);
      },
    );
  }

  private hudVisible = true;

  private addBox(
    size: [number, number, number],
    pos: [number, number, number],
    color: number,
    rotationX = 0,
  ): THREE.Mesh {
    const [w, h, d] = size;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.x = rotationX;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.ctx.render.scene.add(mesh);
    this.trash.push(geo, mat);

    const { collider } = this.ctx.physics.addCuboid(
      w / 2,
      h / 2,
      d / 2,
      { x: pos[0], y: pos[1], z: pos[2] },
      Layer.STATIC,
      0xffff,
    );
    if (rotationX !== 0) {
      collider.parent()?.setRotation(
        { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
        true,
      );
    }
    return mesh;
  }

  private buildCourse(): void {
    this.addBox([90, 1, 90], [0, -0.5, 0], 0x55603f);

    const grid = new THREE.GridHelper(90, 90, 0x8a9aa5, 0x424c53);
    grid.position.y = 0.01;
    this.ctx.render.scene.add(grid);
    this.trash.push(grid);

    // Slopes at 15, 25, 35, 45 and 55 degrees, rising away from the spawn. The
    // config caps climbing at 50, so the last one must refuse the player —
    // that rejection is the actual assertion this obstacle makes.
    // Rotating +X about the X axis drops the +Z end, putting the low end
    // towards the player and the ramp rising into -Z.
    const angles = [15, 25, 35, 45, 55];
    const rampLength = 10;
    const rampThickness = 0.5;
    angles.forEach((deg, i) => {
      const rad = (deg * Math.PI) / 180;
      // Put the *top surface* of the near end flush with the ground. Centring
      // the slab instead leaves a lip that is taller than the autostep height,
      // and the ramp then fails for a reason that has nothing to do with slope.
      const centreY =
        0.02 + (rampLength / 2) * Math.sin(rad) - rampThickness / 2 / Math.cos(rad);
      this.addBox([6, rampThickness, rampLength], [-30 + i * 7, centreY, -8], 0x6d6252, rad);
    });

    // Stairs: steps from below to above the autostep height, so the boundary of
    // the mantle behaviour is directly observable.
    const stepHeights = [0.2, 0.35, 0.45, 0.55, 0.7];
    stepHeights.forEach((h, i) => {
      for (let s = 0; s < 4; s++) {
        // The player arrives from +Z, so the lowest tread has to be the nearest
        // one; ordering them the other way just builds a wall.
        const z = 10.8 - s * 1.6;
        this.addBox([3, h, 1.6], [-24 + i * 6, (s + 0.5) * h, z], 0x7a6f5c);
      }
    });

    // Mantle ledge and a prone-only crawl space.
    this.addBox([8, 0.45, 2], [14, 0.22, -4], 0x8a7b63);
    this.addBox([8, 0.4, 6], [14, 1.05, -12], 0x69614f);
    this.addBox([0.6, 1.05, 6], [10.3, 0.52, -12], 0x69614f);
    this.addBox([0.6, 1.05, 6], [17.7, 0.52, -12], 0x69614f);

    // A wall to test that blocked motion kills horizontal speed.
    this.addBox([14, 3, 0.6], [0, 1.5, -26], 0x5c5f66);

    void this.decorate();
  }

  /** Kenney props, purely so the scale reads correctly while moving around. */
  private async decorate(): Promise<void> {
    const props: Array<[string, THREE.Vector3]> = [
      ['survival-kit/barrel', new THREE.Vector3(3, 0, 2)],
      ['survival-kit/barrel', new THREE.Vector3(3.7, 0, 2.6)],
      ['survival-kit/box-large', new THREE.Vector3(-4, 0, 1)],
      ['car-kit/sedan', new THREE.Vector3(-10, 0, -2)],
      ['nature-kit/tree_default', new THREE.Vector3(22, 0, 10)],
      ['nature-kit/tree_pineDefaultA', new THREE.Vector3(-20, 0, -8)],
      ['mini-characters/character-female-a', new THREE.Vector3(1.5, 0, 4)],
    ];
    for (const [id, pos] of props) {
      if (!assets.entry(id)) continue;
      const model = await assets.instantiate(id);
      model.position.copy(pos);
      this.ctx.render.scene.add(model);
    }
  }

  fixed(dt: number): void {
    const intent = readPlayerInput();
    this.player.queueIntents(intent);
    this.player.fixed(dt, intent);
    this.ctx.physics.step();

    for (const [code, zone] of DAMAGE_KEYS) {
      if (input.pressed(code)) this.player.health.applyDamage(zone, 22);
    }
    if (input.pressed('KeyF')) this.player.health.bandage();
    if (input.pressed('KeyR') || !this.player.health.alive) {
      if (input.pressed('KeyR')) this.player.respawn(START);
    }
  }

  frame(alpha: number, dt: number): void {
    this.lastLook.x = input.mouseDX;
    this.lastLook.y = input.mouseDY;
    this.player.applyLook();
    this.player.updateCamera(this.ctx.render.camera, alpha, dt);

    this.viewmodel.update(dt, {
      ads: this.player.ads,
      speed: this.player.speed,
      grounded: this.player.isGrounded,
      swayMultiplier: this.player.swayMultiplier,
      lookDelta: this.lastLook,
    });

    const spread = this.currentSpread();
    this.hud.update(this.player, spread);
    this.pointerHint.classList.toggle('hidden', input.locked);

    const p = this.player.position;
    this.ctx.render.followShadowTarget(p.x, p.y, p.z);
  }

  /** Placeholder until phase 3 owns dispersion; drives the crosshair gap. */
  private currentSpread(): number {
    const base = { stand: 1.7, crouch: 1.15, prone: 0.72 }[this.player.stance];
    const moving = this.player.speed > 0.5 ? 2.3 : 1;
    const air = this.player.isGrounded ? 1 : 4;
    return base * moving * air * (this.player.ads ? 0.22 : 1) * this.player.swayMultiplier;
  }

  dispose(): void {
    this.player.dispose();
    this.viewmodel.dispose();
    this.hud.dispose();
    this.pointerHint.remove();
    for (const item of this.trash) item.dispose();
    this.trash.length = 0;
    debugOverlay.removeSection('player');
    debugOverlay.removeSection('saude');
  }
}

export { PlayerCfg, ZONES };
