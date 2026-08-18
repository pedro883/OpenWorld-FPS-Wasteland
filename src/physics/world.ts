import RAPIER from '@dimforge/rapier3d-compat';
import { World as WorldCfg } from '../core/config';
import { FIXED_DT } from '../core/loop';
import { groups, Layer, type LayerMask } from './layers';

let initialised = false;

/** rapier3d-compat compiles its WASM at runtime; everything must await this. */
export async function initPhysics(): Promise<void> {
  if (initialised) return;
  await RAPIER.init();
  initialised = true;
}

export interface RayHit {
  distance: number;
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  collider: RAPIER.Collider;
  /** Userdata handle set by whoever created the collider. */
  userData: unknown;
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** Maps collider handle -> gameplay object, so hits resolve to entities. */
  private readonly colliderOwners = new Map<number, unknown>();

  constructor() {
    if (!initialised) throw new Error('initPhysics() must be awaited before PhysicsWorld');
    this.world = new RAPIER.World({ x: 0, y: WorldCfg.gravity, z: 0 });
    this.world.timestep = FIXED_DT;
  }

  step(): void {
    this.world.step();
  }

  own(collider: RAPIER.Collider, owner: unknown): void {
    this.colliderOwners.set(collider.handle, owner);
  }

  ownerOf(collider: RAPIER.Collider): unknown {
    return this.colliderOwners.get(collider.handle);
  }

  forget(collider: RAPIER.Collider): void {
    this.colliderOwners.delete(collider.handle);
  }

  /** Fixed collider from a trimesh — used for terrain chunks and static props. */
  addTrimesh(
    vertices: Float32Array,
    indices: Uint32Array,
    membership: LayerMask,
    filter: LayerMask,
  ): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(
      groups(membership, filter),
    );
    return this.world.createCollider(desc, body);
  }

  addCuboid(
    hx: number,
    hy: number,
    hz: number,
    pos: { x: number; y: number; z: number },
    membership: LayerMask,
    filter: LayerMask,
    dynamic = false,
  ): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
    const bodyDesc = dynamic
      ? RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z)
      : RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
    const body = this.world.createRigidBody(bodyDesc);
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setCollisionGroups(
      groups(membership, filter),
    );
    const collider = this.world.createCollider(desc, body);
    return { body, collider };
  }

  /**
   * Ray query returning the closest hit. `filter` is the set of layers the ray
   * may hit; `exclude` skips a collider (typically the shooter's own body).
   */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDistance: number,
    filter: LayerMask,
    exclude?: RAPIER.Collider,
  ): RayHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      groups(0xffff, filter),
      undefined,
      exclude?.parent() ?? undefined,
    );
    if (!hit) return null;
    const point = ray.pointAt(hit.timeOfImpact);
    return {
      distance: hit.timeOfImpact,
      point: { x: point.x, y: point.y, z: point.z },
      normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      collider: hit.collider,
      userData: this.colliderOwners.get(hit.collider.handle),
    };
  }

  /** True when nothing solid sits between the two points. */
  hasLineOfSight(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    filter: LayerMask,
  ): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return true;
    const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
    return this.raycast(from, dir, dist, filter) === null;
  }

  get bodyCount(): number {
    return this.world.bodies.len();
  }

  get colliderCount(): number {
    return this.world.colliders.len();
  }

  dispose(): void {
    this.colliderOwners.clear();
    this.world.free();
  }
}

export { RAPIER, Layer };
