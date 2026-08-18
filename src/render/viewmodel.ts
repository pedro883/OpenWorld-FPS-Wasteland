import * as THREE from 'three';
import { assets } from '../core/assets';
import type { RenderContext } from './renderer';
import weaponConfig from '../../config/weapons.json';

export interface ViewmodelState {
  ads: boolean;
  /** 0..1 through a reload; drives the dip-and-roll animation. */
  reload?: number;
  /** 0..1 through a weapon switch; drives the holster dip. */
  switching?: number;
  /** Horizontal speed in m/s, drives the walk bob. */
  speed: number;
  grounded: boolean;
  swayMultiplier: number;
  /** Look delta this frame, in radians, for the lag/sway. */
  lookDelta: { x: number; y: number };
}

const defaults = weaponConfig.defaults.viewmodel;

/**
 * First-person weapon model, parented to the camera.
 *
 * Kenney has no first-person arms mesh — its characters are a single skinned
 * body, so arms cannot be isolated — so the viewmodel is weapon-only. Recoil,
 * sway and bob are procedural and read from config/weapons.json.
 */
export class Viewmodel {
  readonly root = new THREE.Group();
  private weapon: THREE.Object3D | null = null;
  private readonly hip = new THREE.Vector3();
  private readonly ads = new THREE.Vector3();
  private readonly basePosition = new THREE.Vector3();
  private readonly swayOffset = new THREE.Vector3();
  private readonly swayRotation = new THREE.Vector2();
  private bobPhase = 0;
  private adsBlend = 0;
  private readonly animOffset = new THREE.Vector3();
  private readonly animRotation = new THREE.Vector3();

  /** Recoil applied to the model, decaying back to rest. */
  private readonly recoilOffset = new THREE.Vector3();
  private recoilPitch = 0;

  constructor(private readonly render: RenderContext) {
    this.root.frustumCulled = false;
    // Lives in the overlay pass, not the world, so it is never fogged, never
    // clipped by world geometry and never lit by the moving sun.
    render.overlayScene.add(this.root);
  }

  async setWeapon(weaponId: string): Promise<void> {
    const def = (
      weaponConfig.weapons as Record<
        string,
        {
          model: string;
          viewmodel?: { hip?: number[]; ads?: number[]; adsDistance?: number; scale?: number };
        }
      >
    )[weaponId];
    if (!def) throw new Error(`arma desconhecida em config/weapons.json: ${weaponId}`);

    if (this.weapon) {
      this.root.remove(this.weapon);
      this.weapon = null;
    }

    const vm = defaults;
    // The viewmodel is deliberately smaller than the world model: it sits
    // centimetres from the lens, where true scale would fill the screen.
    const model = await assets.instantiate(def.model, {
      scale: assets.scaleFor(def.model) * (def.viewmodel?.scale ?? vm.scale),
    });
    model.rotation.set(
      (vm.rotationDegrees[0]! * Math.PI) / 180,
      (vm.rotationDegrees[1]! * Math.PI) / 180,
      (vm.rotationDegrees[2]! * Math.PI) / 180,
    );
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // The viewmodel lives inside the near plane of the world; disabling
      // shadow casting keeps it out of the sun's depth pass.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
    });

    this.hip.fromArray((def.viewmodel?.hip ?? vm.hip) as number[]);
    this.root.add(model);
    this.weapon = model;

    // The ADS pose is *derived*, not hand-tuned: measure the model and place it
    // so its centreline is on the optical axis and the top of the receiver — the
    // only thing resembling a sight on these low-poly guns — sits at the
    // crosshair. Hand-tuning per weapon drifts the moment the arsenal grows.
    const box = new THREE.Box3().setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    this.ads.set(
      -centre.x,
      -box.max.y - (vm.adsSightDrop ?? 0),
      (def.viewmodel?.adsDistance ?? vm.adsDistance ?? -0.55),
    );
    if (def.viewmodel?.ads) this.ads.fromArray(def.viewmodel.ads);
  }

  /** Hides the weapon, for when the player is riding a vehicle. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  addRecoil(vertical: number, horizontal: number): void {
    this.recoilPitch += vertical;
    this.recoilOffset.x += horizontal * 0.01;
    this.recoilOffset.z += 0.035;
  }

  update(dt: number, state: ViewmodelState): void {
    if (!this.weapon) return;
    const vm = defaults;

    const target = state.ads ? 1 : 0;
    this.adsBlend += (target - this.adsBlend) * Math.min(1, dt / 0.16);
    // Narrowing the overlay FOV while aiming magnifies the weapon in step with
    // the world zoom, so the sight picture stays consistent.
    this.render.setOverlayFov(65 - this.adsBlend * 20);
    this.basePosition.lerpVectors(this.hip, this.ads, this.adsBlend);

    // Sway lags the look input, so the weapon trails the camera slightly.
    const swayScale = (1 - this.adsBlend * 0.8) * state.swayMultiplier;
    this.swayOffset.x += (-state.lookDelta.x * vm.swayPosition * swayScale - this.swayOffset.x) * Math.min(1, 10 * dt);
    this.swayOffset.y += (state.lookDelta.y * vm.swayPosition * swayScale - this.swayOffset.y) * Math.min(1, 10 * dt);
    this.swayRotation.x += (-state.lookDelta.y * vm.swayRotation * swayScale - this.swayRotation.x) * Math.min(1, 8 * dt);
    this.swayRotation.y += (-state.lookDelta.x * vm.swayRotation * swayScale - this.swayRotation.y) * Math.min(1, 8 * dt);

    if (state.grounded && state.speed > 0.4) {
      this.bobPhase += dt * (4 + state.speed * 1.6);
    }
    const bobScale = state.grounded ? Math.min(1, state.speed / 6) * (1 - this.adsBlend * 0.85) : 0;
    const bobX = Math.cos(this.bobPhase) * vm.bobAmount * bobScale;
    const bobY = Math.sin(this.bobPhase * 2) * vm.bobAmount * 0.6 * bobScale;

    const recover = Math.min(1, 12 * dt);
    this.recoilOffset.multiplyScalar(1 - recover);
    this.recoilPitch *= 1 - recover;

    this.applyActionAnimation(state);

    this.root.position.set(
      this.basePosition.x + this.swayOffset.x + bobX + this.recoilOffset.x + this.animOffset.x,
      this.basePosition.y + this.swayOffset.y + bobY + this.animOffset.y,
      this.basePosition.z + this.recoilOffset.z + this.animOffset.z,
    );
    this.root.rotation.set(
      this.swayRotation.x + this.recoilPitch * 0.35 + this.animRotation.x,
      this.swayRotation.y + this.animRotation.y,
      this.swayRotation.y * 0.4 + this.animRotation.z,
    );
  }

  /**
   * Reload and weapon-switch animation, done procedurally.
   *
   * The Kenney weapons are static meshes with no magazine bone and no reload
   * clip, so there is nothing to play back. Dipping the weapon out of frame and
   * rolling it towards the off hand reads as a reload at this art scale, and it
   * costs no assets.
   */
  private applyActionAnimation(state: ViewmodelState): void {
    const vm = defaults;
    this.animOffset.set(0, 0, 0);
    this.animRotation.set(0, 0, 0);

    const switching = state.switching ?? 0;
    if (switching > 0) {
      this.animOffset.y -= vm.switchDip * switching;
      this.animRotation.x += 0.5 * switching;
      return;
    }

    const reload = state.reload ?? 0;
    if (reload <= 0 || reload >= 1) return;
    // Down fast, hold, back up: a sine over the middle of the window.
    const curve = Math.sin(Math.min(1, reload * 1.15) * Math.PI);
    this.animOffset.y -= vm.reloadDip * curve;
    this.animOffset.x -= vm.reloadDip * 0.35 * curve;
    this.animRotation.z += (vm.reloadRollDegrees * Math.PI) / 180 * curve;
    this.animRotation.x += 0.28 * curve;
  }

  /**
   * Muzzle position in *world* space. The viewmodel lives in overlay space, so
   * the offset is re-expressed against the world camera — otherwise tracers
   * would leave from the wrong place.
   */
  muzzleWorld(out = new THREE.Vector3()): THREE.Vector3 {
    const camera = this.render.camera;
    out.set(this.root.position.x * 0.6, this.root.position.y * 0.6, this.root.position.z - 0.35);
    return camera.localToWorld(out);
  }

  get adsAmount(): number {
    return this.adsBlend;
  }

  dispose(): void {
    if (this.weapon) this.root.remove(this.weapon);
    this.render.overlayScene.remove(this.root);
  }
}
