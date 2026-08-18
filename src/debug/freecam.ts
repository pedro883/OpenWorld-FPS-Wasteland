import * as THREE from 'three';
import { input } from '../core/input';
import { Player } from '../core/config';

/** Detached spectator camera for inspecting scenes without a player entity. */
export class FreeCam {
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private speed = 12;
  enabled = true;

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    this.euler.setFromQuaternion(camera.quaternion);
  }

  update(dt: number): void {
    if (!this.enabled) return;

    if (input.locked) {
      this.euler.y -= input.mouseDX * Player.camera.sensitivity;
      this.euler.x -= input.mouseDY * Player.camera.sensitivity;
      this.euler.x = THREE.MathUtils.clamp(this.euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      this.camera.quaternion.setFromEuler(this.euler);
    }

    if (input.wheelDelta !== 0) {
      this.speed = THREE.MathUtils.clamp(this.speed * (input.wheelDelta > 0 ? 0.85 : 1.18), 1, 400);
    }

    const forward = Number(input.isDown('KeyW')) - Number(input.isDown('KeyS'));
    const strafe = Number(input.isDown('KeyD')) - Number(input.isDown('KeyA'));
    const lift = Number(input.isDown('Space')) - Number(input.isDown('ControlLeft'));
    if (!forward && !strafe && !lift) return;

    const mult = input.isDown('ShiftLeft') ? 4 : 1;
    const step = this.speed * mult * dt;
    const dir = new THREE.Vector3();
    const tmp = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    tmp.crossVectors(dir, this.camera.up).normalize();
    this.camera.position.addScaledVector(dir, forward * step);
    this.camera.position.addScaledVector(tmp, strafe * step);
    this.camera.position.y += lift * step;
  }

  get info(): string {
    const p = this.camera.position;
    return `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\nspeed ${this.speed.toFixed(0)} m/s (roda)`;
  }
}
