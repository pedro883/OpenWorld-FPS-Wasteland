import * as THREE from 'three';
import { World as WorldCfg } from '../core/config';
import type { ZoneHealth } from '../entities/health';

/**
 * A single large plane at the water line with a cheap animated shader, plus the
 * drowning rule. No reflections: at this art scale they would cost a second
 * render pass for something the player barely looks at.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private time = 0;
  private breath = WorldCfg.drowning.breathSeconds;

  constructor(private readonly scene: THREE.Scene) {
    const size = WorldCfg.sizeMeters * 1.5;
    const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
    geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      uniforms: {
        uTime: { value: 0 },
        uShallow: { value: new THREE.Color(0x3f7f8c) },
        uDeep: { value: new THREE.Color(0x14323f) },
        uFogColor: { value: new THREE.Color(0x8fb6d1) },
        uFogDensity: { value: WorldCfg.fog.clearDensity },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        varying vec3 vWorld;

        void main() {
          // Two crossing wave trains: enough motion to read as water without a
          // normal map or a second pass.
          float w1 = sin(vWorld.x * 0.09 + uTime * 0.9);
          float w2 = sin(vWorld.z * 0.11 - uTime * 0.7);
          float w3 = sin((vWorld.x + vWorld.z) * 0.05 + uTime * 0.45);
          float ripple = (w1 + w2 + w3) / 3.0;

          vec3 colour = mix(uDeep, uShallow, 0.5 + ripple * 0.5);
          colour += vec3(0.12) * pow(max(0.0, ripple), 6.0);

          float depth = length(vWorld - cameraPosition);
          float fog = 1.0 - exp(-uFogDensity * uFogDensity * depth * depth);
          colour = mix(colour, uFogColor, clamp(fog, 0.0, 1.0));

          gl_FragColor = vec4(colour, 0.82);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.y = WorldCfg.waterLevel;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  get level(): number {
    return WorldCfg.waterLevel;
  }

  isUnderwater(eyeY: number): boolean {
    return eyeY < WorldCfg.waterLevel;
  }

  update(dt: number, fogColor: THREE.Color, fogDensity: number): void {
    this.time += dt;
    this.material.uniforms.uTime!.value = this.time;
    (this.material.uniforms.uFogColor!.value as THREE.Color).copy(fogColor);
    this.material.uniforms.uFogDensity!.value = fogDensity;
  }

  /**
   * Breath and drowning. Returns the remaining breath fraction so the HUD can
   * show it; damage lands on the torso once the air is gone.
   */
  applyDrowning(dt: number, eyeY: number, health: ZoneHealth): number {
    if (this.isUnderwater(eyeY)) {
      this.breath = Math.max(0, this.breath - dt);
      if (this.breath <= 0) {
        health.applyDamage('torso', WorldCfg.drowning.damagePerSecond * dt);
      }
    } else {
      // Recovers faster than it drains, so surfacing is a real reprieve.
      this.breath = Math.min(
        WorldCfg.drowning.breathSeconds,
        this.breath + dt * 2.5,
      );
    }
    return this.breath / WorldCfg.drowning.breathSeconds;
  }

  get breathFraction(): number {
    return this.breath / WorldCfg.drowning.breathSeconds;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
