import { CHANNELS, type Channel, type Mixer } from '../audio/mixer';
import { ACTIONS, Keybinds, keybinds, type Action } from '../core/keybinds';
import { Panel, button, row } from './panel';

export type Quality = 'baixa' | 'media' | 'alta';

export interface GameSettings {
  sensitivity: number;
  fov: number;
  quality: Quality;
  invertY: boolean;
}

export interface OptionsActions {
  settings(): GameSettings;
  apply(settings: Partial<GameSettings>): void;
  save(): void;
}

const CHANNEL_LABEL: Record<string, string> = {
  master: 'Geral',
  sfx: 'Efeitos',
  vehicles: 'Veículos',
  voices: 'Vozes',
  music: 'Música',
  ui: 'Interface',
};

const QUALITY_LABEL: Record<Quality, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
};

/** Options: aim, view, volumes per channel, graphics and rebindable keys. */
export class OptionsPanel extends Panel {
  /** The action waiting for the next keypress, while rebinding. */
  private capturing: Action | null = null;

  constructor(
    private readonly mixer: Mixer,
    private readonly actions: OptionsActions,
  ) {
    super('options-panel', 'Opções');
    // Capture runs on the window so it sees keys the panel never focuses.
    window.addEventListener('keydown', this.onCapture, true);
  }

  private readonly onCapture = (event: KeyboardEvent): void => {
    if (!this.capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') {
      this.capturing = null;
      this.onShow();
      return;
    }
    if (keybinds.set(this.capturing, event.code)) {
      this.capturing = null;
      this.actions.save();
      this.onShow();
    }
  };

  private slider(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (v: number) => string,
    onInput: (v: number) => void,
  ): HTMLDivElement {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.className = 'panel-slider';
    const readout = document.createElement('span');
    readout.className = 'slider-value';
    readout.textContent = format(value);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      readout.textContent = format(v);
      onInput(v);
    });
    // Saving on release, not on every pixel of drag.
    input.addEventListener('change', () => this.actions.save());
    return row(label, readout, input);
  }

  protected onShow(): void {
    const settings = this.actions.settings();
    this.body.replaceChildren();

    const mira = document.createElement('h3');
    mira.textContent = 'Mira e câmera';
    this.body.append(mira);
    this.body.append(
      this.slider('Sensibilidade', settings.sensitivity, 0.2, 3, 0.05, (v) => v.toFixed(2), (v) =>
        this.actions.apply({ sensitivity: v }),
      ),
      this.slider('Campo de visão', settings.fov, 60, 110, 1, (v) => `${v.toFixed(0)}°`, (v) =>
        this.actions.apply({ fov: v }),
      ),
      row(
        'Inverter eixo Y',
        button(settings.invertY ? 'Ligado' : 'Desligado', () => {
          this.actions.apply({ invertY: !settings.invertY });
          this.actions.save();
          this.onShow();
        }, settings.invertY ? 'primary' : ''),
      ),
    );

    const som = document.createElement('h3');
    som.textContent = 'Volume';
    this.body.append(som);
    for (const channel of ['master', ...CHANNELS] as (Channel | 'master')[]) {
      this.body.append(
        this.slider(
          CHANNEL_LABEL[channel] ?? channel,
          this.mixer.volumeOf(channel),
          0,
          1,
          0.02,
          (v) => `${Math.round(v * 100)}%`,
          (v) => this.mixer.setVolume(channel, v),
        ),
      );
    }

    const grafico = document.createElement('h3');
    grafico.textContent = 'Gráficos';
    this.body.append(grafico);
    const qualityButtons = document.createElement('div');
    qualityButtons.className = 'panel-actions';
    for (const quality of ['baixa', 'media', 'alta'] as Quality[]) {
      qualityButtons.append(
        button(
          QUALITY_LABEL[quality],
          () => {
            this.actions.apply({ quality });
            this.actions.save();
            this.onShow();
          },
          settings.quality === quality ? 'primary' : '',
        ),
      );
    }
    this.body.append(row('Qualidade', qualityButtons));
    const note = document.createElement('p');
    note.className = 'panel-note';
    note.textContent =
      'Baixa desliga sombras e reduz a distância de visão — é a opção para GPU integrada.';
    this.body.append(note);

    this.renderKeybinds();
  }

  private renderKeybinds(): void {
    const heading = document.createElement('h3');
    heading.textContent = 'Controles';
    this.body.append(heading);

    if (this.capturing) {
      const hint = document.createElement('p');
      hint.className = 'panel-note flash';
      hint.textContent = `Pressione a tecla para "${ACTIONS[this.capturing]}" · Esc cancela`;
      this.body.append(hint);
    }

    const unbound = keybinds.unbound();
    if (unbound.length) {
      const warn = document.createElement('p');
      warn.className = 'panel-note';
      warn.textContent = `Sem tecla: ${unbound.map((a) => ACTIONS[a]).join(', ')}`;
      this.body.append(warn);
    }

    for (const action of Object.keys(ACTIONS) as Action[]) {
      const code = keybinds.get(action);
      this.body.append(
        row(
          ACTIONS[action],
          button(
            this.capturing === action ? '…' : code ? Keybinds.describe(code) : '— sem tecla —',
            () => {
              this.capturing = action;
              this.onShow();
            },
            this.capturing === action ? 'primary' : '',
          ),
        ),
      );
    }

    this.body.append(
      row(
        'Restaurar padrões',
        button('Restaurar', () => {
          keybinds.reset();
          this.actions.save();
          this.onShow();
        }),
      ),
    );

    const gamepad = document.createElement('p');
    gamepad.className = 'panel-note';
    gamepad.textContent =
      'Gamepad: analógico esquerdo anda, direito olha, gatilhos atiram e miram. ' +
      'O layout do controle é fixo e não entra no remapeamento.';
    this.body.append(gamepad);
  }

  override hide(): void {
    this.capturing = null;
    super.hide();
  }

  override dispose(): void {
    window.removeEventListener('keydown', this.onCapture, true);
    super.dispose();
  }
}
