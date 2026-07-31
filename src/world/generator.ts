/**
 * Procedural world generation.
 *
 * Used for the default starter world and by several AI commands (mountains,
 * forests, rivers, rolling hills). Everything is expressed as block writes
 * through a `BlockSink`, so generation is previewable and undoable exactly like
 * a manual edit.
 */

import { AIR, blockRegistry } from './blocks';
import type { World } from './world';
import type { BlockSink } from '../edit/operations';
import { makeNoise2D, makeRandom } from '../edit/operations';
import { biomeById, resolveLayers, type BiomeDefinition } from '../edit/biomes';
import type { Region, Vec3 } from '../core/types';
import { vec3 } from '../core/types';

const id = (name: string): number => blockRegistry.resolve(name)?.id ?? 0;

export interface TerrainOptions {
  seed?: number;
  baseHeight?: number;
  amplitude?: number;
  /** Horizontal feature scale — larger = smoother, wider hills. */
  scale?: number;
  biome?: string;
  /** Sea level; columns below it are flooded with water. */
  seaLevel?: number;
  water?: boolean;
}

/** Generates a heightmap-based terrain across a region footprint. */
export function generateTerrain(
  sink: BlockSink,
  region: Region,
  options: TerrainOptions = {},
): number {
  const {
    seed = 1337,
    baseHeight = 64,
    amplitude = 18,
    scale = 90,
    biome = 'plains',
    seaLevel = 0,
    water = false,
  } = options;

  const noise = makeNoise2D(seed);
  const detail = makeNoise2D(seed + 991);
  const layers = resolveLayers(biomeById(biome));
  const waterId = id('water');
  let n = 0;

  for (let z = region.min.z; z <= region.max.z; z++) {
    for (let x = region.min.x; x <= region.max.x; x++) {
      const base = noise(x / scale, z / scale);
      const fine = detail(x / (scale * 0.25), z / (scale * 0.25));
      const height = Math.round(baseHeight + (base - 0.5) * 2 * amplitude + (fine - 0.5) * amplitude * 0.22);
      const top = Math.max(region.min.y, Math.min(region.max.y, height));

      let y = top;
      for (const layer of layers) {
        for (let d = 0; d < layer.depth && y >= region.min.y; d++, y--) {
          if (sink.set(x, y, z, layer.id)) n++;
        }
      }
      // Solid base below the layer stack.
      const stoneId = id('stone');
      for (; y >= region.min.y; y--) if (sink.set(x, y, z, stoneId)) n++;

      if (water && top < seaLevel) {
        for (let wy = top + 1; wy <= seaLevel; wy++) if (sink.set(x, wy, z, waterId)) n++;
      }
    }
  }
  return n;
}

/** Raises a mountain massif centred on a point. */
export function generateMountain(
  sink: BlockSink,
  world: World,
  centre: Vec3,
  options: { radius?: number; height?: number; seed?: number; snowLine?: number; biome?: string } = {},
): number {
  const { radius = 48, height = 60, seed = 7, snowLine = 0.72, biome = 'mountain' } = options;
  const noise = makeNoise2D(seed);
  const ridge = makeNoise2D(seed + 4242);
  const layers = resolveLayers(biomeById(biome));
  const stoneId = id('stone');
  const snowId = id('snow_block');
  let n = 0;

  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dist = Math.sqrt(dx * dx + dz * dz) / radius;
      if (dist > 1) continue;
      const x = centre.x + dx;
      const z = centre.z + dz;

      // Cone falloff × ridged noise gives believable peaks and shoulders.
      const falloff = Math.cos(dist * Math.PI * 0.5) ** 2.1;
      const rough = 0.65 + 0.7 * (1 - Math.abs(ridge(x / 34, z / 34) * 2 - 1));
      const wobble = 0.8 + noise(x / 70, z / 70) * 0.5;
      const rise = Math.round(height * falloff * rough * wobble);
      if (rise <= 0) continue;

      const ground = Math.max(world.surfaceAt(x, z), world.bounds.minY);
      const peak = Math.min(world.bounds.maxY, ground + rise);

      for (let y = ground + 1; y <= peak; y++) {
        const altitude = (y - ground) / Math.max(1, height);
        let block = stoneId;
        if (altitude > snowLine) block = snowId;
        else if (y >= peak - (layers[0]?.depth ?? 1) + 1) block = layers[0]?.id ?? stoneId;
        if (sink.set(x, y, z, block)) n++;
      }
    }
  }
  return n;
}

/** Rolling hills: gently re-profiles existing terrain rather than replacing it. */
export function generateRollingHills(
  sink: BlockSink,
  world: World,
  region: Region,
  options: { seed?: number; amplitude?: number; scale?: number; biome?: string } = {},
): number {
  const { seed = 99, amplitude = 10, scale = 46, biome = 'plains' } = options;
  const noise = makeNoise2D(seed);
  const layers = resolveLayers(biomeById(biome));
  let n = 0;

  for (let z = region.min.z; z <= region.max.z; z++) {
    for (let x = region.min.x; x <= region.max.x; x++) {
      const current = world.surfaceAt(x, z);
      if (current < world.bounds.minY) continue;
      const target = Math.round(current + (noise(x / scale, z / scale) - 0.5) * 2 * amplitude);
      const clamped = Math.max(region.min.y, Math.min(region.max.y, target));

      if (clamped > current) {
        for (let y = current + 1; y <= clamped; y++) if (sink.set(x, y, z, layers[1]?.id ?? layers[0].id)) n++;
      } else if (clamped < current) {
        for (let y = current; y > clamped; y--) if (sink.set(x, y, z, AIR)) n++;
      }
      // Re-cap the surface with the biome's top layer.
      let y = clamped;
      for (const layer of layers) {
        for (let d = 0; d < layer.depth && y >= region.min.y; d++, y--) {
          if (sink.get(x, y, z) === AIR) continue;
          if (sink.set(x, y, z, layer.id)) n++;
        }
      }
    }
  }
  return n;
}

/** Plants a single tree; returns blocks written. */
export function plantTree(
  sink: BlockSink,
  base: Vec3,
  species: { log: string; leaves: string; minHeight: number; maxHeight: number },
  rand: () => number,
): number {
  const logId = id(species.log);
  const leafId = id(species.leaves);
  const height = Math.round(species.minHeight + rand() * (species.maxHeight - species.minHeight));
  let n = 0;

  for (let y = 0; y < height; y++) if (sink.set(base.x, base.y + y, base.z, logId)) n++;

  // Canopy: stacked discs with jittered edges.
  const crownBase = base.y + Math.max(2, height - 4);
  const crownTop = base.y + height + 1;
  for (let y = crownBase; y <= crownTop; y++) {
    const t = (y - crownBase) / Math.max(1, crownTop - crownBase);
    const r = Math.max(1, Math.round((1 - t * t) * 2.6));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > r * r + 1) continue;
        if (d2 >= r * r && rand() < 0.45) continue;
        if (dx === 0 && dz === 0 && y < base.y + height) continue;
        if (sink.get(base.x + dx, y, base.z + dz) !== AIR) continue;
        if (sink.set(base.x + dx, y, base.z + dz, leafId)) n++;
      }
    }
  }
  return n;
}

/** Scatters trees across a region's surface. */
export function generateForest(
  sink: BlockSink,
  world: World,
  region: Region,
  options: { density?: number; seed?: number; biome?: string } = {},
): number {
  const { density = 0.045, seed = 42, biome = 'forest' } = options;
  const def: BiomeDefinition = biomeById(biome);
  const species = def.tree ?? biomeById('forest').tree!;
  const rand = makeRandom(seed);
  const grassLike = new Set([id('grass_block'), id('dirt'), id('podzol'), id('moss_block'), id('coarse_dirt')]);
  let n = 0;
  const planted: Vec3[] = [];

  for (let z = region.min.z; z <= region.max.z; z++) {
    for (let x = region.min.x; x <= region.max.x; x++) {
      if (rand() > density) continue;
      const surface = world.surfaceAt(x, z);
      if (surface < region.min.y || surface >= region.max.y - 4) continue;
      if (!grassLike.has(world.getBlock(x, surface, z))) continue;
      // Minimum spacing so canopies don't fuse into a solid slab.
      if (planted.some((p) => Math.abs(p.x - x) < 3 && Math.abs(p.z - z) < 3)) continue;
      planted.push(vec3(x, surface, z));
      n += plantTree(sink, vec3(x, surface + 1, z), species, rand);
    }
  }
  return n;
}

/** Carves a meandering river across a region and fills it with water. */
export function generateRiver(
  sink: BlockSink,
  world: World,
  region: Region,
  options: { width?: number; depth?: number; seed?: number; banks?: boolean } = {},
): number {
  const { width = 6, depth = 4, seed = 512, banks = true } = options;
  const noise = makeNoise2D(seed);
  const waterId = id('water');
  const sandId = id('sand');
  let n = 0;

  const spanX = region.max.x - region.min.x;
  const spanZ = region.max.z - region.min.z;
  const alongX = spanX >= spanZ;
  const length = alongX ? spanX : spanZ;
  const cross = alongX ? spanZ : spanX;

  for (let t = 0; t <= length; t++) {
    // Meander the centreline with low-frequency noise.
    const wander = (noise(t / 55, seed / 100) - 0.5) * cross * 0.55;
    const centre = (alongX ? region.min.z + spanZ / 2 : region.min.x + spanX / 2) + wander;
    const localWidth = width * (0.75 + noise(t / 22, 9.5) * 0.6);

    for (let c = -Math.ceil(localWidth); c <= Math.ceil(localWidth); c++) {
      const x = alongX ? region.min.x + t : Math.round(centre) + c;
      const z = alongX ? Math.round(centre) + c : region.min.z + t;
      if (x < region.min.x || x > region.max.x || z < region.min.z || z > region.max.z) continue;

      const edge = Math.abs(c) / localWidth;
      if (edge > 1) continue;
      const carve = Math.round(depth * Math.cos(edge * Math.PI * 0.5));
      const surface = world.surfaceAt(x, z);
      if (surface < region.min.y) continue;

      const bed = Math.max(region.min.y, surface - carve);
      for (let y = surface; y > bed; y--) if (sink.set(x, y, z, AIR)) n++;
      // Water fills from the bed up to just under the original surface.
      const waterTop = Math.max(bed, surface - 1);
      for (let y = bed + 1; y <= waterTop; y++) if (sink.set(x, y, z, waterId)) n++;
      if (sink.set(x, bed, z, banks && edge > 0.72 ? sandId : id('gravel'))) n++;
    }
  }
  return n;
}

/** Builds the default starter world so a fresh session isn't an empty void. */
export function generateStarterWorld(world: World, sink: BlockSink, size = 192): void {
  const half = Math.floor(size / 2);
  const region: Region = {
    min: vec3(-half, 0, -half),
    max: vec3(half, 255, half),
  };
  generateTerrain(sink, { min: region.min, max: vec3(region.max.x, 90, region.max.z) }, {
    seed: 20240730,
    baseHeight: 62,
    amplitude: 14,
    scale: 78,
    biome: 'plains',
    seaLevel: 58,
    water: true,
  });
  world.flush();
  generateForest(sink, world, region, { density: 0.02, seed: 8, biome: 'forest' });
  world.flush();
}
