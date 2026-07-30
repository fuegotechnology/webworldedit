/**
 * Structure generators.
 *
 * These are the "building blocks" the AI assistant composes. Each one is a
 * deterministic function of (anchor, options, seed) writing through a
 * `BlockSink`, so a preview and the committed result are always identical.
 */

import { AIR, blockRegistry } from '../world/blocks';
import type { World } from '../world/world';
import type { BlockSink } from '../edit/operations';
import { brush, fill, line, makeRandom, pyramid, walls } from '../edit/operations';
import type { Region, Vec3 } from '../core/types';
import { normalizeRegion, vec3 } from '../core/types';

const id = (name: string): number => blockRegistry.resolve(name)?.id ?? 0;

export interface StructureStyle {
  wall: string;
  accent: string;
  floor: string;
  roof: string;
  trim: string;
  glass: string;
  light: string;
}

export const STYLES: Record<string, StructureStyle> = {
  medieval: {
    wall: 'stone_bricks',
    accent: 'mossy_stone_bricks',
    floor: 'stone_bricks',
    roof: 'dark_oak_planks',
    trim: 'oak_log',
    glass: 'glass',
    light: 'glowstone',
  },
  rustic: {
    wall: 'oak_planks',
    accent: 'spruce_planks',
    floor: 'stone',
    roof: 'dark_oak_planks',
    trim: 'oak_log',
    glass: 'glass',
    light: 'glowstone',
  },
  desert: {
    wall: 'sandstone',
    accent: 'smooth_stone',
    floor: 'sandstone',
    roof: 'sandstone',
    trim: 'terracotta',
    glass: 'glass',
    light: 'glowstone',
  },
  modern: {
    wall: 'white_concrete',
    accent: 'gray_concrete',
    floor: 'smooth_stone',
    roof: 'black_concrete',
    trim: 'quartz_block',
    glass: 'glass',
    light: 'sea_lantern',
  },
  dark: {
    wall: 'blackstone',
    accent: 'deepslate_bricks',
    floor: 'cobbled_deepslate',
    roof: 'nether_bricks',
    trim: 'obsidian',
    glass: 'glass',
    light: 'sea_lantern',
  },
};

export const styleByName = (name = 'medieval'): StructureStyle => STYLES[name] ?? STYLES.medieval;

/** Flattens and paves a footprint so structures don't float or bury themselves. */
export function prepareFoundation(
  sink: BlockSink,
  world: World,
  region: Region,
  groundY: number,
  material: number,
): number {
  let n = 0;
  for (let z = region.min.z; z <= region.max.z; z++) {
    for (let x = region.min.x; x <= region.max.x; x++) {
      // Clear anything above the pad.
      for (let y = groundY + 1; y <= Math.min(world.bounds.maxY, groundY + 40); y++) {
        if (sink.get(x, y, z) === AIR) continue;
        if (sink.set(x, y, z, AIR)) n++;
      }
      // Fill down to solid ground so the pad sits on something.
      for (let y = groundY; y > groundY - 6; y--) {
        if (sink.get(x, y, z) !== AIR) break;
        if (sink.set(x, y, z, material)) n++;
      }
      if (sink.set(x, groundY, z, material)) n++;
    }
  }
  return n;
}

/** Median ground height over a footprint — where a structure should sit. */
export function averageGround(world: World, region: Region): number {
  const samples: number[] = [];
  const stepX = Math.max(1, Math.floor((region.max.x - region.min.x) / 12));
  const stepZ = Math.max(1, Math.floor((region.max.z - region.min.z) / 12));
  for (let z = region.min.z; z <= region.max.z; z += stepZ)
    for (let x = region.min.x; x <= region.max.x; x += stepX) samples.push(world.surfaceAt(x, z));
  if (samples.length === 0) return 64;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

// ------------------------------------------------------------------- towers

export function buildTower(
  sink: BlockSink,
  centre: Vec3,
  options: { radius?: number; height?: number; style?: StructureStyle; crenellations?: boolean } = {},
): number {
  const { radius = 4, height = 18, style = STYLES.medieval, crenellations = true } = options;
  const wall = id(style.wall);
  const accent = id(style.accent);
  const floor = id(style.floor);
  const lightId = id(style.light);
  let n = 0;

  for (let y = 0; y < height; y++) {
    const band = y % 6 === 5 ? accent : wall;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > radius + 0.4) continue;
        const isShell = d > radius - 1;
        const x = centre.x + dx;
        const z = centre.z + dz;
        if (isShell) {
          // Arrow slits.
          if (y % 5 === 3 && (dx === 0 || dz === 0)) continue;
          if (sink.set(x, centre.y + y, z, band)) n++;
        } else if (y % 6 === 0) {
          if (sink.set(x, centre.y + y, z, floor)) n++;
        } else if (sink.set(x, centre.y + y, z, AIR)) n++;
      }
    }
  }

  // Battlements.
  if (crenellations) {
    let i = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d <= radius - 1 || d > radius + 0.4) continue;
        if (i++ % 2 === 0) {
          if (sink.set(centre.x + dx, centre.y + height, centre.z + dz, wall)) n++;
          if (sink.set(centre.x + dx, centre.y + height + 1, centre.z + dz, wall)) n++;
        }
      }
    }
  }
  // Beacon light on top.
  if (sink.set(centre.x, centre.y + height - 1, centre.z, lightId)) n++;
  return n;
}

// -------------------------------------------------------------------- castle

export function buildCastle(
  sink: BlockSink,
  world: World,
  centre: Vec3,
  options: { size?: number; style?: StructureStyle; seed?: number; moat?: boolean } = {},
): number {
  const { size = 40, style = STYLES.medieval, seed = 1, moat = true } = options;
  const rand = makeRandom(seed);
  const half = Math.floor(size / 2);
  const footprint = normalizeRegion(
    vec3(centre.x - half - 4, 0, centre.z - half - 4),
    vec3(centre.x + half + 4, 0, centre.z + half + 4),
  );
  const ground = averageGround(world, footprint);
  const wall = id(style.wall);
  const accent = id(style.accent);
  const floorId = id(style.floor);
  const roof = id(style.roof);
  const glassId = id(style.glass);
  const lightId = id(style.light);
  const waterId = id('water');

  let n = 0;

  // 1. Level the site.
  n += prepareFoundation(
    sink,
    world,
    normalizeRegion(vec3(centre.x - half - 2, 0, centre.z - half - 2), vec3(centre.x + half + 2, 0, centre.z + half + 2)),
    ground,
    floorId,
  );

  const baseY = ground + 1;
  const wallHeight = Math.max(8, Math.round(size * 0.32));

  // 2. Curtain walls with a walkway and crenellations.
  const outer = normalizeRegion(
    vec3(centre.x - half, baseY, centre.z - half),
    vec3(centre.x + half, baseY + wallHeight - 1, centre.z + half),
  );
  n += walls(sink, outer, wall, 2);

  const walkY = baseY + wallHeight;
  for (let z = centre.z - half; z <= centre.z + half; z++) {
    for (let x = centre.x - half; x <= centre.x + half; x++) {
      const onWall =
        x <= centre.x - half + 1 || x >= centre.x + half - 1 ||
        z <= centre.z - half + 1 || z >= centre.z + half - 1;
      if (!onWall) continue;
      if (sink.set(x, walkY, z, floorId)) n++;
      const rim =
        x === centre.x - half || x === centre.x + half || z === centre.z - half || z === centre.z + half;
      if (rim && (x + z) % 2 === 0) {
        if (sink.set(x, walkY + 1, z, wall)) n++;
        if (sink.set(x, walkY + 2, z, accent)) n++;
      }
    }
  }

  // 3. Corner towers.
  const towerR = Math.max(3, Math.round(size * 0.11));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    n += buildTower(sink, vec3(centre.x + sx * half, baseY, centre.z + sz * half), {
      radius: towerR,
      height: wallHeight + 7,
      style,
    });
  }

  // 4. Gatehouse on the -Z side.
  const gateW = 3;
  for (let dx = -gateW; dx <= gateW; dx++) {
    for (let y = 0; y < 5; y++) {
      if (Math.abs(dx) <= gateW - 1 && y < 4) {
        for (let dz = -1; dz <= 1; dz++)
          if (sink.set(centre.x + dx, baseY + y, centre.z - half + dz, AIR)) n++;
      }
    }
  }
  for (const sx of [-1, 1]) {
    n += buildTower(sink, vec3(centre.x + sx * (gateW + 2), baseY, centre.z - half), {
      radius: 2,
      height: wallHeight + 4,
      style,
    });
  }

  // 5. Keep in the centre.
  const keepR = Math.max(4, Math.round(size * 0.2));
  const keepH = wallHeight + Math.round(size * 0.3);
  const keep = normalizeRegion(
    vec3(centre.x - keepR, baseY, centre.z - keepR),
    vec3(centre.x + keepR, baseY + keepH, centre.z + keepR),
  );
  n += walls(sink, keep, wall, 1);
  // Floors every 5 blocks.
  for (let y = baseY; y <= baseY + keepH; y += 5) {
    n += fill(
      sink,
      normalizeRegion(vec3(keep.min.x + 1, y, keep.min.z + 1), vec3(keep.max.x - 1, y, keep.max.z - 1)),
      floorId,
    );
  }
  // Windows.
  for (let y = baseY + 2; y < baseY + keepH; y += 5) {
    for (let d = -keepR + 2; d <= keepR - 2; d += 3) {
      for (const [x, z] of [
        [centre.x + d, keep.min.z],
        [centre.x + d, keep.max.z],
        [keep.min.x, centre.z + d],
        [keep.max.x, centre.z + d],
      ] as const) {
        if (sink.set(x, y, z, glassId)) n++;
        if (sink.set(x, y + 1, z, glassId)) n++;
      }
    }
  }
  // Pitched roof on the keep.
  const roofTop = baseY + keepH + 1;
  for (let level = 0; level <= keepR; level++) {
    const r = keepR - level;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        if (sink.set(centre.x + dx, roofTop + level, centre.z + dz, roof)) n++;
      }
    }
  }
  if (sink.set(centre.x, roofTop + keepR + 1, centre.z, lightId)) n++;

  // 6. Courtyard detailing — a few outbuildings.
  const slots = 4;
  for (let i = 0; i < slots; i++) {
    const ang = (i / slots) * Math.PI * 2 + rand();
    const rad = half * 0.6;
    const bx = Math.round(centre.x + Math.cos(ang) * rad);
    const bz = Math.round(centre.z + Math.sin(ang) * rad);
    if (Math.abs(bx - centre.x) < keepR + 3 && Math.abs(bz - centre.z) < keepR + 3) continue;
    n += buildHouse(sink, vec3(bx, baseY, bz), { width: 7, depth: 6, height: 4, style: STYLES.rustic });
  }

  // 7. Moat.
  if (moat) {
    const mOuter = half + 4;
    const mInner = half + 1;
    for (let dz = -mOuter; dz <= mOuter; dz++) {
      for (let dx = -mOuter; dx <= mOuter; dx++) {
        const chebyshev = Math.max(Math.abs(dx), Math.abs(dz));
        if (chebyshev > mOuter || chebyshev <= mInner) continue;
        // Leave a causeway to the gate.
        if (Math.abs(dx) <= gateW && dz < 0) continue;
        const x = centre.x + dx;
        const z = centre.z + dz;
        for (let y = ground; y > ground - 4; y--) if (sink.set(x, y, z, AIR)) n++;
        for (let y = ground - 3; y <= ground - 1; y++) if (sink.set(x, y, z, waterId)) n++;
      }
    }
  }

  return n;
}

// --------------------------------------------------------------------- house

export function buildHouse(
  sink: BlockSink,
  base: Vec3,
  options: { width?: number; depth?: number; height?: number; style?: StructureStyle } = {},
): number {
  const { width = 9, depth = 7, height = 5, style = STYLES.rustic } = options;
  const wall = id(style.wall);
  const trim = id(style.trim);
  const floorId = id(style.floor);
  const roof = id(style.roof);
  const glassId = id(style.glass);
  const lightId = id(style.light);
  const hw = Math.floor(width / 2);
  const hd = Math.floor(depth / 2);
  let n = 0;

  const region = normalizeRegion(
    vec3(base.x - hw, base.y, base.z - hd),
    vec3(base.x + hw, base.y + height, base.z + hd),
  );

  // Floor + hollow interior.
  n += fill(sink, { min: region.min, max: vec3(region.max.x, base.y, region.max.z) }, floorId);
  n += fill(
    sink,
    normalizeRegion(vec3(region.min.x + 1, base.y + 1, region.min.z + 1), vec3(region.max.x - 1, base.y + height - 1, region.max.z - 1)),
    AIR,
  );
  // Walls.
  n += walls(sink, { min: vec3(region.min.x, base.y + 1, region.min.z), max: vec3(region.max.x, base.y + height - 1, region.max.z) }, wall, 1);
  // Corner posts.
  for (const [x, z] of [
    [region.min.x, region.min.z], [region.max.x, region.min.z],
    [region.min.x, region.max.z], [region.max.x, region.max.z],
  ] as const) {
    for (let y = base.y + 1; y <= base.y + height - 1; y++) if (sink.set(x, y, z, trim)) n++;
  }
  // Windows and a door.
  const midY = base.y + 2;
  for (let dx = -hw + 2; dx <= hw - 2; dx += 3) {
    if (sink.set(base.x + dx, midY, region.min.z, glassId)) n++;
    if (sink.set(base.x + dx, midY, region.max.z, glassId)) n++;
  }
  for (let y = base.y + 1; y <= base.y + 2; y++) if (sink.set(base.x, y, region.min.z, AIR)) n++;
  if (sink.set(base.x, base.y + height - 1, base.z, lightId)) n++;

  // Gable roof running along X.
  const roofBase = base.y + height;
  for (let level = 0; level <= hd + 1; level++) {
    for (let x = region.min.x - 1; x <= region.max.x + 1; x++) {
      for (const sz of [-1, 1]) {
        const z = base.z + sz * (hd + 1 - level);
        if (sink.set(x, roofBase + level, z, roof)) n++;
      }
    }
  }
  return n;
}

// -------------------------------------------------------------------- bridge

export function buildBridge(
  sink: BlockSink,
  from: Vec3,
  to: Vec3,
  options: { width?: number; style?: StructureStyle; arch?: boolean } = {},
): number {
  const { width = 5, style = STYLES.medieval, arch = true } = options;
  const deck = id(style.floor);
  const rail = id(style.wall);
  const support = id(style.trim);
  let n = 0;

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.max(Math.abs(dx), Math.abs(dz));
  if (length === 0) return 0;
  const hw = Math.floor(width / 2);

  for (let t = 0; t <= length; t++) {
    const p = t / length;
    const x = Math.round(from.x + dx * p);
    const z = Math.round(from.z + dz * p);
    const lift = arch ? Math.round(Math.sin(p * Math.PI) * Math.min(6, length * 0.12)) : 0;
    const y = Math.round(from.y + (to.y - from.y) * p) + lift;

    for (let w = -hw; w <= hw; w++) {
      const px = x + (Math.abs(dx) >= Math.abs(dz) ? 0 : w);
      const pz = z + (Math.abs(dx) >= Math.abs(dz) ? w : 0);
      if (sink.set(px, y, pz, deck)) n++;
      if (Math.abs(w) === hw) {
        if (sink.set(px, y + 1, pz, rail)) n++;
      }
    }
    // Piers every 8 blocks.
    if (t % 8 === 0 && t > 0 && t < length) {
      for (let py = y - 1; py > y - 30; py--) {
        if (sink.get(x, py, z) !== AIR) break;
        if (sink.set(x, py, z, support)) n++;
      }
    }
  }
  return n;
}

// ------------------------------------------------------------------- village

export function buildVillage(
  sink: BlockSink,
  world: World,
  centre: Vec3,
  options: { houses?: number; radius?: number; seed?: number; style?: StructureStyle } = {},
): number {
  const { houses = 8, radius = 40, seed = 3, style = STYLES.rustic } = options;
  const rand = makeRandom(seed);
  const pathId = id('gravel');
  let n = 0;
  const placed: Vec3[] = [];

  for (let i = 0; i < houses * 4 && placed.length < houses; i++) {
    const ang = rand() * Math.PI * 2;
    const dist = 8 + rand() * (radius - 8);
    const x = Math.round(centre.x + Math.cos(ang) * dist);
    const z = Math.round(centre.z + Math.sin(ang) * dist);
    if (placed.some((p) => Math.abs(p.x - x) < 12 && Math.abs(p.z - z) < 12)) continue;
    const ground = world.surfaceAt(x, z);
    if (ground < world.bounds.minY) continue;
    const w = 7 + Math.floor(rand() * 4);
    const d = 6 + Math.floor(rand() * 3);
    const foot = normalizeRegion(vec3(x - w, 0, z - d), vec3(x + w, 0, z + d));
    n += prepareFoundation(sink, world, foot, ground, id(style.floor));
    n += buildHouse(sink, vec3(x, ground + 1, z), {
      width: w,
      depth: d,
      height: 4 + Math.floor(rand() * 2),
      style,
    });
    placed.push(vec3(x, ground, z));
  }

  // Paths radiating from the village centre.
  const hub = vec3(centre.x, world.surfaceAt(centre.x, centre.z), centre.z);
  for (const p of placed) {
    n += line(sink, vec3(hub.x, hub.y, hub.z), vec3(p.x, p.y, p.z), pathId, 1);
  }
  return n;
}

// -------------------------------------------------------------------- misc

export function buildWallStructure(
  sink: BlockSink,
  world: World,
  from: Vec3,
  to: Vec3,
  options: { height?: number; thickness?: number; style?: StructureStyle } = {},
): number {
  const { height = 8, thickness = 3, style = STYLES.medieval } = options;
  const wall = id(style.wall);
  const floorId = id(style.floor);
  let n = 0;
  const points = line({ set: () => false, get: () => 0 } as BlockSink, from, to, 0) === 0 ? [] : [];
  void points;

  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.max(Math.abs(dx), Math.abs(dz));
  const hw = Math.floor(thickness / 2);

  for (let t = 0; t <= length; t++) {
    const p = t / Math.max(1, length);
    const x = Math.round(from.x + dx * p);
    const z = Math.round(from.z + dz * p);
    const ground = world.surfaceAt(x, z);
    for (let w = -hw; w <= hw; w++) {
      const px = Math.abs(dx) >= Math.abs(dz) ? x : x + w;
      const pz = Math.abs(dx) >= Math.abs(dz) ? z + w : z;
      for (let y = ground; y <= ground + height; y++) {
        const block = y === ground + height ? floorId : wall;
        if (sink.set(px, y, pz, block)) n++;
      }
      if (Math.abs(w) === hw && t % 2 === 0) {
        if (sink.set(px, ground + height + 1, pz, wall)) n++;
      }
    }
  }
  return n;
}

export function buildPyramidStructure(
  sink: BlockSink,
  world: World,
  centre: Vec3,
  options: { size?: number; style?: StructureStyle; hollow?: boolean } = {},
): number {
  const style = options.style ?? STYLES.desert;
  const size = options.size ?? 24;
  const ground = world.surfaceAt(centre.x, centre.z);
  return pyramid(sink, vec3(centre.x, ground, centre.z), size, id(style.wall), options.hollow ?? false);
}

export function buildDome(
  sink: BlockSink,
  centre: Vec3,
  radius: number,
  material: string,
  hollow = true,
): number {
  let n = 0;
  n += brush(
    { set: (x, y, z, b) => (y >= centre.y ? sink.set(x, y, z, b) : false), get: (x, y, z) => sink.get(x, y, z) },
    centre,
    'sphere',
    radius,
    id(material),
    { hollow },
  );
  return n;
}
