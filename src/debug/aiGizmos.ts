import * as THREE from 'three';
import aiConfig from '../../config/ai.json';
import type { Npc } from '../entities/npc';

const AWARENESS_COLOR: Record<string, number> = {
  unaware: 0x5f6b74,
  suspicious: 0xd8c25a,
  searching: 0xd8912f,
  aware: 0xd85a2f,
  engaged: 0xd82f2f,
};

/**
 * Visual debug for the AI, as the spec requires: vision cone, detection meter,
 * current goal, chosen cover and behaviour-tree state.
 *
 * All of it is drawn from pooled line segments in one geometry, rebuilt only
 * while the gizmos are on, so leaving them off costs nothing.
 */
export class AiGizmos {
  private readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly labels = new Map<number, HTMLDivElement>();
  private readonly container: HTMLDivElement;
  private cursor = 0;
  enabled = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly maxSegments = 4096,
  ) {
    this.positions = new Float32Array(maxSegments * 6);
    this.colors = new Float32Array(maxSegments * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    this.lines = new THREE.LineSegments(geometry, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
    scene.add(this.lines);

    this.container = document.createElement('div');
    this.container.id = 'ai-gizmo-labels';
    document.body.appendChild(this.container);
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    this.lines.visible = value;
    this.container.style.display = value ? 'block' : 'none';
  }

  private segment(a: THREE.Vector3, b: THREE.Vector3, color: THREE.Color): void {
    if (this.cursor >= this.maxSegments) return;
    const i = this.cursor * 6;
    this.positions[i] = a.x;
    this.positions[i + 1] = a.y;
    this.positions[i + 2] = a.z;
    this.positions[i + 3] = b.x;
    this.positions[i + 4] = b.y;
    this.positions[i + 5] = b.z;
    for (let k = 0; k < 2; k++) {
      this.colors[i + k * 3] = color.r;
      this.colors[i + k * 3 + 1] = color.g;
      this.colors[i + k * 3 + 2] = color.b;
    }
    this.cursor++;
  }

  update(npcs: readonly Npc[], camera: THREE.PerspectiveCamera): void {
    if (!this.enabled) return;
    this.cursor = 0;
    const colour = new THREE.Color();

    for (const npc of npcs) {
      if (!npc.isAlive) continue;
      colour.setHex(AWARENESS_COLOR[npc.awareness] ?? 0xffffff);
      const eye = new THREE.Vector3(npc.position.x, npc.position.y + 1.62, npc.position.z);

      // Vision cone: the two edges plus an arc, clipped to a readable length.
      const range = Math.min(aiConfig.perception.maxRangeMeters, 45);
      const half = (aiConfig.perception.fovDegrees / 2) * (Math.PI / 180);
      const steps = 10;
      let previous: THREE.Vector3 | null = null;
      for (let i = 0; i <= steps; i++) {
        const a = npc.facing - half + (i / steps) * half * 2;
        const point = new THREE.Vector3(
          eye.x + Math.sin(a) * range,
          eye.y,
          eye.z + Math.cos(a) * range,
        );
        if (i === 0 || i === steps) this.segment(eye, point, colour);
        if (previous) this.segment(previous, point, colour);
        previous = point;
      }

      // Detection meter as a vertical bar over the head.
      const meterBase = new THREE.Vector3(npc.position.x, npc.position.y + 2.0, npc.position.z);
      const meterTop = meterBase.clone();
      meterTop.y += 0.05 + (npc.detectionMeter / 100) * 0.8;
      this.segment(meterBase, meterTop, colour);

      // Suppression bar, offset so the two never overlap.
      if (npc.suppression > 0.01) {
        const base = meterBase.clone().add(new THREE.Vector3(0.18, 0, 0));
        const top = base.clone();
        top.y += 0.05 + npc.suppression * 0.8;
        this.segment(base, top, colour.clone().setHex(0x4fa3d8));
      }

      // Current goal and the path to it.
      const goal = npc.currentGoal;
      if (goal) {
        this.segment(npc.position, goal, colour.clone().setHex(0x6fd88a));
        const cross = 0.6;
        this.segment(
          goal.clone().add(new THREE.Vector3(-cross, 0.1, 0)),
          goal.clone().add(new THREE.Vector3(cross, 0.1, 0)),
          colour.clone().setHex(0x6fd88a),
        );
        this.segment(
          goal.clone().add(new THREE.Vector3(0, 0.1, -cross)),
          goal.clone().add(new THREE.Vector3(0, 0.1, cross)),
          colour.clone().setHex(0x6fd88a),
        );
      }

      // Chosen cover, drawn as a box so it reads differently from the goal.
      const cover = npc.currentCover;
      if (cover) {
        const c = cover.position;
        const s = 0.5;
        const h = cover.posture === 'prone' ? 0.4 : 1.0;
        const corners = [
          new THREE.Vector3(c.x - s, c.y, c.z - s),
          new THREE.Vector3(c.x + s, c.y, c.z - s),
          new THREE.Vector3(c.x + s, c.y, c.z + s),
          new THREE.Vector3(c.x - s, c.y, c.z + s),
        ];
        const cyan = colour.clone().setHex(0x4fd8d8);
        for (let i = 0; i < 4; i++) {
          const a = corners[i]!;
          const b = corners[(i + 1) % 4]!;
          this.segment(a, b, cyan);
          this.segment(a, a.clone().setY(a.y + h), cyan);
        }
      }
    }

    const geometry = this.lines.geometry;
    geometry.setDrawRange(0, this.cursor * 2);
    geometry.attributes.position!.needsUpdate = true;
    geometry.attributes.color!.needsUpdate = true;

    this.updateLabels(npcs, camera);
  }

  /** Behaviour-tree state as DOM text projected over each agent. */
  private updateLabels(npcs: readonly Npc[], camera: THREE.PerspectiveCamera): void {
    const seen = new Set<number>();
    const projected = new THREE.Vector3();
    for (const npc of npcs) {
      if (!npc.isAlive) continue;
      seen.add(npc.id);
      let label = this.labels.get(npc.id);
      if (!label) {
        label = document.createElement('div');
        label.className = 'ai-label';
        this.container.appendChild(label);
        this.labels.set(npc.id, label);
      }
      projected.set(npc.position.x, npc.position.y + 2.9, npc.position.z).project(camera);
      if (projected.z > 1) {
        label.style.display = 'none';
        continue;
      }
      label.style.display = 'block';
      label.style.left = `${(projected.x * 0.5 + 0.5) * window.innerWidth}px`;
      label.style.top = `${(-projected.y * 0.5 + 0.5) * window.innerHeight}px`;
      label.textContent = npc.debugText;
    }
    for (const [id, label] of this.labels) {
      if (!seen.has(id)) {
        label.remove();
        this.labels.delete(id);
      }
    }
  }

  dispose(): void {
    this.scene.remove(this.lines);
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
    this.container.remove();
  }
}
