import type * as THREE from 'three';
import { AmmoPouch, LOADOUT, WEAPON_DEFAULTS, weaponDef, type WeaponDef } from '../combat/arsenal';
import { Weapon } from '../combat/weapon';
import type { BallisticsSystem } from '../combat/ballistics';

export interface LoadoutSlot {
  slot: string;
  weapon: Weapon;
}

/**
 * The weapons a shooter carries and which one is in hand.
 *
 * Switching is not instant: the current weapon holsters, then the next one
 * raises. That switch cost is what makes the choice of what to carry matter,
 * and it is also when a partial shell-by-shell reload gets cancelled.
 */
export class Loadout {
  private readonly slots: LoadoutSlot[] = [];
  private index = 0;
  private previousIndex = 0;
  /** Seconds left in the holster/raise transition. */
  private switchTimer = 0;
  private pendingIndex: number | null = null;

  readonly pouch = new AmmoPouch();
  /** Fired when the weapon in hand changes, so the viewmodel can swap models. */
  onWeaponChanged: ((weapon: Weapon) => void) | null = null;

  constructor(
    private readonly ballistics: BallisticsSystem,
    private readonly owner: unknown,
    weaponIds?: string[],
  ) {
    const ids = weaponIds ?? Object.values(LOADOUT.default);
    for (const id of ids) {
      const def = weaponDef(id);
      this.slots.push({ slot: def.slot, weapon: new Weapon(id, ballistics, owner, this.pouch) });
    }
  }

  get current(): Weapon {
    return this.slots[this.index]!.weapon;
  }

  get currentIndex(): number {
    return this.index;
  }

  get count(): number {
    return this.slots.length;
  }

  get all(): readonly LoadoutSlot[] {
    return this.slots;
  }

  get isSwitching(): boolean {
    return this.switchTimer > 0;
  }

  /** 0 at rest, 1 at the deepest point of the holster dip. */
  get switchProgress(): number {
    if (this.switchTimer <= 0) return 0;
    const total = WEAPON_DEFAULTS.switchSeconds;
    const elapsed = total - this.switchTimer;
    // Triangular: down while holstering, back up while raising.
    return 1 - Math.abs(elapsed / total - 0.5) * 2;
  }

  weaponAt(index: number): Weapon | undefined {
    return this.slots[index]?.weapon;
  }

  select(index: number): boolean {
    if (index < 0 || index >= this.slots.length) return false;
    if (index === this.index || this.pendingIndex === index) return false;
    this.previousIndex = this.index;
    this.pendingIndex = index;
    this.switchTimer = WEAPON_DEFAULTS.switchSeconds;
    this.current.onHolster();
    return true;
  }

  selectSlot(slot: string): boolean {
    const found = this.slots.findIndex((s) => s.slot === slot);
    return found >= 0 ? this.select(found) : false;
  }

  next(): boolean {
    return this.select((this.index + 1) % this.slots.length);
  }

  prev(): boolean {
    return this.select((this.index - 1 + this.slots.length) % this.slots.length);
  }

  /** Quick-swap back to whatever was in hand before the last change. */
  swapToPrevious(): boolean {
    return this.select(this.previousIndex);
  }

  add(id: string): Weapon {
    const def = weaponDef(id);
    const weapon = new Weapon(id, this.ballistics, this.owner, this.pouch);
    this.slots.push({ slot: def.slot, weapon });
    return weapon;
  }

  update(dt: number): void {
    if (this.switchTimer > 0) {
      const half = WEAPON_DEFAULTS.switchSeconds / 2;
      const before = this.switchTimer;
      this.switchTimer -= dt;
      // The model swaps at the bottom of the dip, where it is least visible.
      if (this.pendingIndex !== null && before > half && this.switchTimer <= half) {
        this.index = this.pendingIndex;
        this.pendingIndex = null;
        this.onWeaponChanged?.(this.current);
      }
      if (this.switchTimer <= 0) this.switchTimer = 0;
    }
    // Only the weapon in hand ticks; holstered ones are frozen by design.
    this.current.update(dt);
  }

  /** True when the weapon can act — not mid-switch. */
  get ready(): boolean {
    return this.switchTimer <= 0;
  }

  totalWeightKg(): number {
    return this.slots.reduce((sum, s) => sum + s.weapon.def.weightKg, 0);
  }

  defs(): WeaponDef[] {
    return this.slots.map((s) => s.weapon.def);
  }

  positionOf(_out: THREE.Vector3): void {
    /* placeholder for dropped-weapon pickups in phase 7 */
  }

  get debugText(): string {
    return this.slots
      .map((s, i) => `${i === this.index ? '>' : ' '} ${i + 1} ${s.weapon.def.name}`)
      .join('\n');
  }
}
