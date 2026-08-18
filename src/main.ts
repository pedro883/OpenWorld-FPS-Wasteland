import { GameLoop } from './core/loop';
import { input } from './core/input';
import { profiler } from './core/profiler';
import { RenderContext } from './render/renderer';
import { initPhysics, PhysicsWorld } from './physics/world';
import { debugOverlay } from './debug/overlay';
import { assets } from './core/assets';
import { resolveScene } from './scenes/registry';
import type { Scene } from './scenes/types';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  const bootEl = document.getElementById('boot');
  if (!canvas) throw new Error('#viewport canvas ausente no index.html');

  await Promise.all([initPhysics(), assets.init()]);

  const render = new RenderContext(canvas);
  const physics = new PhysicsWorld();
  input.attach(canvas);

  const requested = new URLSearchParams(location.search).get('scene');
  const { name, create } = resolveScene(requested);
  const scene: Scene = create();

  const loop = new GameLoop({
    fixed: (dt) => {
      profiler.begin('physics');
      scene.fixed(dt);
      profiler.end('physics');
      // Key/button edges belong to the simulation step that consumed them.
      input.endFixedStep();
    },
    render: (alpha, dt) => {
      profiler.begin('other');
      scene.frame(alpha, dt);
      profiler.end('other');

      profiler.begin('render');
      render.render();
      profiler.end('render');

      debugOverlay.update(dt, loop, render.renderer);
      // Mouse deltas are per-frame: the camera reads them here, in render.
      input.endFrame();
    },
  });

  await scene.init({ render, physics, loop });

  debugOverlay.registerSection('scene', () => `${name}   sim ${loop.simTime.toFixed(0)}s`);

  // Dev-only handle so scenes can be inspected and driven from the console.
  if (import.meta.env.DEV) {
    (globalThis as unknown as Record<string, unknown>).__wasteland = {
      render,
      physics,
      loop,
      scene,
      assets,
      input,
    };
  }
  bootEl?.classList.add('hidden');
  loop.start();

  // Hot reload would otherwise leak the WebGL context and the Rapier world.
  import.meta.hot?.dispose(() => {
    loop.stop();
    scene.dispose();
    physics.dispose();
    render.dispose();
  });
}

boot().catch((err: unknown) => {
  const bootEl = document.getElementById('boot');
  const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
  if (bootEl) {
    bootEl.classList.add('error');
    bootEl.classList.remove('hidden');
    bootEl.textContent = `Falha no boot:\n\n${message}`;
  }
  console.error(err);
});
