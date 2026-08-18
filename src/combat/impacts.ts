import * as THREE from 'three';
import cfg from '../../config/ballistics.json';
import type { BallisticsSystem, ImpactEvent } from './ballistics';

const DECAL_COLORS: Record<string, number> = {
  blood: 0x7a1512,
  chip: 0x4a3a26,
  dust: 0x3c3a35,
  spark: 0x6a6a70,
  glass: 0x9fc4d0,
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Pooled tracers, decals and impact sparks.
 *
 * Everything here is one InstancedMesh per kind: a firefight produces hundreds
 * of these per second, and one draw call each is the difference between a
 * readable frame budget and a stutter.
 */
export class ImpactEffects {
  private readonly tracers: THREE.InstancedMesh;
  private readonly decals: THREE.InstancedMesh;
  private readonly sparks: THREE.InstancedMesh;

  private decalCursor = 0;
  private readonly decalDeaths: Float32Array;
  private sparkCursor = 0;
  private readonly sparkDeaths: Float32Array;
  private readonly sparkVel: Float32Array;
  private readonly sparkPos: Float32Array;

  private time = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    const tracerMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(cfg.tracer.color),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, cfg.maxProjectiles);
    this.tracers.frustumCulled = false;
    this.tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.tracers);

    const decalGeo = new THREE.PlaneGeometry(1, 1);
    const decalMat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
    });
    this.decals = new THREE.InstancedMesh(decalGeo, decalMat, cfg.decals.max);
    this.decals.frustumCulled = false;
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.decals.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(cfg.decals.max * 3).fill(0.2),
      3,
    );
    scene.add(this.decals);
    this.decalDeaths = new Float32Array(cfg.decals.max);

    const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
    const sparkMat = new THREE.MeshBasicMaterial({
      color: 0xffcf8a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sparkCount = 192;
    this.sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, sparkCount);
    this.sparks.frustumCulled = false;
    this.sparks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.sparks);
    this.sparkDeaths = new Float32Array(sparkCount);
    this.sparkVel = new Float32Array(sparkCount * 3);
    this.sparkPos = new Float32Array(sparkCount * 3);

    this.hideAll();
  }

  private hideAll(): void {
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < this.tracers.count; i++) this.tracers.setMatrixAt(i, this.matrix);
    for (let i = 0; i < this.decals.count; i++) this.decals.setMatrixAt(i, this.matrix);
    for (let i = 0; i < this.sparks.count; i++) this.sparks.setMatrixAt(i, this.matrix);
    this.tracers.instanceMatrix.needsUpdate = true;
    this.decals.instanceMatrix.needsUpdate = true;
    this.sparks.instanceMatrix.needsUpdate = true;
  }

  /** Wire this as the ballistics system's impact callback. */
  readonly handleImpact = (e: ImpactEvent): void => {
    this.spawnDecal(e);
    if (e.material === 'metal' || e.material === 'concrete' || e.ricocheted) {
      this.spawnSparks(e, e.ricocheted ? 8 : 5);
    }
  };

  private spawnDecal(e: ImpactEvent): void {
    const i = this.decalCursor;
    this.decalCursor = (this.decalCursor + 1) % this.decals.count;
    this.decalDeaths[i] = this.time + cfg.decals.lifetimeSeconds;

    this.position.copy(e.point).addScaledVector(e.normal, cfg.decals.offsetMeters);
    this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), e.normal);
    const size = cfg.decals.sizeMeters * (0.7 + Math.random() * 0.6);
    this.scale.set(size, size, 1);
    this.matrix.compose(this.position, this.quat, this.scale);
    this.decals.setMatrixAt(i, this.matrix);
    this.decals.instanceMatrix.needsUpdate = true;

    const key = e.material === 'flesh' ? 'blood' : (e.material === 'metal' ? 'spark' : 'dust');
    const color = new THREE.Color(DECAL_COLORS[key] ?? 0x333333);
    this.decals.instanceColor!.setXYZ(i, color.r, color.g, color.b);
    this.decals.instanceColor!.needsUpdate = true;
  }

  private spawnSparks(e: ImpactEvent, count: number): void {
    for (let n = 0; n < count; n++) {
      const i = this.sparkCursor;
      this.sparkCursor = (this.sparkCursor + 1) % this.sparks.count;
      this.sparkDeaths[i] = this.time + 0.18 + Math.random() * 0.22;
      this.sparkPos[i * 3] = e.point.x;
      this.sparkPos[i * 3 + 1] = e.point.y;
      this.sparkPos[i * 3 + 2] = e.point.z;
      // Scatter around the surface normal, biased outwards.
      this.dir
        .copy(e.normal)
        .addScaledVector(
          new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5),
          1.1,
        )
        .normalize()
        .multiplyScalar(2 + Math.random() * 4);
      this.sparkVel[i * 3] = this.dir.x;
      this.sparkVel[i * 3 + 1] = this.dir.y;
      this.sparkVel[i * 3 + 2] = this.dir.z;
    }
  }

  update(dt: number, ballistics: BallisticsSystem): void {
    this.time += dt;

    // Tracers: one stretched box per in-flight round, rebuilt each frame.
    let t = 0;
    ballistics.forEachActive((pos, prev, tracer) => {
      if (!tracer || t >= this.tracers.count) return;
      this.dir.copy(pos).sub(prev);
      const length = Math.min(this.dir.length(), cfg.tracer.lengthMeters);
      if (length < 1e-4) return;
      this.dir.normalize();
      this.position.copy(pos).addScaledVector(this.dir, -length / 2);
      this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.dir);
      this.scale.set(cfg.tracer.widthMeters, cfg.tracer.widthMeters, length);
      this.matrix.compose(this.position, this.quat, this.scale);
      this.tracers.setMatrixAt(t++, this.matrix);
    });
    this.matrix.makeScale(0, 0, 0);
    for (let i = t; i < this.tracers.count; i++) this.tracers.setMatrixAt(i, this.matrix);
    this.tracers.instanceMatrix.needsUpdate = true;

    // Decals expire by lifetime; the ring buffer handles overflow.
    for (let i = 0; i < this.decals.count; i++) {
      if (this.decalDeaths[i]! > 0 && this.decalDeaths[i]! < this.time) {
        this.decalDeaths[i] = 0;
        this.matrix.makeScale(0, 0, 0);
        this.decals.setMatrixAt(i, this.matrix);
        this.decals.instanceMatrix.needsUpdate = true;
      }
    }

    for (let i = 0; i < this.sparks.count; i++) {
      if (this.sparkDeaths[i]! <= 0) continue;
      if (this.sparkDeaths[i]! < this.time) {
        this.sparkDeaths[i] = 0;
        this.matrix.makeScale(0, 0, 0);
        this.sparks.setMatrixAt(i, this.matrix);
        continue;
      }
      this.sparkVel[i * 3 + 1] = this.sparkVel[i * 3 + 1]! - 18 * dt;
      for (let a = 0; a < 3; a++) {
        this.sparkPos[i * 3 + a] = this.sparkPos[i * 3 + a]! + this.sparkVel[i * 3 + a]! * dt;
      }
      this.position.set(this.sparkPos[i * 3]!, this.sparkPos[i * 3 + 1]!, this.sparkPos[i * 3 + 2]!);
      this.quat.identity();
      this.scale.setScalar(0.03);
      this.matrix.compose(this.position, this.quat, this.scale);
      this.sparks.setMatrixAt(i, this.matrix);
    }
    this.sparks.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.tracers, this.decals, this.sparks]) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
  }
}

/** Brief muzzle flash light, parented wherever the shot comes from. */
export class MuzzleFlash {
  private readonly light: THREE.PointLight;
  private timer = 0;

  constructor(private readonly scene: THREE.Scene) {
    this.light = new THREE.PointLight(0xffd08a, 0, 9, 2);
    this.light.visible = false;
    scene.add(this.light);
  }

  trigger(at: THREE.Vector3): void {
    this.light.position.copy(at).addScaledVector(UP, 0.02);
    this.light.visible = true;
    this.timer = 0.05;
  }

  update(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    this.light.intensity = Math.max(0, this.timer / 0.05) * 14;
    if (this.timer <= 0) this.light.visible = false;
  }

  dispose(): void {
    this.scene.remove(this.light);
    this.light.dispose();
  }
}
