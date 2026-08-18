import { profiler } from './profiler';

export const FIXED_HZ = 60;
export const FIXED_DT = 1 / FIXED_HZ;

/** Above this many catch-up steps we drop time instead of spiralling. */
const MAX_STEPS_PER_FRAME = 5;

export interface LoopHandlers {
  /** Simulation tick. Always receives exactly FIXED_DT. */
  fixed(dt: number): void;
  /** Presentation. `alpha` is the 0..1 blend between the last two fixed states. */
  render(alpha: number, frameDt: number): void;
}

export class GameLoop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;

  /** Wall-clock seconds since start, advanced only by consumed fixed steps. */
  simTime = 0;
  frameCount = 0;
  /** Smoothed frames per second, for the debug overlay. */
  fps = 0;

  constructor(private readonly handlers: LoopHandlers) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameDt = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // A backgrounded tab produces a huge dt on return; clamp before it reaches
    // the accumulator so the simulation never tries to catch up by seconds.
    if (frameDt > 0.25) frameDt = 0.25;

    this.fps += (1 / Math.max(frameDt, 1e-6) - this.fps) * 0.1;
    this.accumulator += frameDt;

    let steps = 0;
    profiler.begin('fixed');
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.handlers.fixed(FIXED_DT);
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      steps++;
    }
    profiler.end('fixed');

    // Discard leftover time rather than letting it build up forever.
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

    this.handlers.render(this.accumulator / FIXED_DT, frameDt);
    this.frameCount++;
    profiler.flush();
  };
}
