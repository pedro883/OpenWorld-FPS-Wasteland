import { SELL_FRACTION, buy, sellItem, shopOffers, type Offer, type ShopContext } from '../economy/shop';
import { itemDef } from '../entities/inventory';
import type { PurchaseResult } from '../economy/wallet';
import { Panel, button, row } from './panel';

const KIND_LABEL: Record<string, string> = {
  weapon: 'Armas',
  item: 'Equipamento',
  vehicle: 'Veículos',
};

const FAILURE_TEXT: Record<PurchaseResult, string> = {
  ok: '',
  semDinheiro: 'Dinheiro insuficiente.',
  semEspaco: 'Não cabe na mochila.',
  indisponivel: 'Indisponível.',
  foraDaZona: 'O arsenal só atende na zona segura.',
};

/** Arsenal: buy weapons, gear and vehicles; sell what came back in the bag. */
export class ShopPanel extends Panel {
  private message = '';

  constructor(private readonly ctx: () => ShopContext) {
    super('shop-panel', 'Arsenal');
  }

  protected onShow(): void {
    const ctx = this.ctx();
    this.body.replaceChildren();

    const summary = document.createElement('div');
    summary.className = 'panel-summary';
    summary.innerHTML =
      `<strong>Banco $${ctx.wallet.bank}</strong>` +
      `<span>Bolso $${ctx.wallet.carried}</span>` +
      `<span>Mochila ${ctx.inventory.weightKg.toFixed(1)} / ${ctx.inventory.capacityKg.toFixed(0)} kg</span>`;
    this.body.append(summary);

    if (!ctx.inSafeZone) {
      const warn = document.createElement('p');
      warn.className = 'panel-note';
      warn.textContent = FAILURE_TEXT.foraDaZona;
      this.body.append(warn);
    }

    if (this.message) {
      const note = document.createElement('p');
      note.className = 'panel-note flash';
      note.textContent = this.message;
      this.body.append(note);
    }

    const grouped = new Map<string, Offer[]>();
    for (const offer of shopOffers()) {
      const list = grouped.get(offer.kind) ?? [];
      list.push(offer);
      grouped.set(offer.kind, list);
    }

    for (const [kind, offers] of grouped) {
      const heading = document.createElement('h3');
      heading.textContent = KIND_LABEL[kind] ?? kind;
      this.body.append(heading);

      for (const offer of offers) {
        const owned = offer.kind === 'weapon' && ctx.ownsWeapon(offer.id);
        const action = owned
          ? (() => {
              const tag = document.createElement('span');
              tag.className = 'owned-tag';
              tag.textContent = 'no arsenal';
              return tag;
            })()
          : button(
              `Comprar $${offer.price}`,
              () => {
                const result = buy(this.ctx(), offer.kind, offer.id);
                this.message = result === 'ok' ? `${offer.name} comprado.` : FAILURE_TEXT[result];
                this.onShow();
              },
              ctx.wallet.canAfford(offer.price) && ctx.inSafeZone ? 'primary' : 'disabled',
            );
        this.body.append(row(offer.name, offer.detail, action));
      }
    }

    this.renderSell(ctx);
  }

  private renderSell(ctx: ShopContext): void {
    if (ctx.inventory.isEmpty) return;
    const heading = document.createElement('h3');
    heading.textContent = `Vender (${Math.round(SELL_FRACTION * 100)}% do valor)`;
    this.body.append(heading);

    const merged = new Map<string, number>();
    for (const stack of ctx.inventory.list()) {
      merged.set(stack.id, (merged.get(stack.id) ?? 0) + stack.count);
    }

    for (const [id, count] of merged) {
      const def = itemDef(id);
      if (!def) continue;
      const unit = Math.round(def.value * SELL_FRACTION);
      const actions = document.createElement('div');
      actions.className = 'panel-actions';
      actions.append(
        button(`Vender 1 · $${unit}`, () => {
          const paid = sellItem(this.ctx(), id, 1);
          this.message = paid > 0 ? `Vendido por $${paid}.` : FAILURE_TEXT.foraDaZona;
          this.onShow();
        }),
      );
      if (count > 1) {
        actions.append(
          button(`Tudo · $${unit * count}`, () => {
            const paid = sellItem(this.ctx(), id, count);
            this.message = paid > 0 ? `Vendido por $${paid}.` : FAILURE_TEXT.foraDaZona;
            this.onShow();
          }),
        );
      }
      this.body.append(row(`${def.name} ×${count}`, `${(def.weightKg * count).toFixed(2)} kg`, actions));
    }
  }

  override hide(): void {
    this.message = '';
    super.hide();
  }
}
