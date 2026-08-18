import type { Scene } from './types';
import { SandboxScene } from './sandbox';
import { SmokeScene } from './smoke';
import { PlayerTestScene } from './playerTest';
import { WorldScene } from './world';

type SceneFactory = () => Scene;

/**
 * Scenes are selectable with ?scene=<name> so each system can be iterated on
 * in isolation without paying for the full world load.
 */
export const scenes: Record<string, SceneFactory> = {
  sandbox: () => new SandboxScene(),
  smoke: () => new SmokeScene(),
  player: () => new PlayerTestScene(),
  world: () => new WorldScene(),
};

export const DEFAULT_SCENE = 'world';

export function resolveScene(name: string | null): { name: string; create: SceneFactory } {
  const key = name && name in scenes ? name : DEFAULT_SCENE;
  return { name: key, create: scenes[key]! };
}
