import * as THREE from 'three';
import aiConfig from '../../config/ai.json';

const cfg = aiConfig.squad;

export type SquadOrder =
  | 'hold'
  | 'suppress'
  | 'flankLeft'
  | 'flankRight'
  | 'bound'
  | 'fallBack';

export interface SquadMember {
  readonly id: number;
  readonly position: THREE.Vector3;
  readonly isAlive: boolean;
  /** Set by the squad each review. */
  order: SquadOrder;
  /** Bounding overwatch: true means move, false means cover the movers. */
  isMoving: boolean;
  onContactRelayed(position: THREE.Vector3, errorMeters: number): void;
  hasContact(): boolean;
  contactPosition(): THREE.Vector3 | null;
}

/**
 * A fireteam that decides *together*.
 *
 * The point of the squad is that its members do different things at the same
 * time: one element suppresses while another flanks, and in bounding overwatch
 * half the team is always stationary and shooting while the other half moves.
 * Without that split, six agents just charge in a line.
 */
export class Squad {
  readonly members: SquadMember[] = [];
  private leaderId = -1;
  private reviewTimer = 0;
  private relayTimer = 0;
  private readonly sharedContact = new THREE.Vector3();
  private hasSharedContact = false;
  private contactAge = 0;
  private boundingPhase = 0;
  currentPlan: SquadOrder = 'hold';

  constructor(readonly id: number) {}

  add(member: SquadMember): void {
    this.members.push(member);
    if (this.leaderId === -1) this.leaderId = member.id;
  }

  remove(id: number): void {
    const index = this.members.findIndex((m) => m.id === id);
    if (index >= 0) this.members.splice(index, 1);
    if (this.leaderId === id) this.promoteLeader();
  }

  private promoteLeader(): void {
    const alive = this.members.find((m) => m.isAlive);
    this.leaderId = alive ? alive.id : -1;
  }

  get leader(): SquadMember | undefined {
    return this.members.find((m) => m.id === this.leaderId && m.isAlive);
  }

  get aliveCount(): number {
    return this.members.filter((m) => m.isAlive).length;
  }

  get contact(): THREE.Vector3 | null {
    return this.hasSharedContact ? this.sharedContact : null;
  }

  update(dt: number): void {
    if (!this.leader) this.promoteLeader();
    this.contactAge += dt;

    this.relayTimer -= dt;
    if (this.relayTimer <= 0) {
      this.relayTimer = cfg.contactRelaySeconds;
      this.relayContact();
    }

    this.reviewTimer -= dt;
    if (this.reviewTimer <= 0) {
      this.reviewTimer = cfg.orderReviewSeconds;
      this.assignOrders();
    }
  }

  /**
   * Whoever sees the target tells the rest — with a delay and a position error,
   * so the squad converges on roughly the right place instead of teleporting
   * perfect knowledge to everyone.
   */
  private relayContact(): void {
    let fresh: THREE.Vector3 | null = null;
    for (const member of this.members) {
      if (!member.isAlive || !member.hasContact()) continue;
      fresh = member.contactPosition();
      if (fresh) break;
    }
    if (!fresh) return;

    this.sharedContact.copy(fresh);
    this.hasSharedContact = true;
    this.contactAge = 0;

    for (const member of this.members) {
      if (!member.isAlive || member.hasContact()) continue;
      member.onContactRelayed(this.sharedContact, cfg.contactPositionErrorMeters);
    }
  }

  /** The leader's plan, turned into a per-member order. */
  private assignOrders(): void {
    const alive = this.members.filter((m) => m.isAlive);
    if (!alive.length) return;

    if (!this.hasSharedContact || this.contactAge > 12) {
      this.currentPlan = 'hold';
      for (const member of alive) {
        member.order = 'hold';
        member.isMoving = false;
      }
      return;
    }

    // Too few left to manoeuvre: hold what you have and shoot.
    if (alive.length <= 2) {
      this.currentPlan = 'suppress';
      for (const member of alive) {
        member.order = 'suppress';
        member.isMoving = false;
      }
      return;
    }

    // Base of fire pins the target; the smaller element goes around. Which
    // side is chosen by whichever flank the squad is already closer to.
    const centre = new THREE.Vector3();
    for (const member of alive) centre.add(member.position);
    centre.divideScalar(alive.length);
    const toTarget = this.sharedContact.clone().sub(centre);
    const rightward = new THREE.Vector3(-toTarget.z, 0, toTarget.x).normalize();
    let rightBias = 0;
    for (const member of alive) {
      rightBias += member.position.clone().sub(centre).dot(rightward);
    }
    const flank: SquadOrder = rightBias >= 0 ? 'flankRight' : 'flankLeft';
    this.currentPlan = flank;

    const flankers = Math.max(1, Math.floor(alive.length * cfg.boundingOverwatchFraction));
    // Sort so the members already nearest the chosen flank are the ones sent.
    const sorted = [...alive].sort((a, b) => {
      const da = a.position.clone().sub(centre).dot(rightward);
      const db = b.position.clone().sub(centre).dot(rightward);
      return flank === 'flankRight' ? db - da : da - db;
    });

    this.boundingPhase = (this.boundingPhase + 1) % 2;
    sorted.forEach((member, i) => {
      if (i < flankers) {
        member.order = flank;
        // Bounding overwatch: alternate which half is on the move.
        member.isMoving = i % 2 === this.boundingPhase;
      } else {
        member.order = 'suppress';
        member.isMoving = false;
      }
    });
  }

  /** Called when a member takes fire, so the squad reacts before it sees. */
  reportUnderFire(from: THREE.Vector3): void {
    if (this.hasSharedContact && this.contactAge < 4) return;
    this.sharedContact.copy(from);
    this.hasSharedContact = true;
    this.contactAge = 0;
    this.reviewTimer = 0;
  }

  get debugText(): string {
    const orders = this.members
      .filter((m) => m.isAlive)
      .map((m) => `${m.order}${m.isMoving ? '*' : ''}`)
      .join(', ');
    return `esquadrão ${this.id}: ${this.aliveCount} vivos · plano ${this.currentPlan}\n  ${orders}`;
  }
}
