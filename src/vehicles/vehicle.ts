import * as THREE from 'three';
import vehicleConfig from '../../config/vehicles.json';
import { assets } from '../core/assets';
import { groups, Layer, WORLD_SOLID } from '../physics/layers';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { ZoneHealth } from '../entities/health';

const DEFAULTS = vehicleConfig.defaults;
const TYPES = vehicleConfig.types as unknown as Record<string, VehicleTypeDef>;

export interface SeatDef {
  role: 'driver' | 'passenger' | 'gunner';
  offset: number[];
}

export interface VehicleTypeDef {
  name: string;
  model: string;
  wheelModel: string;
  massKg: number;
  enginePowerNm: number;
  gearRatios: number[];
  finalDrive: number;
  topSpeedKph: number;
  seats: SeatDef[];
  wheelbase: number;
  trackWidth: number;
  hullHalfExtents: number[];
  suspension?: Partial<typeof DEFAULTS.suspension>;
  tyre?: Partial<typeof DEFAULTS.tyre>;
}

export interface VehicleInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

interface Wheel {
  /** Local mount point on the hull. */
  local: THREE.Vector3;
  steered: boolean;
  driven: boolean;
  /** Suspension compression from the previous step, for the damper term. */
  lastCompression: number;
  grounded: boolean;
  contactPoint: THREE.Vector3;
  spinAngle: number;
  health: number;
  mesh: THREE.Object3D | null;
}

export type VehicleTypeId = keyof typeof vehicleConfig.types & string;

export function vehicleTypeIds(): string[] {
  return Object.keys(TYPES);
}

/**
 * Raycast-suspension vehicle on a single Rapier rigid body.
 *
 * There is no wheel joint and no wheel body: each corner casts a ray down and
 * applies a spring-damper force plus tyre friction at the contact point. That
 * is the standard arcade-sim approach and it is what keeps a car stable at
 * 60 Hz — real constraint-based wheels need a much higher solver rate before
 * they stop jittering.
 */
export class Vehicle {
  readonly def: VehicleTypeDef;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly root = new THREE.Group();

  private readonly wheels: Wheel[] = [];
  private readonly suspension: typeof DEFAULTS.suspension;
  private readonly tyre: typeof DEFAULTS.tyre;

  private gear = 1;
  private rpm = DEFAULTS.engine.idleRpm;
  private shiftTimer = 0;
  private steerAngle = 0;

  fuelLitres: number;
  engineHealth = 100;
  fuelTankHealth: number;
  fireTimer = 0;
  destroyed = false;
  /**
   * True while the terrain under this vehicle has not streamed in. A parked car
   * at a distant POI would otherwise fall through a world that does not exist
   * yet and be gone by the time the player arrives.
   */
  dormant = false;
  private readonly restPosition = new THREE.Vector3();

  /** Who is in which seat; index matches `def.seats`. */
  readonly occupants: Array<unknown | null>;

  private readonly input: VehicleInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    typeId: string,
    position: THREE.Vector3,
    yaw = 0,
  ) {
    const def = TYPES[typeId];
    if (!def) throw new Error(`tipo de veículo desconhecido: ${typeId}`);
    this.def = def;
    this.suspension = { ...DEFAULTS.suspension, ...def.suspension };
    this.tyre = { ...DEFAULTS.tyre, ...def.tyre };
    this.fuelLitres = DEFAULTS.fuel.capacityLitres;
    this.fuelTankHealth = DEFAULTS.damage.fuelTankHealth;
    this.occupants = def.seats.map(() => null);

    const half = def.hullHalfExtents;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y + half[1]! + this.suspension.restLengthMeters, position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        // Without damping the body keeps drifting forever on flat ground once
        // the tyre model stops resisting.
        .setLinearDamping(0.08)
        .setAngularDamping(0.9),
    );
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half[0]!, half[1]!, half[2]!)
        .setMass(def.massKg)
        .setFriction(0.4)
        .setRestitution(0.05)
        .setCollisionGroups(groups(Layer.VEHICLE, 0xffff)),
      this.body,
    );
    // The owner carries a back-reference so a bullet impact can be routed to
    // this vehicle's localised damage model instead of just spawning a decal.
    physics.own(this.collider, { kind: 'surface', material: 'metal', vehicle: this });

    const halfBase = def.wheelbase / 2;
    const halfTrack = def.trackWidth / 2;
    const wheelY = -half[1]! + 0.05;
    // Front wheels steer, rear wheels drive; +Z is the nose, as in the models.
    for (const [x, z, steered, driven] of [
      [-halfTrack, halfBase, true, false],
      [halfTrack, halfBase, true, false],
      [-halfTrack, -halfBase, false, true],
      [halfTrack, -halfBase, false, true],
    ] as Array<[number, number, boolean, boolean]>) {
      this.wheels.push({
        local: new THREE.Vector3(x, wheelY, z),
        steered,
        driven,
        lastCompression: 0,
        grounded: false,
        contactPoint: new THREE.Vector3(),
        spinAngle: 0,
        health: DEFAULTS.damage.tyreHealth,
        mesh: null,
      });
    }

    this.restPosition.set(
      position.x,
      position.y + half[1]! + this.suspension.restLengthMeters,
      position.z,
    );
    scene.add(this.root);
  }

  /** Parks the vehicle where it spawned until its ground exists. */
  private holdDormant(): void {
    this.body.setTranslation(
      { x: this.restPosition.x, y: this.restPosition.y, z: this.restPosition.z },
      false,
    );
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  }

  static async spawn(
    physics: PhysicsWorld,
    scene: THREE.Scene,
    typeId: string,
    position: THREE.Vector3,
    yaw = 0,
  ): Promise<Vehicle> {
    const vehicle = new Vehicle(physics, scene, typeId, position, yaw);
    const body = await assets.instantiate(vehicle.def.model);
    // Kenney vehicle models include their own wheel nodes; the simulated wheels
    // replace them, so the built-in ones are hidden rather than deleted.
    body.traverse((obj) => {
      if (/^wheel/.test(obj.name)) obj.visible = false;
    });
    const entry = assets.entry(vehicle.def.model);
    const scale = assets.scaleFor(vehicle.def.model);
    if (entry) body.position.y = -entry.bounds.min[1] * scale - vehicle.def.hullHalfExtents[1]!;
    vehicle.root.add(body);

    for (const wheel of vehicle.wheels) {
      const mesh = await assets.instantiate(vehicle.def.wheelModel);
      vehicle.root.add(mesh);
      wheel.mesh = mesh;
    }
    return vehicle;
  }

  setInput(input: Partial<VehicleInput>): void {
    Object.assign(this.input, input);
  }

  get speedKph(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z) * 3.6;
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  get isOccupied(): boolean {
    return this.occupants.some((o) => o !== null);
  }

  get driver(): unknown | null {
    const index = this.def.seats.findIndex((s) => s.role === 'driver');
    return index >= 0 ? this.occupants[index] ?? null : null;
  }

  /** Seat index the occupant took, or -1 when the vehicle is full. */
  enter(occupant: unknown, preferDriver = true): number {
    if (this.destroyed) return -1;
    const order = preferDriver
      ? this.def.seats.map((_, i) => i)
      : this.def.seats.map((_, i) => i).reverse();
    for (const index of order) {
      if (this.occupants[index] === null) {
        this.occupants[index] = occupant;
        return index;
      }
    }
    return -1;
  }

  exit(occupant: unknown): boolean {
    const index = this.occupants.indexOf(occupant);
    if (index < 0) return false;
    this.occupants[index] = null;
    return true;
  }

  /** World position of a seat, used to place and eject occupants. */
  seatWorldPosition(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    const seat = this.def.seats[index];
    if (!seat) return out.copy(this.position);
    out.fromArray(seat.offset);
    const t = this.body.translation();
    const r = this.body.rotation();
    return out.applyQuaternion(this.quat.set(r.x, r.y, r.z, r.w)).add(this.tmpA.set(t.x, t.y, t.z));
  }

  /** A clear spot beside the vehicle to drop an exiting occupant. */
  exitWorldPosition(out = new THREE.Vector3()): THREE.Vector3 {
    const r = this.body.rotation();
    const t = this.body.translation();
    out.set(-(this.def.trackWidth / 2 + 1.1), 0, 0)
      .applyQuaternion(this.quat.set(r.x, r.y, r.z, r.w))
      .add(this.tmpA.set(t.x, t.y, t.z));
    return out;
  }

  fixed(dt: number): void {
    if (this.destroyed) return;
    if (this.dormant) {
      this.holdDormant();
      return;
    }

    this.updateFire(dt);
    this.updateEngine(dt);

    // An empty vehicle keeps its handbrake on. Without it every parked car
    // rolls off the nearest slope and is gone by the time anyone wants it.
    if (!this.isOccupied) {
      this.input.throttle = 0;
      this.input.brake = 0;
      this.input.steer = 0;
      this.input.handbrake = true;
    }

    const r = this.body.rotation();
    this.quat.set(r.x, r.y, r.z, r.w);
    const t = this.body.translation();
    const up = this.tmpA.set(0, 1, 0).applyQuaternion(this.quat).clone();
    // The Kenney vehicles face +Z: their `wheel-front-*` nodes sit at positive Z
    // and their `wheel-back-*` at negative. Driving along -Z, as three.js
    // objects usually do, ran the car tail-first and put the steering on the
    // rear axle, which is what made every control feel reversed.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.quat);

    // Steering angle eases in so the car does not snap sideways.
    const maxSteer = 0.55 * (1 - Math.min(0.65, this.speedKph / this.def.topSpeedKph));
    const targetSteer = this.input.steer * maxSteer;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 8);

    const drivenCount = this.wheels.filter((w) => w.driven).length || 1;
    const driveForce = this.engineForce() / drivenCount;

    let groundedCount = 0;
    for (const wheel of this.wheels) {
      const worldPos = wheel.local.clone().applyQuaternion(this.quat).add(new THREE.Vector3(t.x, t.y, t.z));
      const rayLength = this.suspension.restLengthMeters + this.suspension.wheelRadiusMeters;
      const hit = this.physics.raycast(
        worldPos,
        { x: -up.x, y: -up.y, z: -up.z },
        rayLength,
        WORLD_SOLID,
        this.collider,
      );

      if (!hit) {
        wheel.grounded = false;
        wheel.lastCompression = 0;
        wheel.spinAngle += this.speedKph * dt;
        continue;
      }
      wheel.grounded = true;
      groundedCount++;
      wheel.contactPoint.set(hit.point.x, hit.point.y, hit.point.z);

      const compression = rayLength - hit.distance;
      const compressionVelocity = (compression - wheel.lastCompression) / Math.max(dt, 1e-5);
      wheel.lastCompression = compression;

      const springForce =
        compression * this.suspension.stiffness + compressionVelocity * this.suspension.damping;
      if (springForce > 0) {
        this.applyImpulseAt(up.clone().multiplyScalar(springForce * dt), worldPos);
      }

      // Tyre axes at this wheel, with the steering angle folded into the fronts.
      const steer = wheel.steered ? this.steerAngle : 0;
      const wheelForward = forward.clone().applyAxisAngle(up, steer).normalize();
      const wheelRight = right.clone().applyAxisAngle(up, steer).normalize();

      const pointVelocity = this.velocityAt(worldPos);
      const lateralSpeed = pointVelocity.dot(wheelRight);
      const forwardSpeed = pointVelocity.dot(wheelForward);

      const normalForce = Math.max(0, springForce);
      const wheelMass = this.def.massKg / this.wheels.length;

      let lateralGrip = this.tyre.gripLateral;
      if (wheel.health <= 0) lateralGrip *= this.tyre.flatTyreGripMultiplier;
      if (this.input.handbrake && !wheel.steered) {
        lateralGrip *= this.tyre.handbrakeGripMultiplier;
      }

      // Coulomb friction: cancelling the sideways slip takes `mass * slip` of
      // impulse and the tyre can supply at most `grip * load * dt` of it. The
      // previous version scaled that by an arbitrary 0.06 *and* divided the load
      // by the car's own weight, landing about two hundred times short — which
      // is exactly why the car skated as if the road were ice.
      const maxLateral = lateralGrip * normalForce * dt;
      const lateralImpulse = THREE.MathUtils.clamp(
        -lateralSpeed * wheelMass,
        -maxLateral,
        maxLateral,
      );
      // Applied level with the centre of mass rather than down at the hub: a
      // sideways impulse below the centre also rolls the car, and at this grip
      // level a hard turn would put it on its roof. Only the horizontal lever
      // arm steers, so flattening the point keeps the yaw and drops the roll.
      this.applyImpulseAt(
        wheelRight.clone().multiplyScalar(lateralImpulse),
        this.tmpC.set(worldPos.x, t.y, worldPos.z),
      );

      let longitudinalImpulse = wheel.driven ? driveForce * dt : 0;
      const brakeForce =
        this.input.brake * DEFAULTS.brakes.force +
        (this.input.handbrake && !wheel.steered ? DEFAULTS.brakes.handbrakeForce : 0);
      // Brakes stop the wheel; they never drag it backwards through zero.
      const brakeImpulse = Math.min(brakeForce * dt, Math.abs(forwardSpeed) * wheelMass);
      longitudinalImpulse -= Math.sign(forwardSpeed) * brakeImpulse;
      longitudinalImpulse -= forwardSpeed * this.tyre.rollingResistance * wheelMass;

      let longitudinalGrip = this.tyre.gripLongitudinal;
      if (wheel.health <= 0) longitudinalGrip *= this.tyre.flatTyreGripMultiplier;
      const maxTraction = longitudinalGrip * normalForce * dt;
      longitudinalImpulse = THREE.MathUtils.clamp(longitudinalImpulse, -maxTraction, maxTraction);
      // Drive and braking stay at the hub, so the car still squats and dives.
      this.applyImpulseAt(wheelForward.clone().multiplyScalar(longitudinalImpulse), worldPos);

      wheel.spinAngle += (forwardSpeed / this.suspension.wheelRadiusMeters) * dt;
    }

    // Aerodynamic drag, so top speed is bounded by something physical.
    const v = this.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed > 0.1) {
      const drag = DEFAULTS.aero.dragCoefficient * speed * speed;
      this.body.applyImpulse(
        { x: (-v.x / speed) * drag * dt, y: 0, z: (-v.z / speed) * drag * dt },
        true,
      );
    }

    this.consumeFuel(dt, groundedCount > 0);
  }

  /** Applies an impulse, in newton-seconds, at a world point. */
  private applyImpulseAt(impulse: THREE.Vector3, at: THREE.Vector3): void {
    this.body.applyImpulseAtPoint(
      { x: impulse.x, y: impulse.y, z: impulse.z },
      { x: at.x, y: at.y, z: at.z },
      true,
    );
  }

  /** Velocity of the rigid body at a world point, including rotation. */
  private velocityAt(point: THREE.Vector3): THREE.Vector3 {
    const linear = this.body.linvel();
    const angular = this.body.angvel();
    const t = this.body.translation();
    const r = this.tmpB.set(point.x - t.x, point.y - t.y, point.z - t.z);
    return new THREE.Vector3(
      linear.x + (angular.y * r.z - angular.z * r.y),
      linear.y + (angular.z * r.x - angular.x * r.z),
      linear.z + (angular.x * r.y - angular.y * r.x),
    );
  }

  /** Drive force at the wheels, from the torque curve, gearing and damage. */
  private engineForce(): number {
    if (this.fuelLitres <= 0 || this.destroyed) return 0;
    const e = DEFAULTS.engine;
    const fraction = THREE.MathUtils.clamp(
      (this.rpm - e.idleRpm) / (e.maxRpm - e.idleRpm),
      0,
      1,
    );
    let torque = 0;
    const curve = e.torqueCurve;
    for (let i = 1; i < curve.length; i++) {
      const a = curve[i - 1]!;
      const b = curve[i]!;
      if (fraction <= b[0]!) {
        const t = (fraction - a[0]!) / Math.max(b[0]! - a[0]!, 1e-6);
        torque = a[1]! + (b[1]! - a[1]!) * t;
        break;
      }
      torque = b[1]!;
    }

    const gearRatio = this.def.gearRatios[this.gear - 1] ?? 1;
    const damageFactor =
      this.engineHealth <= 0
        ? 0
        : this.engineHealth < DEFAULTS.damage.engineFailFraction * 100
          ? DEFAULTS.damage.enginePowerAtFail
          : 1;
    const shifting = this.shiftTimer > 0 ? 0 : 1;

    return (
      this.input.throttle *
      this.def.enginePowerNm *
      torque *
      gearRatio *
      this.def.finalDrive *
      DEFAULTS.engineForceScale *
      damageFactor *
      shifting
    );
  }

  /** Automatic gearbox driven by the speed the current gear can carry. */
  private updateEngine(dt: number): void {
    const e = DEFAULTS.engine;
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    const speed = Math.abs(this.speedKph);
    const gearTop = this.def.topSpeedKph * ((this.gear) / this.def.gearRatios.length);
    const fraction = THREE.MathUtils.clamp(speed / Math.max(gearTop, 1), 0, 1.2);
    this.rpm = e.idleRpm + fraction * (e.maxRpm - e.idleRpm);

    if (this.shiftTimer <= 0) {
      if (fraction > e.shiftUpFraction && this.gear < this.def.gearRatios.length) {
        this.gear++;
        this.shiftTimer = e.shiftSeconds;
      } else if (fraction < e.shiftDownFraction && this.gear > 1) {
        this.gear--;
        this.shiftTimer = e.shiftSeconds;
      }
    }
  }

  private consumeFuel(dt: number, grounded: boolean): void {
    if (this.fuelLitres <= 0) return;
    const f = DEFAULTS.fuel;
    const burn = f.idleLitresPerSecond + this.input.throttle * f.litresPerSecondAtFullThrottle;
    // A leaking tank drains whether or not the engine is running.
    const leak = this.fuelTankHealth <= 0 ? 0.35 : 0;
    this.fuelLitres = Math.max(0, this.fuelLitres - (grounded ? burn : burn * 0.4) * dt - leak * dt);
  }

  private updateFire(dt: number): void {
    if (this.fireTimer <= 0) return;
    this.fireTimer -= dt;
    if (this.fireTimer <= 0) this.destroyed = true;
  }

  // ---- Damage -----------------------------------------------------------

  /** Localised damage from a hit at a world point. */
  applyHit(point: THREE.Vector3, amount: number): void {
    if (this.destroyed) return;
    const local = point.clone().sub(this.position);
    const r = this.body.rotation();
    local.applyQuaternion(this.quat.set(r.x, r.y, r.z, r.w).invert());

    // Nearest wheel within reach takes tyre damage; otherwise the hull.
    let nearest: Wheel | null = null;
    let nearestDistance = 0.85;
    for (const wheel of this.wheels) {
      const d = wheel.local.distanceTo(local);
      if (d < nearestDistance) {
        nearest = wheel;
        nearestDistance = d;
      }
    }
    if (nearest && nearest.health > 0) {
      nearest.health -= amount;
      return;
    }

    // Front of the hull is the engine bay; the rear holds the tank.
    if (local.z > 0.4) {
      this.engineHealth = Math.max(0, this.engineHealth - amount * 0.9);
    } else if (local.z < -0.4) {
      this.fuelTankHealth -= amount;
      if (this.fuelTankHealth <= 0 && this.fireTimer <= 0) {
        // Punctured tank leaks, catches, and then goes up.
        this.fireTimer = DEFAULTS.damage.fireSeconds;
      }
    } else {
      this.engineHealth = Math.max(0, this.engineHealth - amount * 0.25);
    }
  }

  /** Damage a body would take from being hit by this vehicle. */
  runOverDamage(): number {
    const speed = this.speedKph / 3.6;
    if (speed < DEFAULTS.damage.runOverSpeedThreshold) return 0;
    return speed * DEFAULTS.damage.runOverDamagePerMeterPerSecond;
  }

  refuel(litres = DEFAULTS.fuel.jerrycanLitres): void {
    this.fuelLitres = Math.min(DEFAULTS.fuel.capacityLitres, this.fuelLitres + litres);
  }

  /** Puts the vehicle back on its wheels after a roll. */
  recover(): void {
    const t = this.body.translation();
    this.body.setTranslation({ x: t.x, y: t.y + 1.2, z: t.z }, true);
    const yaw = this.heading;
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Where the nose points, in world yaw radians. */
  get heading(): number {
    const r = this.body.rotation();
    const q = this.quat.set(r.x, r.y, r.z, r.w);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    return Math.atan2(forward.x, forward.z);
  }

  /**
   * Yaw for a camera that should look where the car is going. A three.js camera
   * looks down its own -Z while these models face +Z, so the two are half a turn
   * apart; naming it keeps that offset out of the camera code — and out of
   * `recover()`, which used to stand a rolled car back up facing backwards.
   */
  get cameraYaw(): number {
    return this.heading + Math.PI;
  }

  get isUpsideDown(): boolean {
    const r = this.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat.set(r.x, r.y, r.z, r.w));
    return up.y < 0.2;
  }

  /** Syncs the visual transforms; called from the render step. */
  frame(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(r.x, r.y, r.z, r.w);

    for (const wheel of this.wheels) {
      if (!wheel.mesh) continue;
      const drop = wheel.grounded
        ? this.suspension.restLengthMeters - wheel.lastCompression
        : this.suspension.restLengthMeters;
      // `drop` already puts the hub one wheel radius above the contact patch,
      // so adding the radius again left every wheel hovering off the ground.
      wheel.mesh.position.set(wheel.local.x, wheel.local.y - drop, wheel.local.z);
      wheel.mesh.rotation.set(
        wheel.spinAngle,
        wheel.steered ? this.steerAngle : 0,
        0,
        'YXZ',
      );
      wheel.mesh.visible = wheel.health > 0;
    }
  }

  get debugText(): string {
    const grounded = this.wheels.filter((w) => w.grounded).length;
    const flats = this.wheels.filter((w) => w.health <= 0).length;
    return [
      `${this.def.name}  ${this.speedKph.toFixed(0)} km/h  ${this.gear}ª  ${this.rpm.toFixed(0)} rpm`,
      `rodas no chão ${grounded}/4${flats ? `  ${flats} furada(s)` : ''}`,
      `motor ${this.engineHealth.toFixed(0)}%  tanque ${this.fuelTankHealth.toFixed(0)}%  ${this.fuelLitres.toFixed(1)} L`,
      this.fireTimer > 0 ? `EM CHAMAS ${this.fireTimer.toFixed(1)}s` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  dispose(): void {
    this.physics.forget(this.collider);
    this.physics.world.removeRigidBody(this.body);
    this.scene.remove(this.root);
  }
}

export type { ZoneHealth };
