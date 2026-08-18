import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { Player, readPlayerInput } from '../entities/player';
import type { Zone } from '../entities/health';
import { TargetDummy } from '../entities/targetDummy';
import { Viewmodel } from '../render/viewmodel';
import { Hud } from '../ui/hud';
import { assets } from '../core/assets';
import { input, MOUSE_LEFT } from '../core/input';
import { Layer } from '../physics/world';
import { debugOverlay } from '../debug/overlay';
import { BallisticsSystem } from '../combat/ballistics';
import { ImpactEffects, MuzzleFlash } from '../combat/impacts';
import { Weapon } from '../combat/weapon';
import { World as WorldCfg } from '../core/config';

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

/** Panels the player can shoot to see penetration behave per material. */
const PANELS: Array<{ material: string; x: number; thickness: number; color: number }> = [
  { material: 'wood', x: 24, thickness: 0.12, color: 0x8a6a3f },
  { material: 'sandbag', x: 28, thickness: 0.35, color: 0x9a8c62 },
  { material: 'metal', x: 32, thickness: 0.06, color: 0x8d949c },
  { material: 'concrete', x: 36, thickness: 0.3, color: 0x9a9a95 },
];

/**
 * Playable scene for phases 2 and 3: the movement obstacle course plus a range
 * with targets at graded distances and a penetration wall.
 */
export class PlayerTestScene implements Scene {
  readonly name = 'player';
  private ctx!: SceneContext;
  private player!: Player;
  private viewmodel!: Viewmodel;
  private hud!: Hud;
  private weapon!: Weapon;
  private ballistics!: BallisticsSystem;
  private effects!: ImpactEffects;
  private muzzle!: MuzzleFlash;
  private pointerHint!: HTMLDivElement;
  private readonly dummies: TargetDummy[] = [];
  private readonly trash: Array<{ dispose(): void }> = [];
  private readonly lastLook = { x: 0, y: 0 };
  private hudVisible = true;
  private lastHit = 'nenhum';
  private hitCount = 0;
  private shotCount = 0;

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;

    this.ballistics = new BallisticsSystem(ctx.physics, WorldCfg.gravity);
    this.effects = new ImpactEffects(ctx.render.scene);
    this.muzzle = new MuzzleFlash(ctx.render.scene);
    this.ballistics.onImpact = this.effects.handleImpact;
    this.ballistics.onDamage = (e) => {
      this.hitCount++;
      this.lastHit = `${e.zone} · ${e.amount.toFixed(0)} dano · ${e.distance.toFixed(0)} m`;
      this.hud.flashHit(e.zone === 'head');
    };

    this.buildCourse();

    this.player = new Player(ctx.physics, START);
    this.player.yaw = 0;

    this.weapon = new Weapon('rifle_m4x', this.ballistics, this.player);

    this.viewmodel = new Viewmodel(ctx.render);
    await this.viewmodel.setWeapon('rifle_m4x');

    this.hud = new Hud();

    this.pointerHint = document.createElement('div');
    this.pointerHint.id = 'pointer-hint';
    this.pointerHint.textContent =
      'Clique para jogar · WASD mover · C agachar · X deitar · Botão dir. mirar · R recarregar · B modo de tiro · F1 debug';
    this.pointerHint.addEventListener('click', () => void input.requestLock());
    document.body.appendChild(this.pointerHint);

    await this.spawnTargets();

    debugOverlay.registerSection('player', () => this.player.debugText);
    debugOverlay.registerSection('saude', () => this.player.health.debugText);
    debugOverlay.registerSection('arma', () => this.weapon.debugText);
    debugOverlay.registerSection(
      'tiro',
      () =>
        `dispersão ${this.weapon.spreadDegrees(this.shooterState()).toFixed(2)}°\n` +
        `projéteis ativos ${this.ballistics.activeCount}\n` +
        `tiros ${this.shotCount}  acertos ${this.hitCount}\n` +
        `último ${this.lastHit}\n` +
        this.dummies.map((d, i) => `alvo ${i + 1}: ${d.statusText}`).join('\n'),
    );
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

  private addBox(
    size: [number, number, number],
    pos: [number, number, number],
    color: number,
    rotationX = 0,
    material = 'concrete',
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
    this.ctx.physics.own(collider, { kind: 'surface', material });
    if (rotationX !== 0) {
      collider.parent()?.setRotation(
        { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
        true,
      );
    }
    return mesh;
  }

  private buildCourse(): void {
    this.addBox([200, 1, 200], [0, -0.5, 0], 0x55603f, 0, 'dirt');

    const grid = new THREE.GridHelper(120, 120, 0x8a9aa5, 0x424c53);
    grid.position.y = 0.01;
    this.ctx.render.scene.add(grid);
    this.trash.push(grid);

    // Slopes at 15..55 degrees, rising away from the spawn. The config caps
    // climbing at 50, so the last one must refuse the player.
    const angles = [15, 25, 35, 45, 55];
    const rampLength = 10;
    const rampThickness = 0.5;
    angles.forEach((deg, i) => {
      const rad = (deg * Math.PI) / 180;
      // Put the *top surface* of the near end flush with the ground. Centring
      // the slab instead leaves a lip taller than the autostep height, and the
      // ramp then fails for a reason unrelated to slope.
      const centreY =
        0.02 + (rampLength / 2) * Math.sin(rad) - rampThickness / 2 / Math.cos(rad);
      this.addBox([6, rampThickness, rampLength], [-30 + i * 7, centreY, -8], 0x6d6252, rad);
    });

    // Stairs with treads from below to above the autostep height.
    const stepHeights = [0.2, 0.35, 0.45, 0.55, 0.7];
    stepHeights.forEach((h, i) => {
      for (let s = 0; s < 4; s++) {
        // The player arrives from +Z, so the lowest tread must be the nearest.
        const z = 10.8 - s * 1.6;
        this.addBox([3, h, 1.6], [-24 + i * 6, (s + 0.5) * h, z], 0x7a6f5c);
      }
    });

    // Mantle ledge and a prone-only crawl space.
    this.addBox([8, 0.45, 2], [14, 0.22, -4], 0x8a7b63);
    this.addBox([8, 0.4, 6], [14, 1.05, -12], 0x69614f);
    this.addBox([0.6, 1.05, 6], [10.3, 0.52, -12], 0x69614f);
    this.addBox([0.6, 1.05, 6], [17.7, 0.52, -12], 0x69614f);

    // Penetration range: a panel per material with a dummy directly behind.
    for (const panel of PANELS) {
      this.addBox([2.4, 2.0, panel.thickness], [panel.x, 1.0, -18], panel.color, 0, panel.material);
    }

    void this.decorate();
  }

  /** Kenney props, so scale reads correctly while moving around. */
  private async decorate(): Promise<void> {
    const props: Array<[string, THREE.Vector3]> = [
      ['survival-kit/barrel', new THREE.Vector3(3, 0, 2)],
      ['survival-kit/barrel', new THREE.Vector3(3.7, 0, 2.6)],
      ['survival-kit/box-large', new THREE.Vector3(-4, 0, 1)],
      ['car-kit/sedan', new THREE.Vector3(-10, 0, -2)],
      ['nature-kit/tree_default', new THREE.Vector3(22, 0, 10)],
      ['nature-kit/tree_pineDefaultA', new THREE.Vector3(-20, 0, -8)],
    ];
    for (const [id, pos] of props) {
      if (!assets.entry(id)) continue;
      const model = await assets.instantiate(id);
      model.position.copy(pos);
      this.ctx.render.scene.add(model);
    }
  }

  /** Targets at graded ranges, so damage falloff is directly observable. */
  private async spawnTargets(): Promise<void> {
    const ranges = [12, 30, 65, 120, 200];
    for (let i = 0; i < ranges.length; i++) {
      this.dummies.push(
        await TargetDummy.spawn(
          this.ctx.physics,
          this.ctx.render.scene,
          new THREE.Vector3(4, 0, 24 - ranges[i]!),
          Math.PI,
          i,
        ),
      );
    }
    // One behind each penetration panel.
    for (const panel of PANELS) {
      this.dummies.push(
        await TargetDummy.spawn(
          this.ctx.physics,
          this.ctx.render.scene,
          new THREE.Vector3(panel.x, 0, -19.5),
          Math.PI,
          1,
        ),
      );
    }
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

    this.weapon.setTrigger(input.isMouseDown(MOUSE_LEFT) && input.locked);
    if (input.pressed('KeyR')) this.weapon.reload();
    if (input.pressed('KeyB')) this.weapon.cycleFireMode();

    const camera = this.ctx.render.camera;
    const eye = this.player.controller.eyePosition;
    const origin = new THREE.Vector3(eye.x, eye.y, eye.z);
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);

    const recoil = this.weapon.tryFire(origin, direction, this.shooterState());
    if (recoil) {
      this.shotCount++;
      // Recoil moves the actual aim, not just the picture — the pattern is only
      // learnable if countering it with the mouse genuinely works.
      this.player.pitch = Math.min(this.player.pitch + recoil.pitch, Math.PI / 2 - 0.02);
      this.player.yaw += recoil.yaw;
      this.viewmodel.addRecoil(recoil.pitch * 1.6, recoil.yaw * 1.6);
      this.muzzle.trigger(this.viewmodel.muzzleWorld());
    }
    this.weapon.update(dt);

    this.ctx.physics.step();
    this.ballistics.update(dt);
    for (const dummy of this.dummies) dummy.update(dt);

    for (const [code, zone] of DAMAGE_KEYS) {
      if (input.pressed(code)) this.player.health.applyDamage(zone, 22);
    }
    if (input.pressed('KeyF')) this.player.health.bandage();
    if (input.pressed('KeyK')) {
      this.player.respawn(START);
      for (const dummy of this.dummies) dummy.reset();
      this.hitCount = 0;
      this.shotCount = 0;
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
    this.effects.update(dt, this.ballistics);
    this.muzzle.update(dt);

    this.hud.update(this.player, this.weapon.spreadDegrees(this.shooterState()), this.weapon);
    this.pointerHint.classList.toggle('hidden', input.locked);

    const p = this.player.position;
    this.ctx.render.followShadowTarget(p.x, p.y, p.z);
  }

  dispose(): void {
    for (const dummy of this.dummies) dummy.dispose();
    this.dummies.length = 0;
    this.player.dispose();
    this.viewmodel.dispose();
    this.effects.dispose();
    this.muzzle.dispose();
    this.hud.dispose();
    this.pointerHint.remove();
    for (const item of this.trash) item.dispose();
    this.trash.length = 0;
    for (const name of ['player', 'saude', 'arma', 'tiro']) debugOverlay.removeSection(name);
  }
}
