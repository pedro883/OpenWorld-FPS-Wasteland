import type { Poi, RoadSegment } from '../world/layout';
import type { Terrain } from '../world/terrain';
import type { ActiveMission } from '../missions/director';
import { Panel } from './panel';

const BIOME_COLOURS: Record<string, [number, number, number]> = {
  campo: [104, 126, 74],
  floresta: [62, 92, 58],
  industrial: [118, 112, 100],
  militar: [96, 100, 78],
};
const WATER: [number, number, number] = [42, 66, 88];

export interface MapContext {
  playerX: number;
  playerZ: number;
  playerYaw: number;
  missions: readonly ActiveMission[];
  safeZone: { x: number; z: number; radius: number } | null;
}

/**
 * Full-screen map.
 *
 * The terrain is sampled once into an offscreen canvas and reused: the height
 * function is pure, so the picture never changes, and re-sampling 65k points
 * every time the player presses M would cost a visible hitch for no gain.
 */
export class MapPanel extends Panel {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private terrainLayer: HTMLCanvasElement | null = null;
  private context: MapContext | null = null;
  /** Where the player clicked, in world metres. */
  waypoint: { x: number; z: number } | null = null;
  private readonly legend: HTMLDivElement;

  constructor(
    private readonly terrain: Terrain,
    private readonly pois: readonly Poi[],
    private readonly roads: readonly RoadSegment[],
    private readonly halfExtent: number,
  ) {
    super('map-panel', 'Mapa');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    this.canvas.width = 900;
    this.canvas.height = 900;
    this.ctx = this.canvas.getContext('2d')!;

    this.canvas.addEventListener('click', (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * this.canvas.width;
      const py = ((event.clientY - rect.top) / rect.height) * this.canvas.height;
      const world = this.toWorld(px, py);
      // Clicking the waypoint again clears it, which is the only way to.
      const existing = this.waypoint;
      this.waypoint =
        existing && Math.hypot(existing.x - world.x, existing.z - world.z) < this.halfExtent * 0.02
          ? null
          : world;
      this.draw();
    });

    this.legend = document.createElement('div');
    this.legend.className = 'map-legend';
    this.legend.innerHTML =
      '<span class="dot player"></span>você' +
      '<span class="dot poi"></span>local' +
      '<span class="dot mission"></span>missão' +
      '<span class="dot safe"></span>zona segura' +
      '<span class="dot waypoint"></span>waypoint (clique no mapa)';

    this.body.append(this.canvas, this.legend);
  }

  setContext(context: MapContext): void {
    this.context = context;
    if (this.isOpen) this.draw();
  }

  protected onShow(): void {
    this.draw();
  }

  private toCanvas(x: number, z: number): { px: number; py: number } {
    const scale = this.canvas.width / (this.halfExtent * 2);
    return {
      px: (x + this.halfExtent) * scale,
      py: (z + this.halfExtent) * scale,
    };
  }

  private toWorld(px: number, py: number): { x: number; z: number } {
    const scale = (this.halfExtent * 2) / this.canvas.width;
    return { x: px * scale - this.halfExtent, z: py * scale - this.halfExtent };
  }

  /** Samples the height function into a picture, once. */
  private buildTerrainLayer(): HTMLCanvasElement {
    const res = 300;
    const layer = document.createElement('canvas');
    layer.width = res;
    layer.height = res;
    const ctx = layer.getContext('2d')!;
    const image = ctx.createImageData(res, res);
    const step = (this.halfExtent * 2) / res;

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -this.halfExtent + i * step;
        const z = -this.halfExtent + j * step;
        const height = this.terrain.heightAt(x, z);
        const biome = this.terrain.biomeAt(x, z);
        let [r, g, b] = height <= 0 ? WATER : (BIOME_COLOURS[biome] ?? BIOME_COLOURS.campo!);
        // Cheap relief: brighten with altitude so ridges read as ridges.
        const shade = height <= 0 ? 1 : 0.78 + Math.min(0.5, height / 120);
        const o = (j * res + i) * 4;
        image.data[o] = Math.min(255, r * shade);
        image.data[o + 1] = Math.min(255, g * shade);
        image.data[o + 2] = Math.min(255, b * shade);
        image.data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return layer;
  }

  private draw(): void {
    const ctx = this.ctx;
    const size = this.canvas.width;
    this.terrainLayer ??= this.buildTerrainLayer();
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.terrainLayer, 0, 0, size, size);

    ctx.strokeStyle = 'rgba(232, 220, 190, 0.55)';
    ctx.lineWidth = 4;
    for (const road of this.roads) {
      const a = this.toCanvas(road.ax, road.az);
      const b = this.toCanvas(road.bx, road.bz);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }

    const ctxData = this.context;

    if (ctxData?.safeZone) {
      const p = this.toCanvas(ctxData.safeZone.x, ctxData.safeZone.z);
      const r = (ctxData.safeZone.radius / (this.halfExtent * 2)) * size;
      ctx.fillStyle = 'rgba(96, 208, 140, 0.22)';
      ctx.strokeStyle = 'rgba(96, 208, 140, 0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.px, p.py, Math.max(r, 10), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const poi of this.pois) {
      const p = this.toCanvas(poi.x, poi.z);
      ctx.fillStyle = 'rgba(240, 236, 220, 0.95)';
      ctx.beginPath();
      ctx.arc(p.px, p.py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.strokeText(poi.name, p.px, p.py - 12);
      ctx.fillText(poi.name, p.px, p.py - 12);
    }

    for (const mission of ctxData?.missions ?? []) {
      const p = this.toCanvas(mission.spec.x, mission.spec.z);
      const r = (mission.spec.radiusMeters / (this.halfExtent * 2)) * size;
      ctx.strokeStyle = 'rgba(255, 176, 64, 0.95)';
      ctx.fillStyle = 'rgba(255, 176, 64, 0.18)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.px, p.py, Math.max(r, 9), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 208, 140, 0.95)';
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      const label = `${mission.spec.name} · $${mission.spec.reward}`;
      ctx.strokeText(label, p.px, p.py + Math.max(r, 9) + 16);
      ctx.fillText(label, p.px, p.py + Math.max(r, 9) + 16);
    }

    if (this.waypoint) {
      const p = this.toCanvas(this.waypoint.x, this.waypoint.z);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.px - 9, p.py);
      ctx.lineTo(p.px + 9, p.py);
      ctx.moveTo(p.px, p.py - 9);
      ctx.lineTo(p.px, p.py + 9);
      ctx.stroke();
    }

    if (ctxData) {
      const p = this.toCanvas(ctxData.playerX, ctxData.playerZ);
      ctx.save();
      ctx.translate(p.px, p.py);
      ctx.rotate(-ctxData.playerYaw);
      ctx.fillStyle = 'rgba(120, 240, 180, 1)';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(7, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-7, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}
