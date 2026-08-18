import * as THREE from 'three';
import type { Scene, SceneContext } from './types';
import { InventorySystem } from '../inventory/inventorySystem';
import { GridInventoryPanel } from '../ui/gridInventoryPanel';
import type { ItemBase, ItemInstance } from '../inventory/types';
import itemsGrid from '../../config/items-grid.json';

const BASES = new Map<string, ItemBase>(
  Object.entries(itemsGrid.items as unknown as Record<string, Omit<ItemBase, 'id'>>).map(
    ([id, def]) => [id, { id, ...def }],
  ),
);

let counter = 0;
function makeInstance(baseId: string, quantity = 1): ItemInstance {
  return {
    uuid: `${baseId}-${++counter}`,
    baseId,
    containerId: null,
    x: 0,
    y: 0,
    rotation: 0,
    equippedSlot: null,
    quantity,
    durability: 100,
    extra: {},
  };
}

/**
 * `?scene=inv` — the grid inventory with something to grab.
 *
 * A bench for the inventory alone, in the same spirit as the other isolated
 * scenes: dragging, rotating and looting can be iterated on without loading the
 * world, and the panel is exercised against the real system rather than a mock.
 */
export class InventoryTestScene implements Scene {
  readonly name = 'inv';
  private panel!: GridInventoryPanel;
  private system!: InventorySystem;
  private hint!: HTMLDivElement;
  private corpseId = 'corpo-teste';

  init(ctx: SceneContext): void {
    ctx.render.scene.background = new THREE.Color(0x10151a);
    this.system = new InventorySystem((id) => BASES.get(id) ?? null);

    this.system.createContainer({
      id: 'bolsos', kind: 'player', name: 'Bolsos', width: 4, height: 1, ownerId: 'p1',
    });
    this.system.createContainer({
      id: 'stash', kind: 'stash', name: 'Baú', width: 10, height: 8, ownerId: 'p1',
    });
    this.system.createContainer({
      id: 'municao', kind: 'crate', name: 'Caixa de munição', width: 6, height: 4,
      ownerId: null, accepts: ['ammo', 'magazine'], position: { x: 0, y: 0, z: 0 },
    });
    this.system.createContainer({
      id: this.corpseId, kind: 'corpse', name: 'Corpo', width: 6, height: 4,
      ownerId: 'npc1', searchSeconds: 4, position: { x: 1, y: 0, z: 0 },
    });

    for (const [baseId, target] of [
      ['rifle_assalto', 'stash'],
      ['carregador_556', 'stash'],
      ['carregador_556', 'stash'],
      ['granada_frag', 'stash'],
      ['mochila_assalto', 'stash'],
      ['capacete', 'stash'],
      ['luneta_4x', 'stash'],
      ['pistola', 'corpo-teste'],
      ['carregador_9mm', 'corpo-teste'],
      ['municao_556', 'municao'],
    ] as [string, string][]) {
      const instance = makeInstance(baseId, baseId.startsWith('municao') ? 60 : 1);
      this.system.track(instance);
      this.system.container(target)?.insert(instance);
    }

    // Something already lying about, so the ground column has content.
    const dropped = makeInstance('granada_frag');
    this.system.track(dropped);
    this.system.drop(dropped.uuid, 0, 0, 0);

    this.panel = new GridInventoryPanel({
      system: this.system,
      ownerId: 'p1',
      ownGridIds: () => ['bolsos', 'stash'],
      externalGridId: () => this.corpseId,
      dropPosition: () => ({ x: 0, y: 0, z: 0, yaw: 0 }),
      resolve: (id) => BASES.get(id) ?? null,
    });
    this.panel.show();

    this.hint = document.createElement('div');
    this.hint.style.cssText =
      'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:50;' +
      'font:12px ui-monospace,monospace;color:#e8e2d2;background:rgba(12,14,16,.6);padding:6px 12px;border-radius:4px';
    this.hint.textContent =
      'Arraste os itens · R gira · Del ou soltar fora larga no chão · segure para revistar o corpo';
    document.body.append(this.hint);
  }

  fixed(dt: number): void {
    // Holding the mouse button anywhere searches the corpse, which is enough to
    // exercise the timer without building the world's interaction layer here.
    if (this.panel.isOpen) this.system.advanceSearch(this.corpseId, dt * 0.35);
  }

  frame(): void {
    /* The panel is DOM; there is nothing to draw. */
  }

  dispose(): void {
    this.panel.dispose();
    this.hint.remove();
  }
}
