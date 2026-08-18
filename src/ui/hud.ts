import { ZONES, type Zone } from '../entities/health';
import type { Player } from '../entities/player';
import type { Weapon } from '../combat/weapon';

/** Rough body diagram, in percentages of the HUD silhouette box. */
const ZONE_BOXES: Record<Zone, { left: number; top: number; width: number; height: number }> = {
  head: { left: 38, top: 0, width: 24, height: 20 },
  torso: { left: 32, top: 22, width: 36, height: 40 },
  armLeft: { left: 12, top: 24, width: 17, height: 36 },
  armRight: { left: 71, top: 24, width: 17, height: 36 },
  legLeft: { left: 32, top: 64, width: 16, height: 36 },
  legRight: { left: 52, top: 64, width: 16, height: 36 },
};

/**
 * DOM+CSS HUD. Kept out of the canvas so it stays crisp, styleable and
 * screen-reader friendly, per the spec's UI decision.
 */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly zoneEls = {} as Record<Zone, HTMLDivElement>;
  private readonly staminaFill: HTMLDivElement;
  private readonly stanceEl: HTMLDivElement;
  private readonly crosshair: HTMLDivElement;
  private readonly bleedEl: HTMLDivElement;
  private readonly hintEl: HTMLDivElement;
  private readonly vignette: HTMLDivElement;
  private readonly ammoEl: HTMLDivElement;
  private readonly ammoCount: HTMLSpanElement;
  private readonly ammoReserve: HTMLSpanElement;
  private readonly ammoMode: HTMLDivElement;
  private readonly reloadBar: HTMLDivElement;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'hud';

    this.vignette = document.createElement('div');
    this.vignette.id = 'hud-vignette';
    this.root.appendChild(this.vignette);

    this.crosshair = document.createElement('div');
    this.crosshair.id = 'crosshair';
    this.crosshair.innerHTML = '<i></i><i></i><i></i><i></i>';
    this.root.appendChild(this.crosshair);

    const panel = document.createElement('div');
    panel.id = 'hud-status';

    const body = document.createElement('div');
    body.id = 'hud-body';
    for (const zone of ZONES) {
      const el = document.createElement('div');
      el.className = 'hud-zone';
      const box = ZONE_BOXES[zone];
      el.style.left = `${box.left}%`;
      el.style.top = `${box.top}%`;
      el.style.width = `${box.width}%`;
      el.style.height = `${box.height}%`;
      el.title = zone;
      body.appendChild(el);
      this.zoneEls[zone] = el;
    }
    panel.appendChild(body);

    const bars = document.createElement('div');
    bars.id = 'hud-bars';

    const stamina = document.createElement('div');
    stamina.className = 'hud-bar';
    this.staminaFill = document.createElement('div');
    this.staminaFill.className = 'hud-bar-fill stamina';
    stamina.appendChild(this.staminaFill);
    bars.appendChild(stamina);

    this.stanceEl = document.createElement('div');
    this.stanceEl.className = 'hud-line';
    bars.appendChild(this.stanceEl);

    this.bleedEl = document.createElement('div');
    this.bleedEl.className = 'hud-line danger';
    bars.appendChild(this.bleedEl);

    panel.appendChild(bars);
    this.root.appendChild(panel);

    this.ammoEl = document.createElement('div');
    this.ammoEl.id = 'hud-ammo';
    this.ammoCount = document.createElement('span');
    this.ammoCount.className = 'ammo-count';
    this.ammoReserve = document.createElement('span');
    this.ammoReserve.className = 'ammo-reserve';
    const ammoLine = document.createElement('div');
    ammoLine.className = 'ammo-line';
    ammoLine.append(this.ammoCount, this.ammoReserve);
    this.ammoMode = document.createElement('div');
    this.ammoMode.className = 'hud-line';
    const reloadTrack = document.createElement('div');
    reloadTrack.className = 'hud-bar reload';
    this.reloadBar = document.createElement('div');
    this.reloadBar.className = 'hud-bar-fill reload';
    reloadTrack.appendChild(this.reloadBar);
    this.ammoEl.append(ammoLine, this.ammoMode, reloadTrack);
    this.root.appendChild(this.ammoEl);

    this.hintEl = document.createElement('div');
    this.hintEl.id = 'hud-hint';
    this.root.appendChild(this.hintEl);

    document.body.appendChild(this.root);
  }

  /** `spreadDegrees` opens the crosshair so recoil is legible without numbers. */
  update(player: Player, spreadDegrees = 1.5, weapon?: Weapon): void {
    for (const zone of ZONES) {
      const frac = player.health.fraction(zone);
      const el = this.zoneEls[zone];
      // Green -> amber -> red, with a distinct look for a disabled limb.
      const hue = 110 * frac;
      el.style.background = frac <= 0 ? 'rgba(60,16,16,0.95)' : `hsla(${hue}, 62%, ${18 + frac * 22}%, 0.92)`;
      el.style.borderColor = player.health.get(zone).bleeding
        ? 'rgba(220,80,60,0.95)'
        : 'rgba(255,255,255,0.16)';
    }

    const stamina = player.stamina / 100;
    this.staminaFill.style.width = `${Math.max(0, stamina * 100)}%`;
    this.staminaFill.classList.toggle('low', player.isExhausted);

    const stanceName = { stand: 'EM PÉ', crouch: 'AGACHADO', prone: 'DEITADO' }[player.stance];
    this.stanceEl.textContent = `${stanceName}${player.ads ? '  ·  MIRA' : ''}`;

    const broken = player.health.brokenLimbs;
    const notes: string[] = [];
    if (player.health.isBleeding) notes.push('SANGRANDO (F = bandagem)');
    if (broken.length) notes.push(`${broken.length} MEMBRO(S) FERIDO(S)`);
    this.bleedEl.textContent = notes.join('  ·  ');

    const gap = 3 + spreadDegrees * 3.2;
    this.crosshair.style.setProperty('--gap', `${gap.toFixed(1)}px`);

    // The screen darkens and reddens as the lethal zones drop.
    const vitality = player.health.vitality;
    this.vignette.style.opacity = `${Math.min(0.85, (1 - vitality) * 1.1)}`;

    if (weapon) {
      this.ammoEl.style.display = 'block';
      this.ammoCount.textContent = String(weapon.ammo);
      this.ammoCount.classList.toggle('empty', weapon.ammo === 0);
      this.ammoCount.classList.toggle('low', weapon.ammo > 0 && weapon.ammo <= weapon.def.magazine * 0.25);
      this.ammoReserve.textContent = ` / ${weapon.reserve}`;
      const mode = { auto: 'AUTO', burst: 'RAJADA', single: 'SEMI' }[weapon.fireMode] ?? weapon.fireMode;
      this.ammoMode.textContent = `${weapon.def.name}   ${mode}`;
      this.reloadBar.style.width = weapon.isReloading ? `${weapon.reloadProgress * 100}%` : '0%';
    } else {
      this.ammoEl.style.display = 'none';
    }
  }

  /** Brief red tick on the crosshair confirming a hit landed. */
  flashHit(headshot: boolean): void {
    this.crosshair.classList.remove('hit', 'headshot');
    // Reflow so the animation restarts even on rapid consecutive hits.
    void this.crosshair.offsetWidth;
    this.crosshair.classList.add(headshot ? 'headshot' : 'hit');
  }

  setHint(text: string): void {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle('visible', !!text);
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? 'block' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}
