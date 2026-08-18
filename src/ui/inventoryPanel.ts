import { itemDef, type Inventory } from '../entities/inventory';
import type { Wallet } from '../economy/wallet';
import { Panel, button, row } from './panel';

export interface InventoryActions {
  /** Uses one unit — bandage, medkit, jerrycan, repair kit. */
  use(itemId: string): string | null;
  /** Drops one unit on the ground. */
  drop(itemId: string): void;
  /** True while standing in the safe zone, where depositing is possible. */
  inSafeZone(): boolean;
  deposit(): void;
}

const CATEGORY_LABEL: Record<string, string> = {
  ammo: 'Munição',
  medical: 'Médico',
  gear: 'Equipamento',
  tool: 'Ferramenta',
  attachment: 'Acessório',
  valuable: 'Valor',
};

/** The bag, listed by category, with weight front and centre. */
export class InventoryPanel extends Panel {
  constructor(
    private readonly inventory: Inventory,
    private readonly wallet: Wallet,
    private readonly actions: InventoryActions,
  ) {
    super('inventory-panel', 'Mochila');
  }

  protected onShow(): void {
    this.body.replaceChildren();

    const weight = this.inventory.weightKg;
    const capacity = this.inventory.capacityKg;
    const summary = document.createElement('div');
    summary.className = 'panel-summary';
    summary.innerHTML =
      `<strong>${weight.toFixed(1)} / ${capacity.toFixed(0)} kg</strong>` +
      `<span>Bolso $${this.wallet.carried}</span>` +
      `<span>Banco $${this.wallet.bank}</span>`;
    this.body.append(summary);

    const bar = document.createElement('div');
    bar.className = 'weight-bar';
    const fill = document.createElement('div');
    fill.style.width = `${Math.min(100, (weight / capacity) * 100).toFixed(0)}%`;
    // Turns red as the bag fills, because weight is the real constraint here.
    fill.className = weight / capacity > 0.9 ? 'weight-fill full' : 'weight-fill';
    bar.append(fill);
    this.body.append(bar);

    if (this.actions.inSafeZone() && this.wallet.carried > 0) {
      this.body.append(
        row(
          `Depositar $${this.wallet.carried} no banco`,
          button('Depositar', () => {
            this.actions.deposit();
            this.onShow();
          }, 'primary'),
        ),
      );
    } else if (this.wallet.carried > 0) {
      const warn = document.createElement('p');
      warn.className = 'panel-note';
      warn.textContent =
        'Morrer perde o dinheiro do bolso. O banco fica na zona segura, na vila.';
      this.body.append(warn);
    }

    if (this.inventory.isEmpty) {
      const empty = document.createElement('p');
      empty.className = 'panel-note';
      empty.textContent = 'Mochila vazia.';
      this.body.append(empty);
      return;
    }

    const byCategory = new Map<string, { id: string; count: number }[]>();
    for (const stack of this.inventory.list()) {
      const def = itemDef(stack.id);
      if (!def) continue;
      const list = byCategory.get(def.category) ?? [];
      list.push(stack);
      byCategory.set(def.category, list);
    }

    for (const [category, stacks] of byCategory) {
      const heading = document.createElement('h3');
      heading.textContent = CATEGORY_LABEL[category] ?? category;
      this.body.append(heading);

      // Stacks of the same item are shown merged; the split is a storage detail.
      const merged = new Map<string, number>();
      for (const stack of stacks) merged.set(stack.id, (merged.get(stack.id) ?? 0) + stack.count);

      for (const [id, count] of merged) {
        const def = itemDef(id)!;
        const actions = document.createElement('div');
        actions.className = 'panel-actions';
        if (def.healsZone || def.fuelLitres || def.repairs) {
          actions.append(
            button('Usar', () => {
              const message = this.actions.use(id);
              this.onShow();
              if (message) this.flash(message);
            }),
          );
        }
        actions.append(button('Largar', () => {
          this.actions.drop(id);
          this.onShow();
        }));
        this.body.append(
          row(
            `${def.name} ×${count}`,
            `${(def.weightKg * count).toFixed(2)} kg`,
            `$${def.value * count}`,
            actions,
          ),
        );
      }
    }
  }

  private flash(message: string): void {
    const note = document.createElement('p');
    note.className = 'panel-note flash';
    note.textContent = message;
    this.body.prepend(note);
  }
}
