import type { RenderContext } from '../render/renderer';
import type { PhysicsWorld } from '../physics/world';
import type { GameLoop } from '../core/loop';

export interface SceneContext {
  render: RenderContext;
  physics: PhysicsWorld;
  loop: GameLoop;
}

export interface Scene {
  readonly name: string;
  init(ctx: SceneContext): Promise<void> | void;
  /** Fixed 60 Hz simulation step. */
  fixed(dt: number): void;
  /** Presentation step; `alpha` blends the last two fixed states. */
  frame(alpha: number, dt: number): void;
  dispose(): void;
}
