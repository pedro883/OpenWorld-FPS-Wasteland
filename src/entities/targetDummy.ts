import * as THREE from 'three';
import { assets } from '../core/assets';
import type { PhysicsWorld } from '../physics/world';
import { ZoneHealth, type Zone } from './health';
import { HitboxSet } from './hitboxes';
import type { Damageable } from '../combat/types';

const MODEL_IDS = [
  'animated-characters-bundle/character-medium',
  'animated-characters-bundle/character-large-male',
  'animated-characters-bundle/character-large-female',
  'animated-characters-bundle/character-small',
];

/** Every dummy stands 1.78 m tall, so the hitbox layout reads the same. */
const DUMMY_HEIGHT_METRES = 1.78;

/**
 * Stationary humanoid with one collider per damage zone. Used to prove that
 * hits resolve to the right limb; phase 5's NPC reuses the same hitbox layout.
 */
export class TargetDummy implements Damageable {
  readonly health = new ZoneHealth();
  readonly root = new THREE.Group();
  private readonly hitboxes: HitboxSet;
  private mixer: THREE.AnimationMixer | null = null;
  private flashTimer = 0;
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private lastHitZone: Zone | null = null;
  private deathTimer = 0;

  constructor(
    physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    position: THREE.Vector3,
    facing = 0,
  ) {
    this.root.position.copy(position);
    this.root.rotation.y = facing;
    scene.add(this.root);

    this.hitboxes = new HitboxSet(physics, this, { position });
    this.hitboxes.setPosition(position, facing);
  }

  static async spawn(
    physics: PhysicsWorld,
    scene: THREE.Scene,
    position: THREE.Vector3,
    facing = 0,
    variant = 0,
  ): Promise<TargetDummy> {
    const dummy = new TargetDummy(physics, scene, position, facing);
    const id = MODEL_IDS[variant % MODEL_IDS.length]!;
    const model = await assets.instantiate(id, { scale: assets.scaleToHeight(id, DUMMY_HEIGHT_METRES) });
    dummy.root.add(model);
    model.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Clone the shared material so a hit can flash this dummy alone.
      const cloned = (mesh.material as THREE.MeshStandardMaterial).clone();
      mesh.material = cloned;
      dummy.materials.push(cloned);
    });
    const clips = assets.clips(id);
    if (clips.length) {
      dummy.mixer = new THREE.AnimationMixer(model);
      const idle = clips.find((c) => c.name === 'idle');
      if (idle) dummy.mixer.clipAction(idle).play();
    }
    return dummy;
  }

  get isAlive(): boolean {
    return this.health.alive;
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.root.position);
  }

  onDamaged(zone: Zone, _amount: number, _fromDirection: THREE.Vector3): void {
    this.flashTimer = 0.12;
    this.lastHitZone = zone;
  }

  update(dt: number): void {
    this.mixer?.update(dt);
    this.health.update(dt);

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const k = Math.max(0, this.flashTimer / 0.12);
      for (const mat of this.materials) mat.emissive.setRGB(k * 0.9, k * 0.1, k * 0.1);
    }

    if (!this.health.alive && this.deathTimer === 0) {
      this.deathTimer = 1;
      this.playDeath();
    }
  }

  private playDeath(): void {
    const clips = assets.clips(MODEL_IDS[0]!);
    const die = clips.find((c) => c.name === 'die');
    if (this.mixer && die) {
      this.mixer.stopAllAction();
      const action = this.mixer.clipAction(die);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
    }
    // Hitboxes come out of the world so a corpse cannot soak more rounds.
    this.hitboxes.dispose();
  }

  reset(): void {
    this.health.reset();
    this.deathTimer = 0;
    this.lastHitZone = null;
  }

  get statusText(): string {
    const state = this.health.alive ? `${(this.health.vitality * 100).toFixed(0)}%` : 'ABATIDO';
    return `${state}${this.lastHitZone ? `  último: ${this.lastHitZone}` : ''}`;
  }

  dispose(): void {
    if (this.health.alive) this.hitboxes.dispose();
    this.scene.remove(this.root);
    for (const mat of this.materials) mat.dispose();
  }
}
