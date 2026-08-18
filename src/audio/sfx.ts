import * as THREE from 'three';
import audioConfig from '../../config/audio.json';
import { assets } from '../core/assets';
import { Random } from '../core/random';
import type { Channel, Mixer } from './mixer';

const SPATIAL = audioConfig.spatial;

export interface PlayOptions {
  channel?: Channel;
  gain?: number;
  /** Where the sound is in the world; omitted means non-spatial (UI, viewmodel). */
  at?: THREE.Vector3;
  /** Seconds to wait before it starts — the whole point of a crack-thump. */
  delay?: number;
  playbackRate?: number;
  loop?: boolean;
}

export interface Loop {
  setPlaybackRate(rate: number): void;
  setGain(value: number): void;
  setPosition(position: THREE.Vector3): void;
  stop(fadeSeconds?: number): void;
}

/**
 * One-shot and looping sound playback, spatialised through PannerNode HRTF.
 *
 * Buffers are decoded on first use and cached by the asset manager, so a sound
 * fired a hundred times decodes once. Voices are capped: an unbounded firefight
 * will happily ask for two hundred simultaneous sources and starve the audio
 * thread, and past a couple of dozen nobody can hear the difference anyway.
 */
export class Sfx {
  private readonly rng = new Random(0xa17d10);
  private active = 0;
  private readonly pending = new Set<string>();

  constructor(private readonly mixer: Mixer) {}

  get voiceCount(): number {
    return this.active;
  }

  /** Moves the listener; called once a frame from the camera. */
  setListener(position: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3): void {
    const listener = this.mixer.context.listener;
    if (listener.positionX) {
      const t = this.mixer.context.currentTime;
      listener.positionX.setValueAtTime(position.x, t);
      listener.positionY.setValueAtTime(position.y, t);
      listener.positionZ.setValueAtTime(position.z, t);
      listener.forwardX.setValueAtTime(forward.x, t);
      listener.forwardY.setValueAtTime(forward.y, t);
      listener.forwardZ.setValueAtTime(forward.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
    } else {
      // Safari still only has the deprecated form.
      listener.setPosition?.(position.x, position.y, position.z);
      listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  pick(ids: readonly string[]): string | null {
    return this.rng.pick(ids);
  }

  private panner(at: THREE.Vector3): PannerNode {
    const panner = this.mixer.context.createPanner();
    panner.panningModel = SPATIAL.panningModel as PanningModelType;
    panner.distanceModel = SPATIAL.distanceModel as DistanceModelType;
    panner.refDistance = SPATIAL.refDistanceMeters;
    panner.maxDistance = SPATIAL.maxDistanceMeters;
    panner.rolloffFactor = SPATIAL.rolloffFactor;
    panner.positionX.value = at.x;
    panner.positionY.value = at.y;
    panner.positionZ.value = at.z;
    return panner;
  }

  /** Fires a one-shot. Returns immediately; loading happens in the background. */
  play(id: string | null, options: PlayOptions = {}): void {
    if (!id || !this.mixer.isRunning) return;
    if (this.active >= SPATIAL.voiceLimit) return;

    const start = () => {
      const buffer = assets.audioBuffer(id);
      if (!buffer) return;
      this.active++;
      const source = this.mixer.context.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = options.playbackRate ?? 1;
      const gain = this.mixer.context.createGain();
      gain.gain.value = options.gain ?? 1;

      let node: AudioNode = gain;
      if (options.at) {
        const panner = this.panner(options.at);
        gain.connect(panner);
        node = panner;
      }
      source.connect(gain);
      node.connect(this.mixer.destination(options.channel ?? 'sfx'));
      source.onended = () => {
        this.active--;
        source.disconnect();
        gain.disconnect();
        if (node !== gain) node.disconnect();
      };
      source.start(this.mixer.context.currentTime + (options.delay ?? 0));
    };

    if (assets.audioBuffer(id)) {
      start();
      return;
    }
    // Not decoded yet: fetch once, and let this particular shot go unheard
    // rather than firing late, which reads worse than silence.
    if (this.pending.has(id)) return;
    this.pending.add(id);
    void assets
      .loadAudio(this.mixer.context, id)
      .catch(() => null)
      .finally(() => this.pending.delete(id));
  }

  /** Starts a loop the caller keeps a handle on — engines, ambience, music. */
  async loop(id: string, options: PlayOptions = {}): Promise<Loop | null> {
    if (!this.mixer.isRunning) return null;
    const buffer = await assets.loadAudio(this.mixer.context, id).catch(() => null);
    if (!buffer) return null;

    const ctx = this.mixer.context;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = options.playbackRate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = options.gain ?? 1;

    let node: AudioNode = gain;
    let panner: PannerNode | null = null;
    if (options.at) {
      panner = this.panner(options.at);
      gain.connect(panner);
      node = panner;
    }
    source.connect(gain);
    node.connect(this.mixer.destination(options.channel ?? 'sfx'));
    source.start();

    let stopped = false;
    return {
      setPlaybackRate: (rate) => {
        if (!stopped) source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.08);
      },
      setGain: (value) => {
        if (!stopped) gain.gain.setTargetAtTime(value, ctx.currentTime, 0.12);
      },
      setPosition: (position) => {
        if (stopped || !panner) return;
        panner.positionX.setValueAtTime(position.x, ctx.currentTime);
        panner.positionY.setValueAtTime(position.y, ctx.currentTime);
        panner.positionZ.setValueAtTime(position.z, ctx.currentTime);
      },
      stop: (fadeSeconds = 0.25) => {
        if (stopped) return;
        stopped = true;
        gain.gain.setTargetAtTime(0, ctx.currentTime, fadeSeconds / 3);
        // Stopping after the fade, not with it, or the tail is a click.
        source.stop(ctx.currentTime + fadeSeconds);
        source.onended = () => {
          source.disconnect();
          gain.disconnect();
          panner?.disconnect();
        };
      },
    };
  }

  /** Warms the cache for sounds that must not miss their first play. */
  async preload(ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map((id) => assets.loadAudio(this.mixer.context, id).catch(() => null)),
    );
  }
}
