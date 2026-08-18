import type { Grid } from '../inventory/grid';
import type { InventorySystem } from '../inventory/inventorySystem';
import { EQUIP_SLOTS, footprintOf, type EquipSlot, type ItemBase, type Rotation } from '../inventory/types';
import { Panel } from './panel';
import { iconElement } from './itemIcons';

const CELL_PX = 34;

const SLOT_LABEL: Record<EquipSlot, string> = {
  primary: 'Primária',
  secondary: 'Secundária',
  holster: 'Coldre',
  helmet: 'Capacete',
  armour: 'Colete',
  headset: 'Headset',
  backpack: 'Mochila',
  rig: 'Rig',
  pockets: 'Bolsos',
};

interface DragState {
  uuid: string;
  base: ItemBase;
  rotation: Rotation;
  /** Cell within the item the cursor grabbed, so it does not jump. */
  offsetX: number;
  offsetY: number;
  ghost: HTMLDivElement;
}

export interface GridPanelContext {
  system: InventorySystem;
  ownerId: string;
  /** Grids shown on the left, in order; the player's own kit. */
  ownGridIds(): string[];
  /** Grid shown on the right — a corpse, a crate — or null. */
  externalGridId(): string | null;
  /** Where a dropped item lands in the world. */
  dropPosition(): { x: number; y: number; z: number; yaw: number };
  resolve(baseId: string): ItemBase | null;
}

/**
 * The grid inventory: drag and drop between containers, equipment slots, the
 * ground column and whatever is being looted.
 *
 * Placement is decided by the cell under the *grabbed corner* of the item, not
 * by the cell under the cursor. Dragging a four-wide rifle by its stock and
 * having it land four cells to the right of where it looks is the single most
 * common way this kind of UI feels broken.
 */
export class GridInventoryPanel extends Panel {
  private drag: DragState | null = null;
  private message = '';
  private readonly layout: HTMLDivElement;

  constructor(private readonly ctx: GridPanelContext) {
    super('grid-inventory', 'Inventário');
    this.layout = document.createElement('div');
    this.layout.className = 'inv-layout';
    this.body.append(this.layout);

    // Rotation and cancellation belong to the window: the cursor is over a cell,
    // not over anything focusable.
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (event.code === 'KeyR' && this.drag) {
      event.preventDefault();
      this.drag.rotation = this.drag.rotation === 0 ? 90 : 0;
      this.paintGhost();
    }
    if (event.code === 'Delete' && this.drag) {
      const spot = this.ctx.dropPosition();
      this.ctx.system.drop(this.drag.uuid, spot.x, spot.y, spot.z, spot.yaw);
      this.endDrag();
      this.render();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.drag.ghost.style.left = `${event.clientX + 8}px`;
    this.drag.ghost.style.top = `${event.clientY + 8}px`;
  };

  /** Releasing outside any grid is the "throw it on the floor" gesture. */
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag) return;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const insidePanel = target?.closest('#grid-inventory');
    if (!insidePanel) {
      const spot = this.ctx.dropPosition();
      this.ctx.system.drop(this.drag.uuid, spot.x, spot.y, spot.z, spot.yaw);
      this.message = 'Item largado no chão.';
    }
    this.endDrag();
    this.render();
  };

  private endDrag(): void {
    this.drag?.ghost.remove();
    this.drag = null;
  }

  private paintGhost(): void {
    if (!this.drag) return;
    const { w, h } = footprintOf(this.drag.base, this.drag.rotation);
    this.drag.ghost.style.width = `${w * CELL_PX}px`;
    this.drag.ghost.style.height = `${h * CELL_PX}px`;
  }

  private startDrag(uuid: string, base: ItemBase, rotation: Rotation, offsetX: number, offsetY: number): void {
    const ghost = document.createElement('div');
    ghost.className = 'inv-ghost';
    ghost.append(iconElement(base, 28));
    document.body.append(ghost);
    this.drag = { uuid, base, rotation, offsetX, offsetY, ghost };
    this.paintGhost();
  }

  protected onShow(): void {
    this.render();
  }

  private render(): void {
    this.layout.replaceChildren();
    const left = document.createElement('div');
    left.className = 'inv-column';
    const right = document.createElement('div');
    right.className = 'inv-column';

    left.append(this.renderEquipment());
    for (const id of this.ctx.ownGridIds()) {
      const grid = this.ctx.system.container(id);
      if (grid) left.append(this.renderGrid(grid));
    }

    const externalId = this.ctx.externalGridId();
    if (externalId) {
      const grid = this.ctx.system.container(externalId);
      if (grid) right.append(this.renderGrid(grid));
    }
    right.append(this.renderGround());

    if (this.message) {
      const note = document.createElement('p');
      note.className = 'panel-note flash';
      note.textContent = this.message;
      this.layout.append(note);
    }
    this.layout.append(left, right);
  }

  private renderEquipment(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'inv-block';
    const title = document.createElement('h3');
    title.textContent = 'Equipamento';
    wrap.append(title);

    const slots = document.createElement('div');
    slots.className = 'inv-slots';
    for (const slot of EQUIP_SLOTS) {
      const cell = document.createElement('div');
      cell.className = 'inv-slot';
      const instance = this.ctx.system.equippedIn(this.ctx.ownerId, slot);
      const base = instance ? this.ctx.resolve(instance.baseId) : null;
      cell.innerHTML = `<span class="inv-slot-name">${SLOT_LABEL[slot]}</span>`;
      if (base) {
        const item = document.createElement('span');
        item.className = 'inv-slot-item';
        item.append(iconElement(base, 20), document.createTextNode(base.name));
        cell.append(item);
      }
      cell.addEventListener('pointerup', () => {
        if (!this.drag) return;
        const result = this.ctx.system.equip(this.ctx.ownerId, this.drag.uuid, slot);
        this.message = result.ok ? '' : this.explain(result.reason);
        this.endDrag();
        this.render();
      });
      slots.append(cell);
    }
    wrap.append(slots);
    return wrap;
  }

  private renderGrid(grid: Grid): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'inv-block';

    const title = document.createElement('h3');
    title.textContent = `${grid.def.name || grid.id} · ${grid.width}×${grid.height}`;
    wrap.append(title);

    // An unsearched corpse shows a progress bar instead of its contents.
    if (!this.ctx.system.isRevealed(grid.id)) {
      const progress = this.ctx.system.searchProgress(grid.id);
      const bar = document.createElement('div');
      bar.className = 'inv-search';
      const fill = document.createElement('div');
      fill.style.width = `${Math.round(progress * 100)}%`;
      bar.append(fill);
      const label = document.createElement('p');
      label.className = 'panel-note';
      label.textContent = `Revistando… ${Math.round(progress * 100)}%`;
      wrap.append(label, bar);
      return wrap;
    }

    const board = document.createElement('div');
    board.className = 'inv-grid';
    board.style.width = `${grid.width * CELL_PX}px`;
    board.style.height = `${grid.height * CELL_PX}px`;
    board.style.backgroundSize = `${CELL_PX}px ${CELL_PX}px`;

    for (const instance of grid.list()) {
      const base = this.ctx.resolve(instance.baseId);
      if (!base) continue;
      const { w, h } = footprintOf(base, instance.rotation);
      const tile = document.createElement('div');
      tile.className = 'inv-item';
      tile.style.left = `${instance.x * CELL_PX}px`;
      tile.style.top = `${instance.y * CELL_PX}px`;
      tile.style.width = `${w * CELL_PX - 2}px`;
      tile.style.height = `${h * CELL_PX - 2}px`;
      // Icon first, name underneath: at one cell the name is unreadable anyway
      // and the silhouette is what the player actually scans for.
      tile.append(iconElement(base, Math.min(w, h) * CELL_PX - 10));
      const label = document.createElement('span');
      label.className = 'inv-item-name';
      label.textContent = base.name;
      tile.append(label);
      if (base.tags.includes('ammo') && instance.quantity > 1) {
        const count = document.createElement('span');
        count.className = 'inv-count';
        count.textContent = String(instance.quantity);
        tile.append(count);
      }

      tile.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const rect = board.getBoundingClientRect();
        const cellX = Math.floor((event.clientX - rect.left) / CELL_PX);
        const cellY = Math.floor((event.clientY - rect.top) / CELL_PX);
        this.startDrag(
          instance.uuid,
          base,
          instance.rotation,
          cellX - instance.x,
          cellY - instance.y,
        );
        this.drag!.ghost.style.left = `${event.clientX + 8}px`;
        this.drag!.ghost.style.top = `${event.clientY + 8}px`;
      });
      board.append(tile);
    }

    board.addEventListener('pointerup', (event) => {
      if (!this.drag) return;
      const rect = board.getBoundingClientRect();
      // The grabbed corner decides the cell, not the cursor: dragging a rifle
      // by its stock must not land it four cells to the right.
      const x = Math.floor((event.clientX - rect.left) / CELL_PX) - this.drag.offsetX;
      const y = Math.floor((event.clientY - rect.top) / CELL_PX) - this.drag.offsetY;
      const result = this.ctx.system.moveTo(this.drag.uuid, grid.id, x, y, this.drag.rotation);
      this.message = result.ok ? '' : this.explain(result.reason);
      this.endDrag();
      this.render();
    });

    wrap.append(board);
    return wrap;
  }

  private renderGround(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'inv-block';
    const title = document.createElement('h3');
    title.textContent = 'No chão';
    wrap.append(title);

    const spot = this.ctx.dropPosition();
    const nearby = this.ctx.system.groundNear(spot.x, spot.z, 4);
    if (!nearby.length) {
      const empty = document.createElement('p');
      empty.className = 'panel-note';
      empty.textContent = 'Nada por perto.';
      wrap.append(empty);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'inv-ground';
    for (const entry of nearby) {
      const base = this.ctx.resolve(entry.instance.baseId);
      if (!base) continue;
      const row = document.createElement('button');
      row.className = 'panel-button inv-ground-row';
      row.append(
        iconElement(base, 18),
        document.createTextNode(`${base.name} · ${base.weightKg.toFixed(2)} kg`),
      );
      row.addEventListener('click', () => {
        const into = this.ctx.ownGridIds()[0];
        if (!into) return;
        const result = this.ctx.system.pickUp(entry.instance.uuid, into);
        this.message = result.ok ? '' : this.explain(result.reason);
        this.render();
      });
      list.append(row);
    }
    wrap.append(list);
    return wrap;
  }

  private explain(reason: string): string {
    switch (reason) {
      case 'ocupado':
        return 'Não cabe aí.';
      case 'foraDoGrid':
        return 'Passa da borda.';
      case 'tipoNaoAceito':
        return 'Este contêiner não aceita esse tipo.';
      case 'slotInvalido':
        return 'Esse item não vai nesse slot.';
      case 'slotOcupado':
        return 'O slot já está ocupado.';
      case 'naoPesquisado':
        return 'Reviste antes.';
      case 'recursivo':
        return 'Um contêiner não entra dentro de si mesmo.';
      default:
        return '';
    }
  }

  override hide(): void {
    this.endDrag();
    this.message = '';
    super.hide();
  }

  override dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    this.endDrag();
    super.dispose();
  }
}
