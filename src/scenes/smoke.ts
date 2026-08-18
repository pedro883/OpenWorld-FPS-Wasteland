import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { assets } from '../core/assets';
import { FreeCam } from '../debug/freecam';
import { debugOverlay } from '../debug/overlay';

/** One model per category, lined up against a 1.8 m human for scale checking. */
const SHOWCASE: Array<{ id: string; label: string }> = [
  { id: 'mini-characters/character-male-a', label: 'characters' },
  { id: 'weapon-pack/sniper', label: 'weapons' },
  { id: 'survival-kit/barrel', label: 'props_loot' },
  { id: 'car-kit/sedan', label: 'vehicles' },
  { id: 'nature-kit/tree_default', label: 'props_nature' },
  { id: 'city-kit-suburban/building-type-b', label: 'props_city' },
  { id: 'building-kit/wall-window-wide-square', label: 'props_city (métrico)' },
];

const REFERENCE_HEIGHT = 1.8;

function makeLabel(text: string, sub: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(12,14,16,0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d8b25a';
  ctx.font = 'bold 42px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, 256, 52);
  ctx.fillStyle = '#9fb0bb';
  ctx.font = '32px monospace';
  ctx.fillText(sub, 256, 98);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set(4, 1, 1);
  return sprite;
}

export class SmokeScene implements Scene {
  readonly name = 'smoke';
  private ctx!: SceneContext;
  private freeCam!: FreeCam;
  private mixer: THREE.AnimationMixer | null = null;
  private showcaseClips: THREE.AnimationClip[] = [];
  private clipIndex = 0;
  private action: THREE.AnimationAction | null = null;
  private readonly trash: Array<{ dispose(): void }> = [];
  private summary = 'carregando…';

  async init(ctx: SceneContext): Promise<void> {
    this.ctx = ctx;
    const { render } = ctx;
    render.camera.position.set(-6, 4.5, 14);
    render.camera.lookAt(6, 2, 0);
    this.freeCam = new FreeCam(render.camera);

    // 1 m grid: the whole point of this scene is judging scale by eye.
    const grid = new THREE.GridHelper(80, 80, 0x8a9aa5, 0x3c464d);
    render.scene.add(grid);
    this.trash.push(grid);

    const groundGeo = new THREE.PlaneGeometry(80, 80);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x4f5a45, roughness: 1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    render.scene.add(ground);
    this.trash.push(groundGeo, groundMat);

    // Reference human: everything else is judged against this.
    const refGeo = new THREE.CapsuleGeometry(0.35, REFERENCE_HEIGHT - 0.7, 4, 12);
    const refMat = new THREE.MeshBasicMaterial({ color: 0xc8503c, wireframe: true });
    const reference = new THREE.Mesh(refGeo, refMat);
    reference.position.set(-3, REFERENCE_HEIGHT / 2, 0);
    render.scene.add(reference);
    this.trash.push(refGeo, refMat);
    const refLabel = makeLabel('referência', '1,80 m');
    refLabel.position.set(-3, REFERENCE_HEIGHT + 0.9, 0);
    render.scene.add(refLabel);

    await assets.prepare(...SHOWCASE.map((s) => s.id));

    const lines: string[] = [];
    let x = 0;
    for (const { id, label } of SHOWCASE) {
      const entry = assets.entry(id);
      if (!entry) {
        lines.push(`${label}: AUSENTE (${id})`);
        continue;
      }
      const size = assets.sizeOf(id);
      const model = await assets.instantiate(id);
      // Kenney models sit on their own origin; drop them onto the grid.
      model.position.set(x, -entry.bounds.min[1] * assets.scaleFor(id), 0);
      this.ctx.render.scene.add(model);

      const clips = assets.clips(id);
      if (clips.length) {
        this.mixer = new THREE.AnimationMixer(model);
        this.showcaseClips = clips;
        this.clipIndex = Math.max(
          0,
          clips.findIndex((c) => c.name === 'idle'),
        );
        this.playClip(this.clipIndex);
      }

      const sprite = makeLabel(label, `${size.y.toFixed(2)} m alt · ${entry.triangles} tri`);
      sprite.position.set(x, Math.max(size.y, 1) + 0.9, 0);
      this.ctx.render.scene.add(sprite);

      lines.push(
        `${label.padEnd(22)} ${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)} m  ` +
          `x${assets.scaleFor(id)}  ${entry.triangles} tri` +
          (clips.length ? `  ${clips.length} anims` : ''),
      );
      x += Math.max(size.x, size.z) + 3.5;
    }

    this.summary = lines.join('\n');
    debugOverlay.registerSection(
      'smoke',
      () =>
        `${this.summary}\n\nclipe: ${this.currentClipName} ` +
        `(${this.clipIndex + 1}/${this.showcaseClips.length})\n${assets.stats}`,
    );
    debugOverlay.registerSection('freecam', () => this.freeCam.info);
    debugOverlay.registerToggle(
      'KeyN',
      'proxima animacao do showcase',
      () => false,
      () => this.playClip(this.clipIndex + 1),
    );
  }

  private get currentClipName(): string {
    return this.showcaseClips[this.clipIndex]?.name ?? '—';
  }

  /** Cycles the showcase character's clips so the rig can be eyeballed. */
  private playClip(index: number): void {
    if (!this.mixer || !this.showcaseClips.length) return;
    this.clipIndex = ((index % this.showcaseClips.length) + this.showcaseClips.length) %
      this.showcaseClips.length;
    const next = this.mixer.clipAction(this.showcaseClips[this.clipIndex]!);
    if (this.action && this.action !== next) {
      next.reset().crossFadeFrom(this.action, 0.2, false).play();
    } else {
      next.reset().play();
    }
    this.action = next;
  }

  fixed(): void {
    this.ctx.physics.step();
  }

  frame(_alpha: number, dt: number): void {
    this.mixer?.update(dt);
    this.freeCam.update(dt);
    const p = this.ctx.render.camera.position;
    this.ctx.render.followShadowTarget(p.x, 0, p.z);
  }

  dispose(): void {
    for (const item of this.trash) item.dispose();
    this.trash.length = 0;
    debugOverlay.removeSection('smoke');
    debugOverlay.removeSection('freecam');
  }
}
