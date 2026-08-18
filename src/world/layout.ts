import { Terrain, type Biome, type FlattenDisc } from './terrain.ts';

export type PoiKind = 'vila' | 'militar' | 'industrial';

export interface Poi {
  id: string;
  name: string;
  kind: PoiKind;
  x: number;
  z: number;
  /** Flat build area, in metres. */
  radius: number;
  groundHeight: number;
  biome: Biome;
}

export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Endpoint heights, taken from the POIs the road joins. */
  ay: number;
  by: number;
  width: number;
}

/**
 * Where the named places are and how roads connect them.
 *
 * Layout is computed once from the seed and then *drives* the terrain: each POI
 * and road registers a flatten disc, so the ground is levelled before a single
 * chunk is built. Doing it the other way round — placing buildings on finished
 * terrain — leaves them floating or buried on any slope.
 */
export class WorldLayout {
  readonly pois: Poi[] = [];
  readonly roads: RoadSegment[] = [];

  private readonly terrain: Terrain;

  constructor(terrain: Terrain) {
    this.terrain = terrain;
    this.build();
  }

  private build(): void {
    const half = this.terrain.params.sizeMeters / 2;
    // Spread across the map, well inside the border so streaming never runs out.
    const spots: Array<{ id: string; name: string; kind: PoiKind; x: number; z: number; radius: number }> = [
      { id: 'vila', name: 'Vila Cinza', kind: 'vila', x: -half * 0.42, z: half * 0.34, radius: 78 },
      { id: 'base', name: 'Posto Avançado Ferro', kind: 'militar', x: half * 0.38, z: half * 0.44, radius: 66 },
      { id: 'usina', name: 'Complexo Usina', kind: 'industrial', x: half * 0.12, z: -half * 0.47, radius: 92 },
    ];

    for (const spot of spots) {
      // Level to the natural height at the centre, so a POI still sits in the
      // landscape instead of on an obvious plateau at a fixed altitude.
      const groundHeight = Math.max(
        this.terrain.params.waterLevel + 4,
        this.terrain.heightAt(spot.x, spot.z),
      );
      this.pois.push({
        ...spot,
        groundHeight,
        biome: this.terrain.biomeAt(spot.x, spot.z),
      });
    }

    // A ring road: every POI reachable from every other without backtracking.
    for (let i = 0; i < this.pois.length; i++) {
      const a = this.pois[i]!;
      const b = this.pois[(i + 1) % this.pois.length]!;
      // Heights come from the POIs, not from the raw terrain: the POI discs
      // already raised those spots, and sampling the untouched ground here
      // would make the road disc undo the POI it starts from.
      this.roads.push({
        ax: a.x,
        az: a.z,
        ay: a.groundHeight,
        bx: b.x,
        bz: b.z,
        by: b.groundHeight,
        width: 9,
      });
    }

    this.terrain.setFlattenDiscs(this.flattenDiscs());
  }

  /**
   * Discs for the terrain to level. Roads become a chain of overlapping discs,
   * which is cheap to evaluate and gives a naturally rounded cut.
   */
  private flattenDiscs(): FlattenDisc[] {
    const discs: FlattenDisc[] = [];
    for (const poi of this.pois) {
      discs.push({
        x: poi.x,
        z: poi.z,
        radius: poi.radius,
        falloff: poi.radius * 0.7,
        height: poi.groundHeight,
      });
    }

    for (const road of this.roads) {
      const dx = road.bx - road.ax;
      const dz = road.bz - road.az;
      const length = Math.hypot(dx, dz);
      const steps = Math.max(2, Math.ceil(length / 18));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        discs.push({
          x: road.ax + dx * t,
          z: road.az + dz * t,
          radius: road.width * 0.6,
          falloff: road.width * 1.6,
          // Linear grade between the endpoints keeps the road drivable.
          height: road.ay + (road.by - road.ay) * t,
        });
      }
    }
    return discs;
  }

  /** Distance to the nearest road centreline, for scatter suppression. */
  distanceToRoad(x: number, z: number): number {
    let best = Infinity;
    for (const road of this.roads) {
      const dx = road.bx - road.ax;
      const dz = road.bz - road.az;
      const lengthSq = dx * dx + dz * dz;
      const t =
        lengthSq > 0
          ? Math.max(0, Math.min(1, ((x - road.ax) * dx + (z - road.az) * dz) / lengthSq))
          : 0;
      const px = road.ax + dx * t;
      const pz = road.az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Height of the road surface at a point, matching the grade the flatten
   * discs cut into the terrain. The ribbon mesh uses this so the road sits on
   * the ground it levelled rather than sampling noisy terrain.
   */
  roadHeightAt(x: number, z: number): number {
    let best = Infinity;
    let height = this.terrain.heightAt(x, z);
    for (const road of this.roads) {
      const dx = road.bx - road.ax;
      const dz = road.bz - road.az;
      const lengthSq = dx * dx + dz * dz;
      const t =
        lengthSq > 0
          ? Math.max(0, Math.min(1, ((x - road.ax) * dx + (z - road.az) * dz) / lengthSq))
          : 0;
      const px = road.ax + dx * t;
      const pz = road.az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) {
        best = d;
        height = road.ay + (road.by - road.ay) * t;
      }
    }
    return height;
  }

  poiAt(x: number, z: number): Poi | null {
    for (const poi of this.pois) {
      if (Math.hypot(x - poi.x, z - poi.z) <= poi.radius) return poi;
    }
    return null;
  }

  nearestPoi(x: number, z: number): { poi: Poi; distance: number } {
    let best = this.pois[0]!;
    let bestDistance = Infinity;
    for (const poi of this.pois) {
      const d = Math.hypot(x - poi.x, z - poi.z);
      if (d < bestDistance) {
        bestDistance = d;
        best = poi;
      }
    }
    return { poi: best, distance: bestDistance };
  }
}
