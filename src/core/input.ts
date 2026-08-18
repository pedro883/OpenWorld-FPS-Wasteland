/**
 * Keyboard + mouse state with Pointer Lock. Reads are edge-aware: `pressed()`
 * is true only on the frame a key went down, which the fixed tick consumes.
 */
class Input {
  private readonly down = new Set<string>();
  private readonly justPressed = new Set<string>();
  private readonly justReleased = new Set<string>();
  private readonly mouseDown = new Set<number>();
  private readonly mouseJustPressed = new Set<number>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  locked = false;

  private canvas: HTMLCanvasElement | null = null;

  attach(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    canvas.addEventListener('click', () => void this.requestLock());
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // F-keys belong to the debug overlay; everything else is gameplay.
    if (e.code.startsWith('F') && e.code.length <= 3) return;
    this.down.add(e.code);
    this.justPressed.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.justReleased.add(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += e.movementX;
    this.mouseDY += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    this.mouseDown.add(e.button);
    this.mouseJustPressed.add(e.button);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.mouseDown.delete(e.button);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.wheelDelta += e.deltaY;
  };

  /** Losing focus must clear held keys or the player keeps sprinting forever. */
  private readonly onBlur = (): void => {
    this.down.clear();
    this.mouseDown.clear();
  };

  private readonly onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.down.clear();
  };

  async requestLock(): Promise<void> {
    if (!this.canvas || this.locked) return;
    try {
      await this.canvas.requestPointerLock();
    } catch {
      /* browser refused (user gesture cooldown) — next click will retry */
    }
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  pressed(code: string): boolean {
    return this.justPressed.has(code);
  }

  released(code: string): boolean {
    return this.justReleased.has(code);
  }

  isMouseDown(button: number): boolean {
    return this.mouseDown.has(button);
  }

  mousePressed(button: number): boolean {
    return this.mouseJustPressed.has(button);
  }

  /**
   * Consumes the edge-triggered state. This must run at the end of a *fixed*
   * step, not the frame: the render loop outruns the 60 Hz simulation, so most
   * frames execute zero fixed steps, and clearing there would drop presses
   * before gameplay ever saw them.
   */
  endFixedStep(): void {
    this.justPressed.clear();
    this.justReleased.clear();
    this.mouseJustPressed.clear();
  }

  /**
   * Consumes the continuous look state. This is per *frame*, because mouse
   * deltas drive the camera, which is presentation and not simulation.
   */
  endFrame(): void {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}

export const input = new Input();
export const MOUSE_LEFT = 0;
export const MOUSE_RIGHT = 2;
