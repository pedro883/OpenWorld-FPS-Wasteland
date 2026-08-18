import * as THREE from 'three';
import aiConfig from '../../config/ai.json';
import { assets } from '../core/assets';
import type { PhysicsWorld } from '../physics/world';
import { ZoneHealth, type Zone } from './health';
import { HitboxSet } from './hitboxes';
import type { Damageable } from '../combat/types';
import { AmmoPouch } from '../combat/arsenal';
import { Weapon } from '../combat/weapon';
import type { BallisticsSystem } from '../combat/ballistics';
import { Perception, type PerceptionTarget } from '../ai/perception';
import { CoverFinder, type CoverPoint } from '../ai/cover';
import { Navigator } from '../ai/navigation';
import type { SquadMember, SquadOrder } from '../ai/squad';
import type { Squad } from '../ai/squad';
import {
  Action,
  Condition,
  PrioritySelector,
  ReactiveSequence,
  type Node,
  type Status,
  type TickContext,
} from '../ai/behaviorTree';

const perceptionCfg = aiConfig.perception;
const combatCfg = aiConfig.combat;
const suppressionCfg = aiConfig.suppression;
const squadCfg = aiConfig.squad;
const navCfg = aiConfig.navigation;

export type SkillLevel = 'recruit' | 'regular' | 'veteran' | 'specops';

interface SkillDef {
  reactionSeconds: number;
  spreadMultiplier: number;
  detectionMultiplier: number;
  suppressionResistance: number;
  coverSkill: number;
  burstSeconds: number[];
  pauseSeconds: number[];
  flankChance: number;
}

// The config block carries a `_comment` key, so it cannot be indexed by type
// directly; the cast pins it to the four real skill levels.
const SKILLS = aiConfig.skills as unknown as Record<SkillLevel, SkillDef>;

const MODELS = [
  'mini-characters/character-male-c',
  'mini-characters/character-male-e',
  'mini-characters/character-female-b',
  'mini-characters/character-female-d',
];

let nextId = 1;

export interface NpcDeps {
  physics: PhysicsWorld;
  scene: THREE.Scene;
  ballistics: BallisticsSystem;
  navigator: Navigator;
  cover: CoverFinder;
}

/**
 * A hostile fireteam member.
 *
 * Movement is kinematic: the navigator steers and the agent is snapped to the
 * terrain height, rather than each NPC carrying a Rapier character controller.
 * The ground is a heightfield that the navigator already slope-tests, the only
 * real obstacles are buildings and props, and those are handled by its forward
 * probes — a capsule controller per agent would cost far more for the same
 * result. Damage still resolves against real per-zone hitboxes.
 */
export class Npc implements Damageable, SquadMember {
  readonly id = nextId++;
  readonly health = new ZoneHealth();
  readonly position = new THREE.Vector3();
  readonly root = new THREE.Group();

  order: SquadOrder = 'hold';
  isMoving = false;
  squad: Squad | null = null;

  private readonly hitboxes: HitboxSet;
  private readonly perception: Perception;
  private readonly weapon: Weapon;
  private readonly pouch = new AmmoPouch();
  private readonly tree: Node;
  private readonly skill: SkillDef;

  private mixer: THREE.AnimationMixer | null = null;
  private currentClip = '';
  private readonly clips = new Map<string, THREE.AnimationClip>();

  private yaw = 0;
  private targetYaw = 0;
  private speed = 0;
  private goal: THREE.Vector3 | null = null;
  private coverPoint: CoverPoint | null = null;
  private coverTimer = 0;
  private reactionTimer = 0;
  private burstTimer = 0;
  private firing = false;
  private deathTimer = -1;

  /** 0..1; near-misses raise it, time lowers it. */
  suppression = 0;
  private thinkAccumulator = 0;
  private lastTrace: string[] = [];
  private target: PerceptionTarget | null = null;
  private visibility = 1;
  private neighbours: THREE.Vector3[] = [];

  constructor(
    private readonly deps: NpcDeps,
    spawn: THREE.Vector3,
    skillLevel: SkillLevel,
    weaponId: string,
  ) {
    this.position.copy(spawn);
    this.root.position.copy(spawn);
    deps.scene.add(this.root);

    this.skill = SKILLS[skillLevel];
    this.perception = new Perception(deps.physics, this.skill.detectionMultiplier);
    this.hitboxes = new HitboxSet(deps.physics, this, { position: spawn });
    this.weapon = new Weapon(weaponId, deps.ballistics, this, this.pouch);
    this.tree = this.buildTree();
  }

  static async spawn(
    deps: NpcDeps,
    spawn: THREE.Vector3,
    skillLevel: SkillLevel,
    weaponId: string,
    variant = 0,
  ): Promise<Npc> {
    const npc = new Npc(deps, spawn, skillLevel, weaponId);
    const id = MODELS[variant % MODELS.length]!;
    const model = await assets.instantiate(id);
    npc.root.add(model);
    for (const clip of assets.clips(id)) npc.clips.set(clip.name, clip);
    if (npc.clips.size) {
      npc.mixer = new THREE.AnimationMixer(model);
      npc.play('idle');
    }
    // The weapon rides in the right hand so the silhouette reads as armed.
    const weaponModel = await assets.instantiate(npc.weapon.def.model);
    weaponModel.scale.multiplyScalar(0.9);
    weaponModel.position.set(0.28, 1.15, 0.16);
    weaponModel.rotation.set(0, Math.PI, 0);
    npc.root.add(weaponModel);
    return npc;
  }

  // ---- Damageable -------------------------------------------------------

  get isAlive(): boolean {
    return this.health.alive;
  }

  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position);
  }

  onDamaged(_zone: Zone, _amount: number, fromDirection: THREE.Vector3): void {
    // Being hit is itself information: face the shot and tell the squad.
    const from = this.position.clone().addScaledVector(fromDirection, -30);
    this.perception.receiveContact(from, 8);
    this.squad?.reportUnderFire(from);
    this.suppression = Math.min(1, this.suppression + 0.35);
  }

  // ---- SquadMember ------------------------------------------------------

  hasContact(): boolean {
    return this.perception.seesTarget;
  }

  contactPosition(): THREE.Vector3 | null {
    return this.perception.lastKnownTargetPosition;
  }

  onContactRelayed(position: THREE.Vector3, errorMeters: number): void {
    this.perception.receiveContact(position, errorMeters);
  }

  // ---- Simulation -------------------------------------------------------

  /** A gunshot the agent may hear; the weapon supplies its own noise radius. */
  hearGunshot(at: THREE.Vector3, radiusMeters: number): void {
    this.perception.hear(
      { kind: 'gunshot', position: at, radiusMeters, source: null },
      this.position,
    );
  }

  /** A near miss: the round passed close enough to matter. */
  registerNearMiss(): void {
    this.suppression = Math.min(1, this.suppression + suppressionCfg.perNearMiss);
  }

  get isSuppressed(): boolean {
    return this.suppression >= suppressionCfg.duckThreshold;
  }

  get isPinned(): boolean {
    return this.suppression >= suppressionCfg.pinnedThreshold;
  }

  setContext(target: PerceptionTarget | null, visibility: number, neighbours: THREE.Vector3[]): void {
    this.target = target;
    this.visibility = visibility;
    this.neighbours = neighbours;
  }

  /** Think rate falls with distance from the viewer, per config tiers. */
  private thinkHz(viewerDistance: number): number {
    for (const tier of aiConfig.timeslicing.tiers) {
      if (viewerDistance <= tier.distance) return tier.hz;
    }
    return 2;
  }

  update(dt: number, viewerDistance: number): void {
    this.mixer?.update(dt);
    this.health.update(dt);

    if (!this.health.alive) {
      if (this.deathTimer < 0) this.die();
      return;
    }

    this.suppression = Math.max(0, this.suppression - suppressionCfg.decayPerSecond * dt);
    this.weapon.update(dt);

    // Timeslicing: distant agents run the same logic, just less often, with the
    // elapsed time handed to them so their movement stays frame-rate correct.
    const interval = 1 / this.thinkHz(viewerDistance);
    this.thinkAccumulator += dt;
    if (this.thinkAccumulator >= interval) {
      this.think(this.thinkAccumulator);
      this.thinkAccumulator = 0;
    }

    this.applyMotion(dt);
  }

  private think(dt: number): void {
    const eye = new THREE.Vector3(
      this.position.x,
      this.position.y + perceptionCfg.eyeHeightMeters,
      this.position.z,
    );
    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.perception.update(dt, eye, forward, this.target, this.visibility);

    if (this.coverTimer > 0) this.coverTimer -= dt;
    if (this.reactionTimer > 0) this.reactionTimer -= dt;
    if (this.burstTimer > 0) this.burstTimer -= dt;

    const ctx: TickContext = { dt, trace: [] };
    this.tree.tick(ctx);
    this.lastTrace = ctx.trace;
  }

  /** Moves towards the current goal and snaps to the ground. */
  private applyMotion(dt: number): void {
    const walk = this.isSuppressed ? 1.5 : this.order === 'flankLeft' || this.order === 'flankRight' ? 5.2 : 3.4;

    if (this.goal) {
      const result = this.deps.navigator.steer(dt, this.position, this.goal, this.neighbours);
      if (result.arrived) {
        this.goal = null;
        this.speed = 0;
      } else if (result.blocked) {
        this.goal = null;
        this.speed = 0;
      } else {
        this.position.addScaledVector(result.direction, walk * dt);
        this.speed = walk;
        this.targetYaw = Math.atan2(result.direction.x, result.direction.z);
      }
    } else {
      this.speed = 0;
    }

    // Face the target while shooting, otherwise face where you are going.
    const lookAt = this.perception.investigatePoint;
    if (this.firing && lookAt) {
      this.targetYaw = Math.atan2(lookAt.x - this.position.x, lookAt.z - this.position.z);
    }
    const delta = ((this.targetYaw - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    this.yaw += delta * Math.min(1, dt * 7);

    this.position.y = this.deps.navigator.groundHeight(this.position.x, this.position.z);
    this.root.position.copy(this.position);
    this.root.rotation.y = this.yaw;
    this.hitboxes.setPosition(this.position, this.yaw);
    this.hitboxes.setStanceHeight(this.isSuppressed ? 1.2 : 1.8);

    this.updateAnimation();
  }

  private updateAnimation(): void {
    let clip = 'idle';
    if (this.speed > 4.2) clip = 'sprint';
    else if (this.speed > 0.3) clip = 'walk';
    if (this.isSuppressed) clip = this.speed > 0.3 ? 'crouch' : 'crouch';
    if (this.firing) clip = 'holding-both-shoot';
    this.play(clip);
  }

  private play(name: string): void {
    if (!this.mixer || this.currentClip === name) return;
    const clip = this.clips.get(name) ?? this.clips.get('idle');
    if (!clip) return;
    const action = this.mixer.clipAction(clip);
    const previous = this.currentClip ? this.clips.get(this.currentClip) : null;
    if (previous) {
      const from = this.mixer.clipAction(previous);
      action.reset().crossFadeFrom(from, 0.18, false).play();
    } else {
      action.reset().play();
    }
    this.currentClip = name;
  }

  private die(): void {
    this.deathTimer = 0;
    this.firing = false;
    this.goal = null;
    this.hitboxes.dispose();
    const die = this.clips.get('die');
    if (this.mixer && die) {
      this.mixer.stopAllAction();
      const action = this.mixer.clipAction(die);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
    }
    this.squad?.remove(this.id);
  }

  // ---- Behaviour tree ---------------------------------------------------

  private buildTree(): Node {
    const hasTarget = () =>
      this.perception.lastKnownTargetPosition !== null || this.squad?.contact != null;
    // A squad order is itself a reason to fight: an agent told to suppress
    // holds the base of fire even when it cannot personally see the target.
    const engaged = () =>
      this.perception.awareness === 'engaged' ||
      this.perception.awareness === 'aware' ||
      (this.order !== 'hold' && this.squad?.contact != null);

    return new PrioritySelector('raiz', [
      // Retreat when badly hurt: a wounded agent that keeps charging reads as
      // a bug, not as bravery.
      new ReactiveSequence('recuar', [
        new Condition('ferido', () => this.health.vitality < combatCfg.retreatHealthFraction),
        new Condition('temAmeaça', hasTarget),
        new Action('recuarParaCobertura', () => this.moveToCover(true)),
      ]),

      new ReactiveSequence('combate', [
        new Condition('detectado', engaged),
        new Condition('temAmeaça', hasTarget),
        new PrioritySelector('planoDeCombate', [
          // Pinned down: stay in cover and do nothing brave.
          new ReactiveSequence('imobilizado', [
            new Condition('sobFogoPesado', () => this.isPinned),
            new Action('encolher', () => this.holdCover()),
          ]),
          new ReactiveSequence('flanquear', [
            new Condition(
              'ordemDeFlanco',
              () => (this.order === 'flankLeft' || this.order === 'flankRight') && this.isMoving,
            ),
            new Action('moverParaFlanco', () => this.moveToFlank()),
          ]),
          new ReactiveSequence('recarregar', [
            new Condition(
              'municaoBaixa',
              () => this.weapon.ammo <= this.weapon.def.magazine * combatCfg.reloadAtAmmoFraction,
            ),
            new Action('recarregando', () => {
              this.firing = false;
              return this.weapon.reload() || this.weapon.isReloading ? 'running' : 'failure';
            }),
          ]),
          new ReactiveSequence('suprimirDeCobertura', [
            new Condition('temCobertura', () => this.coverPoint !== null || this.order === 'suppress'),
            new Action('procurarCobertura', () => this.moveToCover(false)),
          ]),
          new Action('engajar', () => this.engage()),
        ]),
      ]),

      new ReactiveSequence('investigar', [
        new Condition('ouviuAlgo', () => this.perception.investigatePoint !== null),
        new Condition(
          'desconfiado',
          () => this.perception.awareness !== 'unaware',
        ),
        new Action('irAteOBarulho', () => this.investigate()),
      ]),

      new Action('patrulhar', () => this.patrol()),
    ]);
  }

  private holdCover(): Status {
    this.goal = null;
    this.firing = false;
    return 'running';
  }

  private get believedThreat(): THREE.Vector3 | null {
    return this.perception.lastKnownTargetPosition ?? this.squad?.contact ?? null;
  }

  private moveToCover(retreating: boolean): Status {
    const threat = this.believedThreat;
    if (!threat) return 'failure';

    if (this.coverTimer <= 0 || !this.coverPoint) {
      this.coverTimer = aiConfig.cover.reevaluateSeconds;
      const preferred = retreating
        ? combatCfg.engageRangeMeters * 0.8
        : combatCfg.preferredRangeMeters;
      this.coverPoint = this.deps.cover.find(
        this.position,
        threat,
        preferred,
        this.skill.coverSkill,
        // Retreating agents may take fully concealed cover; fighting ones must
        // be able to shoot from wherever they stop.
        !retreating,
      );
    }

    if (!this.coverPoint) return 'failure';
    const distance = this.position.distanceTo(this.coverPoint.position);
    if (distance > navCfg.arriveRadiusMeters) {
      this.goal = this.coverPoint.position;
      this.firing = false;
      return 'running';
    }

    this.goal = null;
    // In cover and able to shoot back: this is the base of fire.
    if (this.coverPoint.canReturnFire && !this.isPinned) return this.engage();
    // Concealed but unable to fire: give the spot up next evaluation rather
    // than standing behind it doing nothing.
    if (!this.coverPoint.canReturnFire) this.coverTimer = 0;
    return 'running';
  }

  private moveToFlank(): Status {
    const threat = this.believedThreat;
    if (!threat) return 'failure';
    if (this.goal) return 'running';

    const toTarget = threat.clone().sub(this.position);
    const bearing = Math.atan2(toTarget.x, toTarget.z);
    const side = this.order === 'flankRight' ? 1 : -1;
    const offsetBearing = bearing + side * (Math.PI / 2.6);
    const point = this.deps.navigator.findReachablePoint(
      this.position,
      offsetBearing,
      squadCfg.flankOffsetMeters,
    );
    if (!point) return 'failure';
    this.goal = point;
    this.firing = false;
    return 'running';
  }

  /** Shoot at the believed position, with skill- and suppression-based error. */
  private engage(): Status {
    const threat = this.believedThreat;
    if (!threat) return 'failure';

    const distance = this.position.distanceTo(threat);
    if (distance > combatCfg.engageRangeMeters) {
      this.goal = threat.clone();
      this.firing = false;
      return 'running';
    }

    // Reaction delay: the gap between noticing and pulling the trigger is what
    // gives the player the moment that decides the fight.
    if (this.reactionTimer > 0) {
      this.firing = false;
      return 'running';
    }
    if (!this.perception.seesTarget) {
      this.goal = threat.clone();
      this.firing = false;
      return 'running';
    }

    // Burst discipline: fire for a while, then pause. Holding the trigger
    // forever is both unfair and unreadable.
    if (this.burstTimer <= 0) {
      const [minB, maxB] = this.skill.burstSeconds;
      const [minP, maxP] = this.skill.pauseSeconds;
      const firingNow = !this.firing;
      this.burstTimer = firingNow
        ? minB! + Math.random() * (maxB! - minB!)
        : minP! + Math.random() * (maxP! - minP!);
      this.firing = firingNow;
    }

    this.goal = null;
    if (!this.firing) return 'running';

    const eye = new THREE.Vector3(
      this.position.x,
      this.position.y + perceptionCfg.eyeHeightMeters,
      this.position.z,
    );
    const aim = threat.clone().setY(threat.y + 1.1).sub(eye).normalize();

    // Aim error grows with range, poor skill and suppression.
    const rangeFactor = Math.min(1, distance / combatCfg.engageRangeMeters);
    const error =
      combatCfg.aimErrorAtMaxRangeDegrees *
      rangeFactor *
      this.skill.spreadMultiplier *
      (1 + this.suppression * suppressionCfg.accuracyPenaltyAtFull);
    this.applyAimError(aim, error);

    this.weapon.setTrigger(true);
    this.weapon.tryFire(eye, aim, {
      stance: this.isSuppressed ? 'crouch' : 'stand',
      moving: this.speed > 0.5,
      grounded: true,
      ads: true,
      swayMultiplier: 1,
      ignore: this.hitboxes.first,
    });
    return 'running';
  }

  private applyAimError(aim: THREE.Vector3, degrees: number): void {
    if (degrees <= 0) return;
    const radians = degrees * (Math.PI / 180);
    const axis = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    ).normalize();
    aim.applyAxisAngle(axis, (Math.random() - 0.5) * 2 * radians).normalize();
  }

  private investigate(): Status {
    const point = this.perception.investigatePoint;
    if (!point) return 'failure';
    this.firing = false;
    if (this.position.distanceTo(point) <= perceptionCfg.memory.searchRadiusMeters * 0.4) {
      // Arrived at the noise and found nothing: look around, then give up.
      this.goal = null;
      return 'running';
    }
    this.goal = point.clone();
    return 'running';
  }

  private patrolAnchor: THREE.Vector3 | null = null;

  private patrol(): Status {
    this.firing = false;
    this.weapon.setTrigger(false);
    if (!this.patrolAnchor) this.patrolAnchor = this.position.clone();
    if (this.goal) return 'running';

    const point = this.deps.navigator.findReachablePoint(
      this.patrolAnchor,
      Math.random() * Math.PI * 2,
      8 + Math.random() * 16,
    );
    if (point) this.goal = point;
    return 'running';
  }

  // ---- Debug ------------------------------------------------------------

  get awareness(): string {
    return this.perception.awareness;
  }

  get detectionMeter(): number {
    return this.perception.meterValue;
  }

  get currentGoal(): THREE.Vector3 | null {
    return this.goal;
  }

  get currentCover(): CoverPoint | null {
    return this.coverPoint;
  }

  get facing(): number {
    return this.yaw;
  }

  get debugText(): string {
    return [
      `#${this.id} ${this.perception.debugText}`,
      `  ordem ${this.order}${this.isMoving ? '*' : ''} · supressão ${(this.suppression * 100).toFixed(0)}%`,
      `  bt: ${this.lastTrace.slice(-3).join(' > ') || '—'}`,
      `  ${this.weapon.def.name} ${this.weapon.ammo}/${this.weapon.def.magazine}`,
    ].join('\n');
  }

  dispose(): void {
    if (this.health.alive) this.hitboxes.dispose();
    this.deps.scene.remove(this.root);
  }
}
