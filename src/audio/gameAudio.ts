import * as THREE from 'three';
import audioConfig from '../../config/audio.json';
import { Random } from '../core/random';
import { Mixer } from './mixer';
import { Sfx, type Loop } from './sfx';

const SHOT = audioConfig.shot;
const CRACK = audioConfig.crackThump;
const IMPACTS = audioConfig.impacts as unknown as Record<string, string[]>;
const STEPS = audioConfig.footsteps as unknown as Record<string, string[]> & {
  intervalWalkSeconds: number;
  intervalSprintSeconds: number;
  gain: number;
};
const VEHICLE = audioConfig.vehicle;
const AMBIENCE = audioConfig.ambience as unknown as Record<string, string> & {
  gain: number;
  nightGain: number;
  crossfadeSeconds: number;
};
const MUSIC = audioConfig.music;
const UI = audioConfig.ui as unknown as Record<string, string>;

export type ShotEnvironment = 'aberto' | 'floresta' | 'interior';

/** Which footstep set a biome sounds like. */
const BIOME_SURFACE: Record<string, string> = {
  campo: 'grass',
  floresta: 'grass',
  industrial: 'concrete',
  militar: 'concrete',
};

/**
 * Everything the game asks the audio system for, in game terms.
 *
 * The scene talks about shots, impacts and biomes; the mixer and Sfx below talk
 * about gain nodes and buffers. Keeping the translation here means the scene
 * never has to know what a PannerNode is, and the sound design lives in one
 * file next to the config that drives it.
 */
export class GameAudio {
  readonly mixer = new Mixer();
  readonly sfx = new Sfx(this.mixer);
  private readonly rng = new Random(0x5eed11);

  private ambienceLoop: Loop | null = null;
  private ambienceId = '';
  private nightLoop: Loop | null = null;
  private musicLoop: Loop | null = null;
  private musicId = '';
  private combatTimer = 0;
  private stepTimer = 0;
  private started = false;

  /** Wired to the click that grabs the pointer: browsers demand a gesture. */
  async start(): Promise<void> {
    await this.mixer.resume();
    if (this.started || !this.mixer.isRunning) return;
    this.started = true;
    // Sounds that must not miss their first play are decoded up front; the rest
    // arrive the first time something asks for them.
    await this.sfx.preload([
      ...SHOT.mech,
      ...Object.values(SHOT.byClass).flat(),
      ...CRACK.crack,
      ...Object.values(IMPACTS).flat(),
      ...Object.values(STEPS).filter(Array.isArray).flat(),
      ...Object.values(UI),
    ]);
  }

  get isRunning(): boolean {
    return this.mixer.isRunning;
  }

  update(dt: number, listener: THREE.Camera): void {
    this.mixer.update(dt);
    if (!this.mixer.isRunning) return;
    const position = new THREE.Vector3();
    const forward = new THREE.Vector3();
    listener.getWorldPosition(position);
    listener.getWorldDirection(forward);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(listener.quaternion);
    this.sfx.setListener(position, forward, up);

    if (this.combatTimer > 0) this.combatTimer -= dt;
  }

  // ---- Combate -------------------------------------------------------------

  /**
   * A shot, in three layers.
   *
   * The mechanism is dry and close — it belongs to whoever pulled the trigger,
   * not to the world. The report is the part that travels and is spatialised.
   * The tail is the environment answering, delayed by how far the sound had to
   * go and back, which is what makes the same rifle sound different in a forest
   * and in the open.
   */
  shot(
    at: THREE.Vector3,
    weaponClass: string,
    environment: ShotEnvironment,
    listenerDistance: number,
    firstPerson: boolean,
  ): void {
    const report = this.rng.pick(SHOT.byClass[weaponClass as keyof typeof SHOT.byClass] ?? SHOT.byClass.rifle);
    this.sfx.play(report, { at, gain: 1, channel: 'sfx' });

    if (firstPerson) {
      this.sfx.play(this.rng.pick(SHOT.mech), { gain: 0.5, channel: 'sfx' });
    }

    const tail = this.rng.pick(SHOT.tailByEnvironment[environment] ?? SHOT.tailByEnvironment.aberto);
    if (tail) {
      this.sfx.play(tail, {
        at,
        gain: SHOT.tailGain,
        delay: Math.min(0.6, listenerDistance * SHOT.tailDelayPerMetre),
        channel: 'sfx',
      });
    }

    // A shot near the listener opens space in the mix; a distant one does not.
    if (listenerDistance < 60) this.mixer.push(1 - listenerDistance / 60);
  }

  /**
   * Crack-thump for a round passing close by.
   *
   * The bullet is supersonic, so its crack arrives before the report of the
   * distant rifle that fired it. The delay is the flight the sound still has to
   * make, which the ballistics already knows the length of.
   */
  crackThump(passPoint: THREE.Vector3, missDistance: number, shooterDistance: number): void {
    if (missDistance > CRACK.maxMissDistanceMetres) return;
    const closeness = 1 - missDistance / CRACK.maxMissDistanceMetres;
    this.sfx.play(this.rng.pick(CRACK.crack), {
      at: passPoint,
      gain: CRACK.gain * closeness,
      channel: 'sfx',
    });
    // The thump is the same report, arriving late — sound travels, the round flew.
    this.sfx.play(this.rng.pick(SHOT.byClass.rifle), {
      at: passPoint,
      gain: 0.5 * closeness,
      delay: shooterDistance / CRACK.speedOfSoundMetresPerSecond,
      channel: 'sfx',
    });
  }

  impact(at: THREE.Vector3, material: string): void {
    this.sfx.play(this.rng.pick(IMPACTS[material] ?? IMPACTS.default!), { at, gain: 0.7 });
  }

  explosion(at: THREE.Vector3): void {
    this.sfx.play(this.rng.pick(audioConfig.explosion), { at, gain: 1 });
    this.mixer.push(1);
  }

  // ---- Movimento -----------------------------------------------------------

  /** Footsteps, paced by speed and surfaced by biome. */
  footsteps(dt: number, at: THREE.Vector3, speed: number, biome: string, grounded: boolean): void {
    if (!grounded || speed < 0.6) {
      this.stepTimer = 0;
      return;
    }
    const interval = speed > 4.2 ? STEPS.intervalSprintSeconds : STEPS.intervalWalkSeconds;
    this.stepTimer -= dt;
    if (this.stepTimer > 0) return;
    this.stepTimer = interval;
    const surface = BIOME_SURFACE[biome] ?? 'grass';
    this.sfx.play(this.rng.pick(STEPS[surface] ?? STEPS.grass!), {
      at,
      gain: STEPS.gain,
      playbackRate: 0.94 + this.rng.next() * 0.12,
    });
  }

  /** An engine loop whose pitch rides the rev counter. */
  async engine(at: THREE.Vector3): Promise<Loop | null> {
    return this.sfx.loop(VEHICLE.engineLoop, {
      at,
      gain: VEHICLE.gain,
      channel: 'vehicles',
      playbackRate: VEHICLE.idlePlaybackRate,
    });
  }

  static engineRate(rpm: number, idleRpm: number, maxRpm: number): number {
    const fraction = Math.max(0, Math.min(1, (rpm - idleRpm) / Math.max(1, maxRpm - idleRpm)));
    return VEHICLE.idlePlaybackRate + fraction * VEHICLE.playbackRateRange;
  }

  // ---- Ambiente e música ---------------------------------------------------

  /** Swaps the ambience bed when the biome or the hour changes. */
  async setAmbience(biome: string, isNight: boolean): Promise<void> {
    if (!this.mixer.isRunning) return;
    const id = AMBIENCE[biome] ?? AMBIENCE.campo!;
    if (id !== this.ambienceId) {
      this.ambienceId = id;
      this.ambienceLoop?.stop(AMBIENCE.crossfadeSeconds);
      this.ambienceLoop = await this.sfx.loop(id, { gain: AMBIENCE.gain, channel: 'sfx' });
    }
    if (isNight && !this.nightLoop) {
      this.nightLoop = await this.sfx.loop(AMBIENCE.night!, {
        gain: AMBIENCE.nightGain,
        channel: 'sfx',
      });
    } else if (!isNight && this.nightLoop) {
      this.nightLoop.stop(AMBIENCE.crossfadeSeconds);
      this.nightLoop = null;
    }
  }

  /** Contact with a hostile keeps the combat track up for a while after. */
  reportContact(): void {
    this.combatTimer = MUSIC.combatHoldSeconds;
  }

  get inCombat(): boolean {
    return this.combatTimer > 0;
  }

  async updateMusic(): Promise<void> {
    if (!this.mixer.isRunning) return;
    const pool = this.inCombat ? MUSIC.combat : MUSIC.explore;
    if (this.musicId && pool.includes(this.musicId)) return;
    const next = this.rng.pick(pool);
    if (!next || next === this.musicId) return;
    this.musicId = next;
    this.musicLoop?.stop(MUSIC.crossfadeSeconds);
    this.musicLoop = await this.sfx.loop(next, { gain: 1, channel: 'music' });
  }

  async playDeathTrack(): Promise<void> {
    this.musicLoop?.stop(0.6);
    this.musicId = '';
    this.sfx.play(MUSIC.death, { channel: 'music', gain: 1 });
  }

  // ---- UI ------------------------------------------------------------------

  ui(event: keyof typeof UI | string): void {
    this.sfx.play(UI[event] ?? null, { channel: 'ui', gain: 1 });
  }

  dispose(): void {
    this.ambienceLoop?.stop(0.2);
    this.nightLoop?.stop(0.2);
    this.musicLoop?.stop(0.2);
    this.mixer.dispose();
  }
}
