/**
 * Fixed-capacity object pool. Bullets, decals, particles and audio voices all
 * churn hard enough that per-shot allocation shows up as GC stutter.
 */
export class Pool<T> {
  private readonly items: T[] = [];
  private readonly free: number[] = [];
  private readonly activeSet = new Set<number>();

  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void,
    capacity: number,
  ) {
    for (let i = 0; i < capacity; i++) {
      this.items.push(factory());
      this.free.push(i);
    }
  }

  /** Returns null when exhausted — callers must degrade, never allocate. */
  acquire(): { handle: number; item: T } | null {
    const handle = this.free.pop();
    if (handle === undefined) return null;
    this.activeSet.add(handle);
    return { handle, item: this.items[handle]! };
  }

  release(handle: number): void {
    if (!this.activeSet.delete(handle)) return;
    this.reset(this.items[handle]!);
    this.free.push(handle);
  }

  get(handle: number): T | undefined {
    return this.items[handle];
  }

  get activeCount(): number {
    return this.activeSet.size;
  }

  get capacity(): number {
    return this.items.length;
  }

  active(): IterableIterator<number> {
    return this.activeSet.values();
  }

  releaseAll(): void {
    for (const handle of [...this.activeSet]) this.release(handle);
  }

  /** Rebuilds every slot — used when the pooled type owns GPU resources. */
  rebuild(): void {
    this.releaseAll();
    for (let i = 0; i < this.items.length; i++) this.items[i] = this.factory();
  }
}
