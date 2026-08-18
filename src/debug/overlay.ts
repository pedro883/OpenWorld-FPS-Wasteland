import type * as THREE from 'three';
import { BUDGETS, profiler, type BudgetName } from '../core/profiler';
import type { GameLoop } from '../core/loop';

interface Toggle {
  key: string;
  label: string;
  get(): boolean;
  set(value: boolean): void;
}

type SectionFn = () => string;

/**
 * Single debug surface for the whole game. Every new system registers its own
 * toggle here rather than inventing another key handler, per the spec's rule
 * that each system ships with a matching debug switch.
 */
class DebugOverlay {
  private readonly root: HTMLDivElement;
  private readonly body: HTMLPreElement;
  private readonly toggles: Toggle[] = [];
  private readonly sections = new Map<string, SectionFn>();
  private visible = true;
  private accum = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'debug-overlay';
    this.body = document.createElement('pre');
    this.root.appendChild(this.body);
    document.body.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      if (e.code === 'F1') {
        e.preventDefault();
        this.visible = !this.visible;
        this.root.style.display = this.visible ? 'block' : 'none';
        return;
      }
      const toggle = this.toggles.find((t) => t.key === e.code);
      if (toggle) {
        e.preventDefault();
        toggle.set(!toggle.get());
      }
    });
  }

  registerToggle(key: string, label: string, get: () => boolean, set: (v: boolean) => void): void {
    this.toggles.push({ key, label, get, set });
  }

  /** Adds a named block of live text; return '' to hide it this frame. */
  registerSection(name: string, fn: SectionFn): void {
    this.sections.set(name, fn);
  }

  removeSection(name: string): void {
    this.sections.delete(name);
  }

  update(dt: number, loop: GameLoop, renderer: THREE.WebGLRenderer): void {
    if (!this.visible) return;
    // Refreshing DOM text every frame is itself a cost; 10 Hz is plenty.
    this.accum += dt;
    if (this.accum < 0.1) return;
    this.accum = 0;

    const info = renderer.info;
    const lines: string[] = [];
    lines.push(`FPS ${loop.fps.toFixed(0).padStart(3)}   frame ${(1000 / Math.max(loop.fps, 1)).toFixed(1)} ms`);
    lines.push('');
    lines.push('BUDGET (ms)');
    for (const name of Object.keys(BUDGETS) as BudgetName[]) {
      const value = profiler.get(name);
      const budget = BUDGETS[name];
      const bar = value > budget ? '  OVER' : '';
      lines.push(`  ${name.padEnd(8)} ${value.toFixed(2).padStart(6)} / ${budget}${bar}`);
    }
    lines.push(`  ${'fixed'.padEnd(8)} ${profiler.get('fixed').toFixed(2).padStart(6)}`);
    lines.push('');
    lines.push('RENDER');
    lines.push(`  draws ${info.render.calls}   tris ${info.render.triangles.toLocaleString('en-US')}`);
    lines.push(`  geom  ${info.memory.geometries}   tex ${info.memory.textures}   progs ${info.programs?.length ?? 0}`);

    const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    if (mem) lines.push(`  heap  ${(mem.usedJSHeapSize / 1048576).toFixed(1)} MB`);

    for (const [name, fn] of this.sections) {
      const text = fn();
      if (!text) continue;
      lines.push('');
      lines.push(name.toUpperCase());
      for (const line of text.split('\n')) lines.push(`  ${line}`);
    }

    if (this.toggles.length) {
      lines.push('');
      lines.push('TOGGLES  (F1 hides panel)');
      for (const t of this.toggles) {
        lines.push(`  [${t.get() ? 'x' : ' '}] ${t.key.replace('Key', '').replace('Digit', '')}  ${t.label}`);
      }
    }

    this.body.textContent = lines.join('\n');
  }
}

export const debugOverlay = new DebugOverlay();
