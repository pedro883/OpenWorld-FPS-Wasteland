import economy from '../../config/economy.json';

export type PurchaseResult = 'ok' | 'semDinheiro' | 'semEspaco' | 'indisponivel' | 'foraDaZona';

/**
 * Money, split between the pocket and the bank.
 *
 * The split is the whole risk model of a Wasteland run: everything looted comes
 * back as carried money, and dying takes it. Only reaching the safe zone turns
 * it into a balance that survives. Without the split there is nothing at stake
 * in walking home.
 */
export class Wallet {
  bank: number;
  carried: number;
  /** Lifetime earnings, for the stats screen. */
  earned = 0;

  constructor(bank = economy.startingBank, carried = economy.startingCarried) {
    this.bank = bank;
    this.carried = carried;
  }

  get total(): number {
    return this.bank + this.carried;
  }

  /** Loot and rewards land in the pocket, where they can still be lost. */
  earn(amount: number): void {
    if (amount <= 0) return;
    this.carried += Math.round(amount);
    this.earned += Math.round(amount);
  }

  /** Moves the pocket into the bank; only ever called inside the safe zone. */
  deposit(amount = this.carried): number {
    const moved = Math.max(0, Math.min(Math.round(amount), this.carried));
    if (moved <= 0) return 0;
    this.carried -= moved;
    this.bank += Math.round(moved * (1 - economy.depositFeeFraction));
    return moved;
  }

  withdraw(amount: number): number {
    const moved = Math.max(0, Math.min(Math.round(amount), this.bank));
    this.bank -= moved;
    this.carried += moved;
    return moved;
  }

  /**
   * Spends from the pocket first, then the bank.
   *
   * Buying happens in the safe zone, where both are reachable, and spending the
   * at-risk money first is what the player would do by hand anyway.
   */
  spend(amount: number): boolean {
    const price = Math.max(0, Math.round(amount));
    if (price > this.total) return false;
    const fromPocket = Math.min(price, this.carried);
    this.carried -= fromPocket;
    this.bank -= price - fromPocket;
    return true;
  }

  canAfford(amount: number): boolean {
    return this.total >= Math.max(0, Math.round(amount));
  }

  /** Death empties the pocket and leaves the bank alone. */
  die(): number {
    const lost = this.carried;
    this.carried = 0;
    return lost;
  }
}
