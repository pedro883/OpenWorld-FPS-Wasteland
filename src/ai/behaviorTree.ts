export type Status = 'success' | 'failure' | 'running';

export interface TickContext {
  dt: number;
  /** Path of node names taken this tick, for the debug overlay. */
  trace: string[];
}

export abstract class Node {
  constructor(readonly name: string) {}
  abstract tick(ctx: TickContext): Status;
  /** Called when a node that was running is abandoned. */
  reset(): void {}
}

/** Runs children in order; fails on the first failure. */
export class Sequence extends Node {
  private index = 0;

  constructor(name: string, private readonly children: Node[]) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    while (this.index < this.children.length) {
      const child = this.children[this.index]!;
      const status = child.tick(ctx);
      if (status === 'running') return 'running';
      if (status === 'failure') {
        this.reset();
        return 'failure';
      }
      this.index++;
    }
    this.reset();
    return 'success';
  }

  override reset(): void {
    if (this.index < this.children.length) this.children[this.index]?.reset();
    this.index = 0;
  }
}

/** Runs children in order; succeeds on the first success. */
export class Selector extends Node {
  private index = 0;

  constructor(name: string, private readonly children: Node[]) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    while (this.index < this.children.length) {
      const child = this.children[this.index]!;
      const status = child.tick(ctx);
      if (status === 'running') return 'running';
      if (status === 'success') {
        this.reset();
        return 'success';
      }
      this.index++;
    }
    this.reset();
    return 'failure';
  }

  override reset(): void {
    if (this.index < this.children.length) this.children[this.index]?.reset();
    this.index = 0;
  }
}

/**
 * Sequence that re-evaluates **every** child from the start on each tick.
 *
 * A plain Sequence remembers which child was running and resumes there, which
 * means its guard conditions are never checked again: an agent that entered
 * "pinned down" while suppressed stays pinned forever, because the action keeps
 * returning `running` and the condition in front of it is skipped. Any branch
 * whose first children are guards must use this instead.
 */
export class ReactiveSequence extends Node {
  private running: Node | null = null;

  constructor(name: string, private readonly children: Node[]) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    for (const child of this.children) {
      const status = child.tick(ctx);
      if (status === 'failure') {
        if (this.running && this.running !== child) this.running.reset();
        this.running = null;
        return 'failure';
      }
      if (status === 'running') {
        if (this.running && this.running !== child) this.running.reset();
        this.running = child;
        return 'running';
      }
    }
    this.running = null;
    return 'success';
  }

  override reset(): void {
    this.running?.reset();
    this.running = null;
  }
}

/**
 * Selector that re-evaluates from the top every tick, aborting a running child
 * when an earlier branch becomes viable.
 *
 * This is what lets an agent drop what it is doing the instant it is shot at —
 * a plain Selector would finish patrolling to the next waypoint first.
 */
export class PrioritySelector extends Node {
  private running = -1;

  constructor(name: string, private readonly children: Node[]) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    for (let i = 0; i < this.children.length; i++) {
      const child = this.children[i]!;
      const status = child.tick(ctx);
      if (status === 'failure') continue;
      if (this.running !== -1 && this.running !== i) {
        this.children[this.running]?.reset();
      }
      this.running = status === 'running' ? i : -1;
      return status;
    }
    if (this.running !== -1) {
      this.children[this.running]?.reset();
      this.running = -1;
    }
    return 'failure';
  }

  override reset(): void {
    if (this.running !== -1) this.children[this.running]?.reset();
    this.running = -1;
  }
}

export class Condition extends Node {
  constructor(name: string, private readonly predicate: () => boolean) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    const ok = this.predicate();
    if (ok) ctx.trace.push(this.name);
    return ok ? 'success' : 'failure';
  }
}

export class Action extends Node {
  constructor(
    name: string,
    private readonly run: (ctx: TickContext) => Status,
    private readonly onReset?: () => void,
  ) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    const status = this.run(ctx);
    if (status !== 'failure') ctx.trace.push(this.name);
    return status;
  }

  override reset(): void {
    this.onReset?.();
  }
}

export class Inverter extends Node {
  constructor(name: string, private readonly child: Node) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    const status = this.child.tick(ctx);
    if (status === 'running') return 'running';
    return status === 'success' ? 'failure' : 'success';
  }

  override reset(): void {
    this.child.reset();
  }
}

/** Blocks its child until `seconds` have passed since it last succeeded. */
export class Cooldown extends Node {
  private remaining = 0;

  constructor(name: string, private readonly seconds: number, private readonly child: Node) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    if (this.remaining > 0) {
      this.remaining -= ctx.dt;
      return 'failure';
    }
    const status = this.child.tick(ctx);
    if (status === 'success') this.remaining = this.seconds;
    return status;
  }

  override reset(): void {
    this.child.reset();
  }
}

/** Runs the child forever, mapping success and failure back to running. */
export class Repeat extends Node {
  constructor(name: string, private readonly child: Node) {
    super(name);
  }

  tick(ctx: TickContext): Status {
    const status = this.child.tick(ctx);
    if (status === 'running') return 'running';
    this.child.reset();
    return 'running';
  }

  override reset(): void {
    this.child.reset();
  }
}
