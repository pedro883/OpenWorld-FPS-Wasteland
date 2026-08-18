import type { SaveStats } from '../save/saveGame';
import { Panel, button, row } from './panel';

export interface DeathSummary {
  /** Money the pocket was holding when it went. */
  moneyLost: number;
  /** Sale value of the gear left on the body. */
  gearLost: number;
  bank: number;
  killer: string;
  stats: SaveStats;
}

/**
 * What death cost, and what the run has amounted to.
 *
 * It leads with the loss because that is the number the player wants, and it
 * shows the bank next to it because the bank surviving is the rule the whole
 * economy turns on — a death screen that only showed the loss would read as
 * having lost everything.
 */
export class DeathScreen extends Panel {
  private summary: DeathSummary | null = null;
  onRespawn: (() => void) | null = null;

  constructor() {
    super('death-panel', 'Você morreu');
  }

  present(summary: DeathSummary): void {
    this.summary = summary;
    this.show();
  }

  protected onShow(): void {
    this.body.replaceChildren();
    const s = this.summary;
    if (!s) return;

    const loss = document.createElement('div');
    loss.className = 'panel-summary';
    loss.innerHTML =
      `<strong>-$${s.moneyLost + s.gearLost}</strong>` +
      `<span>$${s.moneyLost} no bolso · $${s.gearLost} em equipamento</span>`;
    this.body.append(loss);

    const kept = document.createElement('p');
    kept.className = 'panel-note flash';
    kept.textContent = `O banco não foi tocado: $${s.bank} continuam seus.`;
    this.body.append(kept);

    if (s.killer) this.body.append(row('Causa', s.killer));

    const heading = document.createElement('h3');
    heading.textContent = 'A run até aqui';
    this.body.append(heading);

    const minutos = Math.floor(s.stats.secondsPlayed / 60);
    this.body.append(
      row('Abates', String(s.stats.kills)),
      row('Mortes', String(s.stats.deaths)),
      row('Missões concluídas', String(s.stats.missionsCompleted)),
      row('Total ganho', `$${s.stats.moneyEarned}`),
      row('Tempo jogado', `${minutos} min`),
    );

    this.body.append(
      row(
        'Voltar para a zona segura',
        button('Renascer', () => {
          this.hide();
          this.onRespawn?.();
        }, 'primary'),
      ),
    );
  }
}
