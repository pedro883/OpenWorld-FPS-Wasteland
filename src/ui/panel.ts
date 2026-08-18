/**
 * Base for the full-screen panels: map, inventory and arsenal.
 *
 * Opening one releases the pointer lock, because a panel the mouse cannot reach
 * is not a panel. The simulation keeps running underneath — this is a wasteland,
 * and reading your inventory in the open should not be free.
 */
export abstract class Panel {
  protected readonly root: HTMLDivElement;
  protected readonly body: HTMLDivElement;
  private open = false;
  /** Called when the panel closes, so the scene can re-lock the pointer. */
  onClose: (() => void) | null = null;

  constructor(id: string, title: string) {
    this.root = document.createElement('div');
    this.root.className = 'panel hidden';
    this.root.id = id;

    const frame = document.createElement('div');
    frame.className = 'panel-frame';

    const header = document.createElement('div');
    header.className = 'panel-header';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const close = document.createElement('button');
    close.className = 'panel-close';
    close.textContent = 'Fechar (Esc)';
    close.addEventListener('click', () => this.hide());
    header.append(heading, close);

    this.body = document.createElement('div');
    this.body.className = 'panel-body';

    frame.append(header, this.body);
    this.root.append(frame);
    document.body.append(this.root);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.root.classList.remove('hidden');
    if (document.pointerLockElement) document.exitPointerLock();
    this.onShow();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
    this.onClose?.();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  /** Rebuilt every time the panel opens, so it never shows stale numbers. */
  protected abstract onShow(): void;

  dispose(): void {
    this.root.remove();
  }
}

/** A labelled row of the kind every one of these panels is made of. */
export function row(...cells: (string | HTMLElement)[]): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'panel-row';
  for (const cell of cells) {
    if (typeof cell === 'string') {
      const span = document.createElement('span');
      span.textContent = cell;
      el.append(span);
    } else {
      el.append(cell);
    }
  }
  return el;
}

export function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = `panel-button ${className}`.trim();
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}
