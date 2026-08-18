/**
 * Per-frame time budget tracker. The spec sets a hard budget per subsystem
 * (render <= 8 ms, physics <= 3 ms, ai <= 2 ms, other <= 3 ms), so every
 * section is measured separately and smoothed with an EMA to stay readable.
 */
export type BudgetName = 'render' | 'physics' | 'ai' | 'world' | 'other';

export const BUDGETS: Record<BudgetName, number> = {
  render: 8,
  physics: 3,
  ai: 2,
  world: 2,
  other: 3,
};

const SMOOTHING = 0.1;

export class Profiler {
  private readonly current = new Map<string, number>();
  private readonly smoothed = new Map<string, number>();
  private readonly starts = new Map<string, number>();

  begin(name: string): void {
    this.starts.set(name, performance.now());
  }

  end(name: string): void {
    const start = this.starts.get(name);
    if (start === undefined) return;
    const elapsed = performance.now() - start;
    this.current.set(name, (this.current.get(name) ?? 0) + elapsed);
    this.starts.delete(name);
  }

  measure<T>(name: string, fn: () => T): T {
    this.begin(name);
    try {
      return fn();
    } finally {
      this.end(name);
    }
  }

  /** Folds this frame's accumulated totals into the smoothed values. */
  flush(): void {
    for (const [name, value] of this.current) {
      const prev = this.smoothed.get(name) ?? value;
      this.smoothed.set(name, prev + (value - prev) * SMOOTHING);
    }
    this.current.clear();
  }

  get(name: string): number {
    return this.smoothed.get(name) ?? 0;
  }

  names(): string[] {
    return [...this.smoothed.keys()];
  }
}

export const profiler = new Profiler();
