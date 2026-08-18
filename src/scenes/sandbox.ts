import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { Layer, RAPIER } from '../physics/world';
import { groups } from '../physics/layers';
import { FreeCam } from '../debug/freecam';
import { debugOverlay } from '../debug/overlay';

interface Box {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  prev: THREE.Vector3;
  prevQuat: THREE.Quaternion;
}

/**
 * Phase 0 acceptance scene: static ground plus dynamic boxes, proving the
 * fixed-step loop, Rapier integration and render interpolation all line up.
 */
export class SandboxScene implements Scene {
  readonly name = 'sandbox';
  private ctx!: SceneContext;
  private freeCam!: FreeCam;
  private readonly boxes: Box[] = [];
  private readonly disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  private spawnCooldown = 0;

  init(ctx: SceneContext): void {
    this.ctx = ctx;
    const { render, physics } = ctx;

    render.camera.position.set(0, 6, 16);
    render.camera.lookAt(0, 1, 0);
    this.freeCam = new FreeCam(render.camera);

    const groundGeo = new THREE.BoxGeometry(120, 1, 120);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x5d6b4a, roughness: 0.95 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    render.scene.add(ground);
    this.disposables.push(groundGeo, groundMat);
    physics.addCuboid(60, 0.5, 60, { x: 0, y: -0.5, z: 0 }, Layer.TERRAIN, 0xffff);

    // A ramp, so the character controller in phase 2 has a slope to fail on.
    const rampGeo = new THREE.BoxGeometry(14, 0.5, 14);
    const rampMat = new THREE.MeshStandardMaterial({ color: 0x6b6152, roughness: 0.9 });
    const ramp = new THREE.Mesh(rampGeo, rampMat);
    ramp.position.set(18, 2.4, 0);
    ramp.rotation.z = -Math.PI / 9;
    ramp.receiveShadow = true;
    render.scene.add(ramp);
    this.disposables.push(rampGeo, rampMat);
    const rampBody = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(18, 2.4, 0)
        .setRotation({ x: ramp.quaternion.x, y: ramp.quaternion.y, z: ramp.quaternion.z, w: ramp.quaternion.w }),
    );
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(7, 0.25, 7).setCollisionGroups(groups(Layer.TERRAIN, 0xffff)),
      rampBody,
    );

    for (let i = 0; i < 8; i++) {
      this.spawnBox(new THREE.Vector3((i % 4) * 1.4 - 2.1, 4 + i * 1.6, Math.floor(i / 4) * 1.4 - 0.7));
    }

    debugOverlay.registerSection('sandbox', () => `${this.freeCam.info}\nboxes ${this.boxes.length}`);
    debugOverlay.registerToggle(
      'KeyG',
      'freecam',
      () => this.freeCam.enabled,
      (v) => (this.freeCam.enabled = v),
    );
  }

  private spawnBox(pos: THREE.Vector3): void {
    const size = 0.5 + Math.random() * 0.4;
    const geo = new THREE.BoxGeometry(size * 2, size * 2, size * 2);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(Math.random(), 0.45, 0.55),
      roughness: 0.7,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.position.copy(pos);
    this.ctx.render.scene.add(mesh);
    this.disposables.push(geo, mat);

    const { body } = this.ctx.physics.addCuboid(
      size,
      size,
      size,
      pos,
      Layer.DEBRIS,
      0xffff,
      true,
    );
    this.boxes.push({
      mesh,
      body,
      prev: pos.clone(),
      prevQuat: mesh.quaternion.clone(),
    });
  }

  fixed(dt: number): void {
    // Snapshot the pre-step transform so `frame()` can interpolate to it.
    for (const box of this.boxes) {
      const t = box.body.translation();
      const r = box.body.rotation();
      box.prev.set(t.x, t.y, t.z);
      box.prevQuat.set(r.x, r.y, r.z, r.w);
    }
    this.ctx.physics.step();

    this.spawnCooldown -= dt;
  }

  frame(alpha: number, dt: number): void {
    for (const box of this.boxes) {
      const t = box.body.translation();
      const r = box.body.rotation();
      box.mesh.position.lerpVectors(box.prev, new THREE.Vector3(t.x, t.y, t.z), alpha);
      box.mesh.quaternion.slerpQuaternions(
        box.prevQuat,
        new THREE.Quaternion(r.x, r.y, r.z, r.w),
        alpha,
      );
    }
    this.freeCam.update(dt);
    this.ctx.render.followShadowTarget(
      this.ctx.render.camera.position.x,
      0,
      this.ctx.render.camera.position.z,
    );
  }

  dispose(): void {
    for (const box of this.boxes) this.ctx.render.scene.remove(box.mesh);
    this.boxes.length = 0;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    debugOverlay.removeSection('sandbox');
  }
}
