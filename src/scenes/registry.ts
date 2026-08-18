import type { Scene } from './types';
import { SandboxScene } from './sandbox';
import { SmokeScene } from './smoke';

type SceneFactory = () => Scene;

/**
 * Scenes are selectable with ?scene=<name> so each system can be iterated on
 * in isolation without paying for the full world load.
 */
export const scenes: Record<string, SceneFactory> = {
  sandbox: () => new SandboxScene(),
  smoke: () => new SmokeScene(),
};

export const DEFAULT_SCENE = 'sandbox';

export function resolveScene(name: string | null): { name: string; create: SceneFactory } {
  const key = name && name in scenes ? name : DEFAULT_SCENE;
  return { name: key, create: scenes[key]! };
}
