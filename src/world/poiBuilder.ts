import * as THREE from 'three';
import { assets } from '../core/assets';
import { groups, Layer } from '../physics/layers';
import { RAPIER, type PhysicsWorld } from '../physics/world';
import type { Poi, WorldLayout } from './layout';

/** Model palette per POI kind. Buildings are solid; props are decoration. */
const PALETTE: Record<
  Poi['kind'],
  { buildings: string[]; props: string[]; material: string }
> = {
  vila: {
    buildings: [
      'city-kit-suburban/building-type-a',
      'city-kit-suburban/building-type-b',
      'city-kit-suburban/building-type-c',
      'city-kit-suburban/building-type-e',
    ],
    props: ['survival-kit/barrel', 'survival-kit/box-large', 'car-kit/sedan'],
    material: 'wood',
  },
  militar: {
    buildings: [
      'city-kit-industrial/building-m',
      'modular-buildings/building-sample-tower-a',
      'city-kit-industrial/building-r',
    ],
    props: ['survival-kit/fence-fortified', 'survival-kit/barrel', 'car-kit/truck'],
    material: 'sandbag',
  },
  industrial: {
    buildings: [
      'city-kit-industrial/building-m',
      'city-kit-industrial/building-r',
      'factory-kit/structure-high',
      'factory-kit/structure-medium',
      'factory-kit/crane',
    ],
    props: ['survival-kit/barrel', 'factory-kit/box-large', 'car-kit/van'],
    material: 'metal',
  },
};

function hash(a: number, b: number, seed: number): number {
  let h = a * 374761393 + b * 668265263 + seed * 2246822519;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Placed {
  object: THREE.Object3D;
  collider: RAPIER.Collider | null;
  body: RAPIER.RigidBody | null;
}

/**
 * Builds the named places from Kenney kits.
 *
 * Buildings get a box collider sized from the model's own bounds rather than a
 * mesh collider: a POI holds dozens of them, and trimesh colliders at that
 * count cost far more than the accuracy is worth for a solid wall.
 */
export class PoiBuilder {
  private readonly placed: Placed[] = [];
  private readonly roadMeshes: THREE.Mesh[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: PhysicsWorld,
    private readonly layout: WorldLayout,
  ) {}

  async buildAll(): Promise<void> {
    const ids = new Set<string>();
    for (const palette of Object.values(PALETTE)) {
      for (const id of [...palette.buildings, ...palette.props]) ids.add(id);
    }
    await assets.prepare(...ids);

    for (const poi of this.layout.pois) await this.buildPoi(poi);
    this.buildRoads();
  }

  private async buildPoi(poi: Poi): Promise<void> {
    const palette = PALETTE[poi.kind];
    const available = palette.buildings.filter((id) => assets.entry(id));
    if (!available.length) return;

    // Ring layout: a plaza in the middle, buildings facing inwards. Simple, but
    // it reads as a settlement instead of a random scatter.
    const rings = [
      { radius: poi.radius * 0.45, count: 6 },
      { radius: poi.radius * 0.78, count: 9 },
    ];
    let index = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.count; i++) {
        const jitter = hash(index, i, 7) * 0.5;
        const angle = ((i + jitter) / ring.count) * Math.PI * 2;
        const radius = ring.radius * (0.9 + hash(index, i, 13) * 0.2);
        const x = poi.x + Math.cos(angle) * radius;
        const z = poi.z + Math.sin(angle) * radius;
        const id = available[Math.floor(hash(index, i, 19) * available.length) % available.length]!;
        await this.place(id, x, poi.groundHeight, z, -angle + Math.PI / 2, palette.material, true);
        index++;
      }
    }

    const props = palette.props.filter((id) => assets.entry(id));
    for (let i = 0; i < 14 && props.length; i++) {
      const angle = hash(index, i, 23) * Math.PI * 2;
      const radius = poi.radius * (0.15 + hash(index, i, 29) * 0.55);
      const id = props[Math.floor(hash(index, i, 31) * props.length) % props.length]!;
      await this.place(
        id,
        poi.x + Math.cos(angle) * radius,
        poi.groundHeight,
        poi.z + Math.sin(angle) * radius,
        hash(index, i, 37) * Math.PI * 2,
        palette.material,
        false,
      );
      index++;
    }
  }

  private async place(
    id: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    material: string,
    solid: boolean,
  ): Promise<void> {
    const entry = assets.entry(id);
    if (!entry) return;
    const model = await assets.instantiate(id);
    const scale = assets.scaleFor(id);
    model.position.set(x, y - entry.bounds.min[1] * scale, z);
    model.rotation.y = yaw;
    this.scene.add(model);

    let collider: RAPIER.Collider | null = null;
    let body: RAPIER.RigidBody | null = null;
    if (solid) {
      const size = assets.sizeOf(id);
      const centreY = y + size.y / 2;
      body = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(x, centreY, z)
          .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }),
      );
      collider = this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setCollisionGroups(
          groups(Layer.STATIC, 0xffff),
        ),
        body,
      );
      this.physics.own(collider, { kind: 'surface', material });
    }
    this.placed.push({ object: model, collider, body });
  }

  /**
   * Roads as a flat ribbon rather than tiled road pieces. The terrain is
   * already levelled along the path, so a ribbon follows it exactly; kit tiles
   * would need orientation and junction logic for no visible gain at this scale.
   */
  private buildRoads(): void {
    for (const road of this.layout.roads) {
      const dx = road.bx - road.ax;
      const dz = road.bz - road.az;
      const length = Math.hypot(dx, dz);
      const steps = Math.max(2, Math.ceil(length / 8));
      const nx = -dz / length;
      const nz = dx / length;
      const half = road.width / 2;

      const positions = new Float32Array((steps + 1) * 2 * 3);
      const indices: number[] = [];
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = road.ax + dx * t;
        const cz = road.az + dz * t;
        // Sit just above the flattened ground to avoid z-fighting.
        const y = this.layout.roadHeightAt(cx, cz) + 0.06;
        const base = s * 6;
        positions[base] = cx + nx * half;
        positions[base + 1] = y;
        positions[base + 2] = cz + nz * half;
        positions[base + 3] = cx - nx * half;
        positions[base + 4] = y;
        positions[base + 5] = cz - nz * half;
        if (s < steps) {
          const a = s * 2;
          indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshLambertMaterial({ color: 0x2f3134 }),
      );
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.roadMeshes.push(mesh);
    }
  }

  get stats(): string {
    return `POIs ${this.layout.pois.length}  objetos ${this.placed.length}  estradas ${this.roadMeshes.length}`;
  }

  dispose(): void {
    for (const item of this.placed) {
      this.scene.remove(item.object);
      if (item.collider) {
        this.physics.forget(item.collider);
        this.physics.world.removeCollider(item.collider, false);
      }
      if (item.body) this.physics.world.removeRigidBody(item.body);
    }
    this.placed.length = 0;
    for (const mesh of this.roadMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.roadMeshes.length = 0;
  }
}
