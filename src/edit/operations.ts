/**
 * Editor operations.
 *
 * Every mutating action in WebWorld — human, keyboard shortcut, or AI — is
 * expressed as one of these pure functions over a `World`. They never touch the
 * renderer or the UI, they don't open their own transactions, and they return
 * the number of blocks affected. Callers wrap them in `history.transaction()`.
 *
 * Keeping the operation set small and total is what lets the AI assistant
 * "compile" prompts into reviewable editor actions instead of opaque geometry.
 */

import { AIR, blockRegistry } from '../world/blocks';
import type { World } from '../world/world';
import {
  iterateRegion,
  normalizeRegion,
  regionSize,
  type Axis,
  type BlockId,
  type BrushShape,
  type Region,
  type Vec3,
  vec3,
} from '../core/types';

/** A block write that has not been committed — used for previews. */
export interface PendingBlock {
  x: number;
  y: number;
  z: number;
  id: BlockId;
}

/**
 * Sink abstraction: operations write through this so the exact same code path
 * can either mutate the world or accumulate a preview.
 */
export interface BlockSink {
  set(x: number, y: number, z: number, id: BlockId): boolean;
  get(x: number, y: number, z: number): BlockId;
}

export class WorldSink implements BlockSink {
  constructor(private world: World) {}
  set(x: number, y: number, z: number, id: BlockId): boolean {
    return this.world.setBlock(x, y, z, id);
  }
  get(x: number, y: number, z: number): BlockId {
    return this.world.getBlock(x, y, z);
  }
}

export class PreviewSink implements BlockSink {
  readonly blocks: PendingBlock[] = [];
  private map = new Map<string, number>();
  constructor(private world: World, private limit = 400_000) {}
  set(x: number, y: number, z: number, id: BlockId): boolean {
    if (this.blocks.length >= this.limit) return false;
    const key = `${x},${y},${z}`;
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.blocks[existing].id = id;
      return true;
    }
    if (this.world.getBlock(x, y, z) === id) return false;
    this.map.set(key, this.blocks.length);
    this.blocks.push({ x, y, z, id });
    return true;
  }
  get(x: number, y: number, z: number): BlockId {
    const i = this.map.get(`${x},${y},${z}`);
    return i !== undefined ? this.blocks[i].id : this.world.getBlock(x, y, z);
  }
}

// ------------------------------------------------------------------ helpers

/** Deterministic hash-based PRNG so AI previews match what gets applied. */
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

/** 2D value noise with fBm octaves — the backbone of all terrain generators. */
export function makeNoise2D(seed: number): (x: number, z: number) => number {
  const hash = (x: number, z: number): number => {
    let h = (x * 374761393 + z * 668265263 + seed * 1442695040888963407) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, z: number): number => {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const xf = smooth(x - xi);
    const zf = smooth(z - zi);
    const a = hash(xi, zi);
    const b = hash(xi + 1, zi);
    const c = hash(xi, zi + 1);
    const d = hash(xi + 1, zi + 1);
    return a + (b - a) * xf + (c - a) * zf + (a - b - c + d) * xf * zf;
  };
  return (x, z) => {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let o = 0; o < 5; o++) {
      sum += value(x * freq, z * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

export function shapeContains(
  shape: BrushShape,
  dx: number,
  dy: number,
  dz: number,
  radius: number,
  height = radius,
): boolean {
  switch (shape) {
    case 'sphere':
      return dx * dx + dy * dy + dz * dz <= (radius + 0.5) * (radius + 0.5);
    case 'cube':
      return Math.abs(dx) <= radius && Math.abs(dy) <= radius && Math.abs(dz) <= radius;
    case 'cylinder':
      return dx * dx + dz * dz <= (radius + 0.5) * (radius + 0.5) && Math.abs(dy) <= height;
  }
}

// --------------------------------------------------------------- operations

export function fill(sink: BlockSink, region: Region, id: BlockId): number {
  let n = 0;
  for (const p of iterateRegion(region)) if (sink.set(p.x, p.y, p.z, id)) n++;
  return n;
}

/** Fills only the shell of the region, leaving the interior untouched. */
export function walls(sink: BlockSink, region: Region, id: BlockId, thickness = 1): number {
  let n = 0;
  for (const p of iterateRegion(region)) {
    const onEdge =
      p.x < region.min.x + thickness ||
      p.x > region.max.x - thickness ||
      p.z < region.min.z + thickness ||
      p.z > region.max.z - thickness;
    if (onEdge && sink.set(p.x, p.y, p.z, id)) n++;
  }
  return n;
}

export function hollowBox(sink: BlockSink, region: Region, id: BlockId, thickness = 1): number {
  let n = 0;
  for (const p of iterateRegion(region)) {
    const onShell =
      p.x < region.min.x + thickness ||
      p.x > region.max.x - thickness ||
      p.y < region.min.y + thickness ||
      p.y > region.max.y - thickness ||
      p.z < region.min.z + thickness ||
      p.z > region.max.z - thickness;
    if (onShell && sink.set(p.x, p.y, p.z, id)) n++;
  }
  return n;
}

export function replace(
  sink: BlockSink,
  region: Region,
  from: BlockId | BlockId[] | 'any-solid' | 'any',
  to: BlockId,
): number {
  const matches = (id: BlockId): boolean => {
    if (from === 'any') return true;
    if (from === 'any-solid') return id !== AIR;
    if (Array.isArray(from)) return from.includes(id);
    return id === from;
  };
  let n = 0;
  for (const p of iterateRegion(region)) {
    const current = sink.get(p.x, p.y, p.z);
    if (matches(current) && sink.set(p.x, p.y, p.z, to)) n++;
  }
  return n;
}

export function brush(
  sink: BlockSink,
  center: Vec3,
  shape: BrushShape,
  radius: number,
  id: BlockId,
  options: { hollow?: boolean; height?: number; replaceOnly?: BlockId } = {},
): number {
  const height = options.height ?? radius;
  const ry = shape === 'cube' ? radius : shape === 'cylinder' ? height : radius;
  let n = 0;
  for (let dy = -ry; dy <= ry; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!shapeContains(shape, dx, dy, dz, radius, height)) continue;
        if (options.hollow) {
          const inner = radius - 1;
          if (inner > 0 && shapeContains(shape, dx, dy, dz, inner, height - 1)) continue;
        }
        const x = center.x + dx;
        const y = center.y + dy;
        const z = center.z + dz;
        if (options.replaceOnly !== undefined && sink.get(x, y, z) !== options.replaceOnly) continue;
        if (sink.set(x, y, z, id)) n++;
      }
    }
  }
  return n;
}

/** 3D Bresenham line. */
export function line(sink: BlockSink, from: Vec3, to: Vec3, id: BlockId, thickness = 0): number {
  const points = linePoints(from, to);
  let n = 0;
  for (const p of points) {
    if (thickness <= 0) {
      if (sink.set(p.x, p.y, p.z, id)) n++;
    } else {
      n += brush(sink, p, 'sphere', thickness, id);
    }
  }
  return n;
}

export function linePoints(from: Vec3, to: Vec3): Vec3[] {
  const points: Vec3[] = [];
  let x = from.x;
  let y = from.y;
  let z = from.z;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const dz = Math.abs(to.z - z);
  const sx = Math.sign(to.x - x);
  const sy = Math.sign(to.y - y);
  const sz = Math.sign(to.z - z);
  const max = Math.max(dx, dy, dz);
  if (max === 0) return [vec3(x, y, z)];

  if (dx >= dy && dx >= dz) {
    let p1 = 2 * dy - dx;
    let p2 = 2 * dz - dx;
    for (let i = 0; i <= dx; i++) {
      points.push(vec3(x, y, z));
      if (p1 >= 0) { y += sy; p1 -= 2 * dx; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dx; }
      p1 += 2 * dy;
      p2 += 2 * dz;
      x += sx;
    }
  } else if (dy >= dx && dy >= dz) {
    let p1 = 2 * dx - dy;
    let p2 = 2 * dz - dy;
    for (let i = 0; i <= dy; i++) {
      points.push(vec3(x, y, z));
      if (p1 >= 0) { x += sx; p1 -= 2 * dy; }
      if (p2 >= 0) { z += sz; p2 -= 2 * dy; }
      p1 += 2 * dx;
      p2 += 2 * dz;
      y += sy;
    }
  } else {
    let p1 = 2 * dy - dz;
    let p2 = 2 * dx - dz;
    for (let i = 0; i <= dz; i++) {
      points.push(vec3(x, y, z));
      if (p1 >= 0) { y += sy; p1 -= 2 * dz; }
      if (p2 >= 0) { x += sx; p2 -= 2 * dz; }
      p1 += 2 * dy;
      p2 += 2 * dx;
      z += sz;
    }
  }
  return points;
}

export function pyramid(sink: BlockSink, base: Vec3, size: number, id: BlockId, hollow = false): number {
  let n = 0;
  for (let level = 0; level <= size; level++) {
    const r = size - level;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (hollow && Math.abs(dx) !== r && Math.abs(dz) !== r && level !== size) continue;
        if (sink.set(base.x + dx, base.y + level, base.z + dz, id)) n++;
      }
    }
  }
  return n;
}

/** Raises or lowers the terrain surface inside a region (sculpting). */
export function sculpt(
  sink: BlockSink,
  world: World,
  center: Vec3,
  radius: number,
  strength: number,
  material: BlockId,
): number {
  let n = 0;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > radius) continue;
      const falloff = Math.cos((dist / radius) * Math.PI * 0.5) ** 2;
      const delta = Math.round(strength * falloff);
      if (delta === 0) continue;
      const x = center.x + dx;
      const z = center.z + dz;
      const surface = world.surfaceAt(x, z);
      if (delta > 0) {
        for (let i = 1; i <= delta; i++) if (sink.set(x, surface + i, z, material)) n++;
      } else {
        for (let i = 0; i < -delta; i++) if (sink.set(x, surface - i, z, AIR)) n++;
      }
    }
  }
  return n;
}

/** Smooths terrain heights inside a region using a box blur over the heightmap. */
export function smoothTerrain(
  sink: BlockSink,
  world: World,
  region: Region,
  iterations = 2,
  material?: BlockId,
): number {
  const size = regionSize(region);
  let heights = new Int32Array(size.x * size.z);
  const surface: BlockId[] = new Array(size.x * size.z);
  for (let z = 0; z < size.z; z++) {
    for (let x = 0; x < size.x; x++) {
      const wx = region.min.x + x;
      const wz = region.min.z + z;
      const h = world.surfaceAt(wx, wz);
      heights[z * size.x + x] = h;
      surface[z * size.x + x] = h >= world.bounds.minY ? world.getBlock(wx, h, wz) : AIR;
    }
  }

  for (let it = 0; it < iterations; it++) {
    const next = new Int32Array(heights);
    for (let z = 1; z < size.z - 1; z++) {
      for (let x = 1; x < size.x - 1; x++) {
        let sum = 0;
        for (let oz = -1; oz <= 1; oz++)
          for (let ox = -1; ox <= 1; ox++) sum += heights[(z + oz) * size.x + (x + ox)];
        next[z * size.x + x] = Math.round(sum / 9);
      }
    }
    heights = next;
  }

  let n = 0;
  for (let z = 0; z < size.z; z++) {
    for (let x = 0; x < size.x; x++) {
      const wx = region.min.x + x;
      const wz = region.min.z + z;
      const target = heights[z * size.x + x];
      const current = world.surfaceAt(wx, wz);
      const mat = material ?? surface[z * size.x + x] ?? AIR;
      if (target > current) {
        for (let y = current + 1; y <= target; y++) if (sink.set(wx, y, wz, mat)) n++;
      } else if (target < current) {
        for (let y = current; y > target; y--) if (sink.set(wx, y, wz, AIR)) n++;
      }
    }
  }
  return n;
}

/** Replaces the top layer of terrain — the "paint biome" primitive. */
export function paintSurface(
  sink: BlockSink,
  world: World,
  region: Region,
  layers: Array<{ id: BlockId; depth: number }>,
): number {
  let n = 0;
  for (let z = region.min.z; z <= region.max.z; z++) {
    for (let x = region.min.x; x <= region.max.x; x++) {
      const surface = world.surfaceAt(x, z);
      if (surface < region.min.y || surface > region.max.y) continue;
      let y = surface;
      for (const layer of layers) {
        for (let d = 0; d < layer.depth; d++, y--) {
          if (y < region.min.y) break;
          if (sink.get(x, y, z) === AIR) continue;
          if (sink.set(x, y, z, layer.id)) n++;
        }
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------- clipboard

export interface Clipboard {
  size: Vec3;
  /** Origin offset relative to the copy anchor, so paste re-centres correctly. */
  origin: Vec3;
  data: Uint16Array;
}

export function copyRegion(world: World, region: Region, anchor?: Vec3): Clipboard {
  const size = regionSize(region);
  const data = new Uint16Array(size.x * size.y * size.z);
  let i = 0;
  for (let y = 0; y < size.y; y++)
    for (let z = 0; z < size.z; z++)
      for (let x = 0; x < size.x; x++)
        data[i++] = world.getBlock(region.min.x + x, region.min.y + y, region.min.z + z);
  const a = anchor ?? region.min;
  return {
    size,
    origin: vec3(region.min.x - a.x, region.min.y - a.y, region.min.z - a.z),
    data,
  };
}

export function pasteClipboard(
  sink: BlockSink,
  clip: Clipboard,
  at: Vec3,
  options: { skipAir?: boolean } = { skipAir: true },
): number {
  const { size, data, origin } = clip;
  let n = 0;
  let i = 0;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const id = data[i++];
        if (id === AIR && options.skipAir !== false) continue;
        if (sink.set(at.x + origin.x + x, at.y + origin.y + y, at.z + origin.z + z, id)) n++;
      }
    }
  }
  return n;
}

/** Rotates the clipboard about the Y axis in 90° steps. */
export function rotateClipboard(clip: Clipboard, steps: number): Clipboard {
  const turns = ((steps % 4) + 4) % 4;
  if (turns === 0) return clip;
  let current = clip;
  for (let t = 0; t < turns; t++) {
    const { size, data, origin } = current;
    const next = new Uint16Array(data.length);
    const nsx = size.z;
    const nsz = size.x;
    for (let y = 0; y < size.y; y++) {
      for (let z = 0; z < size.z; z++) {
        for (let x = 0; x < size.x; x++) {
          const id = data[y * size.x * size.z + z * size.x + x];
          const nx = size.z - 1 - z;
          const nz = x;
          next[y * nsx * nsz + nz * nsx + nx] = id;
        }
      }
    }
    current = {
      size: vec3(nsx, size.y, nsz),
      origin: vec3(-origin.z - size.z + 1, origin.y, origin.x),
      data: next,
    };
  }
  return current;
}

export function mirrorClipboard(clip: Clipboard, axis: Axis): Clipboard {
  const { size, data, origin } = clip;
  const next = new Uint16Array(data.length);
  const at = (x: number, y: number, z: number) => y * size.x * size.z + z * size.x + x;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const sx = axis === 'x' ? size.x - 1 - x : x;
        const sy = axis === 'y' ? size.y - 1 - y : y;
        const sz = axis === 'z' ? size.z - 1 - z : z;
        next[at(x, y, z)] = data[at(sx, sy, sz)];
      }
    }
  }
  return { size, origin, data: next };
}

/** Rotates a region in-place in the world (copy → clear → rotated paste). */
export function rotateRegion(
  world: World,
  sink: BlockSink,
  region: Region,
  steps: number,
): number {
  const clip = copyRegion(world, region);
  const rotated = rotateClipboard(clip, steps);
  fill(sink, region, AIR);
  const centre = vec3(
    Math.floor((region.min.x + region.max.x) / 2),
    region.min.y,
    Math.floor((region.min.z + region.max.z) / 2),
  );
  const at = vec3(
    centre.x - Math.floor(rotated.size.x / 2),
    region.min.y,
    centre.z - Math.floor(rotated.size.z / 2),
  );
  return pasteClipboard(sink, { ...rotated, origin: vec3(0, 0, 0) }, at, { skipAir: false });
}

export function mirrorRegion(world: World, sink: BlockSink, region: Region, axis: Axis): number {
  const clip = copyRegion(world, region);
  const mirrored = mirrorClipboard(clip, axis);
  return pasteClipboard(sink, { ...mirrored, origin: vec3(0, 0, 0) }, region.min, { skipAir: false });
}

/** Stacks the region `count` times along a direction (WorldEdit `//stack`). */
export function stackRegion(
  world: World,
  sink: BlockSink,
  region: Region,
  direction: Vec3,
  count: number,
): number {
  const clip = copyRegion(world, region);
  const size = regionSize(region);
  let n = 0;
  for (let i = 1; i <= count; i++) {
    const at = vec3(
      region.min.x + direction.x * size.x * i,
      region.min.y + direction.y * size.y * i,
      region.min.z + direction.z * size.z * i,
    );
    n += pasteClipboard(sink, { ...clip, origin: vec3(0, 0, 0) }, at, { skipAir: false });
  }
  return n;
}

/** Naive flood fill limited by a budget, used by the bucket/extend tools. */
export function floodFill(
  sink: BlockSink,
  world: World,
  start: Vec3,
  id: BlockId,
  budget = 100_000,
): number {
  const target = world.getBlockV(start);
  if (target === id) return 0;
  const stack: Vec3[] = [start];
  const seen = new Set<string>([`${start.x},${start.y},${start.z}`]);
  let n = 0;
  while (stack.length > 0 && n < budget) {
    const p = stack.pop()!;
    if (sink.get(p.x, p.y, p.z) !== target) continue;
    if (sink.set(p.x, p.y, p.z, id)) n++;
    const neighbours = [
      vec3(p.x + 1, p.y, p.z), vec3(p.x - 1, p.y, p.z),
      vec3(p.x, p.y + 1, p.z), vec3(p.x, p.y - 1, p.z),
      vec3(p.x, p.y, p.z + 1), vec3(p.x, p.y, p.z - 1),
    ];
    for (const nb of neighbours) {
      const key = `${nb.x},${nb.y},${nb.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sink.get(nb.x, nb.y, nb.z) === target) stack.push(nb);
    }
  }
  return n;
}

/** Counts blocks by type in a region — powers the "analyze selection" panel. */
export function countBlocks(world: World, region: Region): Map<BlockId, number> {
  const counts = new Map<BlockId, number>();
  for (const p of iterateRegion(region)) {
    const id = world.getBlockV(p);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function describeCounts(counts: Map<BlockId, number>, limit = 8): string[] {
  return [...counts.entries()]
    .filter(([id]) => id !== AIR)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id, n]) => `${blockRegistry.get(id).name} × ${n.toLocaleString()}`);
}

export { normalizeRegion };
