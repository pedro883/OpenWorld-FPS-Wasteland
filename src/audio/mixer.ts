import audioConfig from '../../config/audio.json';

export const CHANNELS = ['sfx', 'vehicles', 'voices', 'music', 'ui'] as const;
export type Channel = (typeof CHANNELS)[number];

const CFG = audioConfig.channels as unknown as Record<string, number>;
const DUCK = audioConfig.ducking;

/**
 * The mixer: one AudioContext, one gain per channel, and the ducking.
 *
 * Every sound in the game goes through a channel so the options screen can move
 * one slider and have it mean something. The context starts suspended because
 * browsers refuse to play audio before the player has interacted with the page —
 * `resume()` is wired to the same click that grabs the pointer lock.
 */
export class Mixer {
  readonly context: AudioContext;
  readonly master: GainNode;
  private readonly gains = {} as Record<Channel, GainNode>;
  private readonly volumes = {} as Record<Channel, number>;
  private masterVolume: number;
  /** How hard the ducking is pressing right now, 0 (open) to 1 (fully ducked). */
  private duck = 0;

  constructor() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor();
    this.master = this.context.createGain();
    this.masterVolume = CFG.master ?? 0.8;
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.context.destination);

    for (const channel of CHANNELS) {
      const gain = this.context.createGain();
      this.volumes[channel] = CFG[channel] ?? 1;
      gain.gain.value = this.volumes[channel];
      gain.connect(this.master);
      this.gains[channel] = gain;
    }
  }

  get isRunning(): boolean {
    return this.context.state === 'running';
  }

  /** Browsers keep the context suspended until a real user gesture. */
  async resume(): Promise<void> {
    if (this.context.state !== 'running') {
      await this.context.resume().catch(() => undefined);
    }
  }

  destination(channel: Channel): GainNode {
    return this.gains[channel];
  }

  volumeOf(channel: Channel | 'master'): number {
    return channel === 'master' ? this.masterVolume : this.volumes[channel];
  }

  setVolume(channel: Channel | 'master', value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    if (channel === 'master') {
      this.masterVolume = clamped;
      this.master.gain.value = clamped;
      return;
    }
    this.volumes[channel] = clamped;
    this.applyChannel(channel);
  }

  /**
   * Presses the ducking down. Called on every shot near the listener.
   *
   * The attack is immediate and the release is slow, which is what makes a
   * firefight sit on top of the music instead of fighting it: the first round
   * opens the space and continued fire holds it open.
   */
  push(amount = 1): void {
    this.duck = Math.max(this.duck, Math.max(0, Math.min(1, amount)));
    this.applyChannel('music');
    this.applyChannel('sfx');
  }

  update(dt: number): void {
    if (this.duck <= 0) return;
    this.duck = Math.max(0, this.duck - dt / DUCK.releaseSeconds);
    this.applyChannel('music');
  }

  private applyChannel(channel: Channel): void {
    const gain = this.gains[channel];
    const base = this.volumes[channel];
    // Only music and ambience get pushed aside; the shot itself must not duck.
    const factor =
      channel === 'music' ? 1 - this.duck * (1 - DUCK.musicDuck) : 1;
    gain.gain.setTargetAtTime(base * factor, this.context.currentTime, DUCK.attackSeconds);
  }

  /** Volumes as they should be written to the save. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = { master: this.masterVolume };
    for (const channel of CHANNELS) out[channel] = this.volumes[channel];
    return out;
  }

  load(volumes: Record<string, number> | undefined): void {
    if (!volumes) return;
    for (const [channel, value] of Object.entries(volumes)) {
      if (channel === 'master' || (CHANNELS as readonly string[]).includes(channel)) {
        this.setVolume(channel as Channel | 'master', value);
      }
    }
  }

  get duckAmount(): number {
    return this.duck;
  }

  dispose(): void {
    void this.context.close().catch(() => undefined);
  }
}
