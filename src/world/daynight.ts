import * as THREE from 'three';
import { World as WorldCfg } from '../core/config';
import type { RenderContext } from '../render/renderer';

export type Weather = 'limpo' | 'nublado' | 'chuva' | 'neblina';

const KEYFRAMES = [
  // hour, sun colour, sun intensity, sky colour, ambient intensity
  { hour: 0, sun: 0x2a3550, intensity: 0.06, sky: 0x0d1420, ambient: 0.18 },
  { hour: 5, sun: 0x40405e, intensity: 0.12, sky: 0x1e2a3d, ambient: 0.26 },
  { hour: 6.5, sun: 0xff9a5c, intensity: 1.1, sky: 0x6d7d99, ambient: 0.6 },
  { hour: 9, sun: 0xfff0d6, intensity: 2.2, sky: 0x8fb6d1, ambient: 1.1 },
  { hour: 13, sun: 0xffffff, intensity: 2.6, sky: 0x9cc3dd, ambient: 1.25 },
  { hour: 17, sun: 0xffe3b0, intensity: 2.0, sky: 0x8fb0c9, ambient: 1.0 },
  { hour: 19, sun: 0xff7a45, intensity: 0.85, sky: 0x5c6480, ambient: 0.5 },
  { hour: 20.5, sun: 0x3a4062, intensity: 0.14, sky: 0x232c40, ambient: 0.24 },
  { hour: 24, sun: 0x2a3550, intensity: 0.06, sky: 0x0d1420, ambient: 0.18 },
];

const WEATHER_FOG: Record<Weather, number> = {
  limpo: WorldCfg.fog.clearDensity,
  nublado: WorldCfg.fog.overcastDensity,
  chuva: WorldCfg.fog.rainDensity,
  neblina: WorldCfg.fog.heavyFogDensity,
};

const WEATHER_LIGHT: Record<Weather, number> = {
  limpo: 1,
  nublado: 0.62,
  chuva: 0.45,
  neblina: 0.35,
};

/**
 * Day/night and weather.
 *
 * Beyond looking right, this owns `visibility`, the single number the AI reads
 * to know how far it can see. Night and fog have to actually blind the enemy,
 * otherwise darkness is pure decoration.
 */
export class DayNightCycle {
  /** Hours, 0..24. */
  hour: number;
  weather: Weather = 'limpo';
  paused = false;
  /** Multiplier on the real clock, for inspecting a full cycle quickly. */
  timeScale = 1;

  private readonly sunColor = new THREE.Color();
  private readonly skyColor = new THREE.Color();

  constructor(private readonly render: RenderContext) {
    this.hour = WorldCfg.startHour;
    this.apply();
  }

  update(dt: number): void {
    if (this.paused) return;
    const hoursPerSecond = 24 / (WorldCfg.dayLengthMinutes * 60);
    this.hour = (this.hour + dt * hoursPerSecond * this.timeScale) % 24;
    this.apply();
  }

  private sample(): { sun: THREE.Color; intensity: number; sky: THREE.Color; ambient: number } {
    let a = KEYFRAMES[0]!;
    let b = KEYFRAMES[KEYFRAMES.length - 1]!;
    for (let i = 1; i < KEYFRAMES.length; i++) {
      if (this.hour <= KEYFRAMES[i]!.hour) {
        a = KEYFRAMES[i - 1]!;
        b = KEYFRAMES[i]!;
        break;
      }
    }
    const span = Math.max(1e-6, b.hour - a.hour);
    const t = Math.min(1, Math.max(0, (this.hour - a.hour) / span));
    return {
      sun: this.sunColor.setHex(a.sun).lerp(new THREE.Color(b.sun), t),
      intensity: a.intensity + (b.intensity - a.intensity) * t,
      sky: this.skyColor.setHex(a.sky).lerp(new THREE.Color(b.sky), t),
      ambient: a.ambient + (b.ambient - a.ambient) * t,
    };
  }

  private apply(): void {
    const s = this.sample();
    const weatherLight = WEATHER_LIGHT[this.weather];

    // Sun arc: elevation peaks at noon, azimuth sweeps east to west.
    const dayAngle = ((this.hour - 6) / 12) * Math.PI;
    const elevation = Math.sin(dayAngle) * (Math.PI / 2) * 0.86;
    const azimuth = -Math.PI / 2 + ((this.hour - 6) / 12) * Math.PI;
    this.render.setSunAngles(azimuth, Math.max(0.06, elevation));

    this.render.sun.color.copy(s.sun);
    this.render.sun.intensity = s.intensity * weatherLight;
    this.render.sky.color.copy(s.sky);
    this.render.sky.intensity = s.ambient * weatherLight;

    this.render.scene.background = s.sky;
    const fog = this.render.scene.fog as THREE.FogExp2 | null;
    if (fog) {
      fog.color.copy(s.sky);
      // Night thickens the air a little on top of the weather.
      const nightBoost = 1 + (1 - Math.min(1, s.intensity / 2)) * 0.9;
      fog.density = WEATHER_FOG[this.weather] * nightBoost;
    }
  }

  /** 0 (blind) .. 1 (full daylight), consumed by AI perception in phase 5. */
  get visibility(): number {
    const s = this.sample();
    const light = Math.min(1, s.intensity / 2.2);
    return Math.max(0.08, light * WEATHER_LIGHT[this.weather]);
  }

  get isNight(): boolean {
    return this.hour < 6 || this.hour > 19.5;
  }

  setWeather(weather: Weather): void {
    this.weather = weather;
    this.apply();
  }

  cycleWeather(): Weather {
    const order: Weather[] = ['limpo', 'nublado', 'chuva', 'neblina'];
    const next = order[(order.indexOf(this.weather) + 1) % order.length]!;
    this.setWeather(next);
    return next;
  }

  get debugText(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return [
      `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}  ${this.weather}${this.paused ? '  (pausado)' : ''}`,
      `visibilidade ${(this.visibility * 100).toFixed(0)}%  x${this.timeScale}`,
    ].join('\n');
  }
}
