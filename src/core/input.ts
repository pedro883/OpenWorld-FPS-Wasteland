import { keybinds, type Action } from './keybinds';

/** Gamepad axis noise floor; sticks rarely rest at exactly zero. */
const STICK_DEADZONE = 0.18;
/** Right stick sensitivity, in the same units as a mouse delta per frame. */
const STICK_LOOK_SPEED = 13;

/**
 * Keyboard, mouse and gamepad state with Pointer Lock. Reads are edge-aware:
 * `pressed()` is true only on the frame a key went down, which the fixed tick
 * consumes.
 *
 * Gameplay asks for **actions** (`actionDown('forward')`), not for key codes, so
 * every binding is remappable and the gamepad can answer the same questions the
 * keyboard does.
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

  /** Gamepad state, refreshed once per frame from the browser's snapshot. */
  private padAxes: number[] = [];
  private padButtons: boolean[] = [];
  private padPrevious: boolean[] = [];
  padConnected = false;
  /** Look delta contributed by the right stick this frame. */
  padLookX = 0;
  padLookY = 0;

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

  /**
   * Reads the pad once per frame.
   *
   * The browser hands out a fresh snapshot object on every call, so polling it
   * from several places would read several different instants; doing it once at
   * the top of the frame keeps every consumer on the same input.
   */
  pollGamepad(): void {
    this.padPrevious = this.padButtons;
    const pads = navigator.getGamepads?.() ?? [];
    const pad = [...pads].find((p) => p && p.connected) ?? null;
    this.padConnected = !!pad;
    if (!pad) {
      this.padAxes = [];
      this.padButtons = [];
      this.padLookX = 0;
      this.padLookY = 0;
      return;
    }
    this.padAxes = [...pad.axes];
    this.padButtons = pad.buttons.map((b) => b.pressed || b.value > 0.5);

    const lx = this.deadzone(this.padAxes[2] ?? 0);
    const ly = this.deadzone(this.padAxes[3] ?? 0);
    // Squared response: fine aim near the centre, fast turns at the edge.
    this.padLookX = lx * Math.abs(lx) * STICK_LOOK_SPEED;
    this.padLookY = ly * Math.abs(ly) * STICK_LOOK_SPEED;
  }

  private deadzone(value: number): number {
    if (Math.abs(value) < STICK_DEADZONE) return 0;
    const sign = Math.sign(value);
    return sign * ((Math.abs(value) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  }

  /** Left stick, as a movement intent in the same shape the keyboard gives. */
  get padMove(): { forward: number; strafe: number } {
    return {
      forward: -this.deadzone(this.padAxes[1] ?? 0),
      strafe: this.deadzone(this.padAxes[0] ?? 0),
    };
  }

  private padIndexFor(action: Action): number {
    // Standard mapping: the layout every modern pad reports.
    switch (action) {
      case 'jump':
        return 0;
      case 'interact':
        return 2;
      case 'reload':
        return 3;
      case 'crouch':
        return 1;
      case 'sprint':
        return 10;
      case 'map':
        return 8;
      case 'inventory':
        return 9;
      case 'fireMode':
        return 5;
      default:
        return -1;
    }
  }

  private padDown(action: Action): boolean {
    const index = this.padIndexFor(action);
    return index >= 0 && this.padButtons[index] === true;
  }

  private padPressed(action: Action): boolean {
    const index = this.padIndexFor(action);
    return index >= 0 && this.padButtons[index] === true && this.padPrevious[index] !== true;
  }

  /** Triggers: right for firing, left for aiming. */
  get padFire(): boolean {
    return this.padButtons[7] === true;
  }

  get padAds(): boolean {
    return this.padButtons[6] === true;
  }

  async requestLock(): Promise<void> {
    if (!this.canvas || this.locked) return;
    try {
      await this.canvas.requestPointerLock();
    } catch {
      /* browser refused (user gesture cooldown) — next click will retry */
    }
  }

  /** True while the key bound to `action` is held, or its pad button is. */
  actionDown(action: Action): boolean {
    const code = keybinds.get(action);
    if (code && this.down.has(code)) return true;
    return this.padDown(action);
  }

  /** True only on the tick the action started. */
  actionPressed(action: Action): boolean {
    const code = keybinds.get(action);
    if (code && this.justPressed.has(code)) return true;
    return this.padPressed(action);
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
