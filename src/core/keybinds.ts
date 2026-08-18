/**
 * Named actions and the keys bound to them.
 *
 * The rest of the game asks for actions, never for `KeyW`. That indirection is
 * what makes the options screen able to rebind anything, and it is also what
 * keeps a non-QWERTY player from having to fight the movement keys — `code`
 * values are physical positions, so a rebind sticks regardless of layout.
 */
export const ACTIONS = {
  forward: 'Andar para frente',
  back: 'Andar para trás',
  left: 'Esquerda',
  right: 'Direita',
  sprint: 'Correr',
  jump: 'Pular',
  crouch: 'Agachar',
  prone: 'Deitar',
  reload: 'Recarregar',
  fireMode: 'Modo de tiro',
  interact: 'Interagir',
  map: 'Mapa',
  inventory: 'Mochila',
  shop: 'Arsenal',
  options: 'Opções',
  vehicleCamera: 'Câmera do veículo',
  vehicleRecover: 'Desvirar veículo',
} as const;

export type Action = keyof typeof ACTIONS;

const DEFAULTS: Record<Action, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  sprint: 'ShiftLeft',
  jump: 'Space',
  crouch: 'KeyC',
  prone: 'KeyX',
  reload: 'KeyR',
  fireMode: 'KeyB',
  interact: 'KeyE',
  map: 'KeyM',
  inventory: 'KeyI',
  shop: 'KeyL',
  options: 'KeyO',
  vehicleCamera: 'KeyV',
  vehicleRecover: 'KeyZ',
};

/** Keys the game must never hand over, because the browser or debug owns them. */
const RESERVED = new Set(['Escape', 'F1', 'F5', 'F11', 'F12', 'Tab']);

export class Keybinds {
  private readonly bindings: Record<Action, string> = { ...DEFAULTS };

  get(action: Action): string {
    return this.bindings[action];
  }

  /** Human-readable key name, for the options list. */
  label(action: Action): string {
    return Keybinds.describe(this.bindings[action]);
  }

  static describe(code: string): string {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return code.slice(5);
    if (code === 'Space') return 'Espaço';
    if (code.startsWith('Shift')) return `Shift ${code.endsWith('Right') ? 'dir' : 'esq'}`;
    if (code.startsWith('Control')) return `Ctrl ${code.endsWith('Right') ? 'dir' : 'esq'}`;
    if (code.startsWith('Alt')) return `Alt ${code.endsWith('Right') ? 'dir' : 'esq'}`;
    return code;
  }

  static isBindable(code: string): boolean {
    return !RESERVED.has(code);
  }

  /**
   * Binds a key, taking it off whatever held it before.
   *
   * Leaving a duplicate would give one keypress two meanings, and the loser is
   * decided by iteration order — a bug that looks random from the outside.
   */
  set(action: Action, code: string): boolean {
    if (!Keybinds.isBindable(code)) return false;
    for (const other of Object.keys(this.bindings) as Action[]) {
      if (other !== action && this.bindings[other] === code) {
        this.bindings[other] = '';
      }
    }
    this.bindings[action] = code;
    return true;
  }

  /** Which action a key triggers, or null. */
  actionFor(code: string): Action | null {
    for (const action of Object.keys(this.bindings) as Action[]) {
      if (this.bindings[action] === code) return action;
    }
    return null;
  }

  reset(): void {
    Object.assign(this.bindings, DEFAULTS);
  }

  /** Actions left without a key, so the options screen can flag them. */
  unbound(): Action[] {
    return (Object.keys(this.bindings) as Action[]).filter((a) => !this.bindings[a]);
  }

  toJSON(): Record<string, string> {
    return { ...this.bindings };
  }

  /** Restores saved bindings, ignoring actions and keys that no longer apply. */
  load(saved: Record<string, string> | undefined): void {
    if (!saved) return;
    this.reset();
    for (const [action, code] of Object.entries(saved)) {
      if (!(action in DEFAULTS)) continue;
      if (typeof code !== 'string') continue;
      if (code && !Keybinds.isBindable(code)) continue;
      this.bindings[action as Action] = code;
    }
  }
}

export const keybinds = new Keybinds();
