/**
 * The voxel world: an infinite sparse grid of chunks plus the mutation API that
 * every editing operation funnels through.
 *
 * All writes go through `setBlock`, which records the previous value into the
 * currently open "edit batch". The `EditHistory` turns those batches into undo
 * entries, so no other system needs to know how undo works.
 */

import { EventBus } from '../core/events';
import { AIR, blockRegistry, type BlockRegistry } from './blocks';
import {
  CHUNK_SIZE,
  Chunk,
  chunkKey,
  toChunkCoord,
  toLocalCoord,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
} from './chunk';
import type { BlockChange, BlockId, RaycastHit, Region, Vec3 } from '../core/types';
import { vec3 } from '../core/types';

export interface WorldEvents {
  'chunk:dirty': { key: string; chunk: Chunk };
  'chunk:removed': { key: string };
  'world:reset': void;
}

export interface WorldBounds {
  /** Soft horizontal build limit in blocks (worlds are conceptually infinite). */
  radius: number;
  minY: number;
  maxY: number;
}

export class World {
  readonly events = new EventBus<WorldEvents>();
  readonly registry: BlockRegistry;
  readonly chunks = new Map<string, Chunk>();
  bounds: WorldBounds = { radius: 4096, minY: WORLD_MIN_Y, maxY: WORLD_MAX_Y };

  /** Chunks mutated since the last `flush()`, deduplicated. */
  private dirty = new Set<string>();
  private batch: BlockChange[] | null = null;

  constructor(registry: BlockRegistry = blockRegistry) {
    this.registry = registry;
  }

  // ---------------------------------------------------------------- chunks

  getChunk(cx: number, cy: number, cz: number, create = false): Chunk | undefined {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.chunks.get(key);
    if (!chunk && create) {
      chunk = new Chunk(cx, cy, cz);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get blockCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.count;
    return n;
  }

  inBounds(x: number, y: number, z: number): boolean {
    return (
      y >= this.bounds.minY &&
      y <= this.bounds.maxY &&
      Math.abs(x) <= this.bounds.radius &&
      Math.abs(z) <= this.bounds.radius
    );
  }

  // ---------------------------------------------------------------- blocks

  getBlock(x: number, y: number, z: number): BlockId {
    const chunk = this.chunks.get(chunkKey(toChunkCoord(x), toChunkCoord(y), toChunkCoord(z)));
    if (!chunk || !chunk.data) return AIR;
    return chunk.get(toLocalCoord(x), toLocalCoord(y), toLocalCoord(z));
  }

  getBlockV(p: Vec3): BlockId {
    return this.getBlock(p.x, p.y, p.z);
  }

  isSolid(x: number, y: number, z: number): boolean {
    return this.registry.isSolid(this.getBlock(x, y, z));
  }

  setBlock(x: number, y: number, z: number, id: BlockId): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const cx = toChunkCoord(x);
    const cy = toChunkCoord(y);
    const cz = toChunkCoord(z);
    const chunk = this.getChunk(cx, cy, cz, id !== AIR)!;
    if (!chunk) return false;
    const lx = toLocalCoord(x);
    const ly = toLocalCoord(y);
    const lz = toLocalCoord(z);
    const before = chunk.get(lx, ly, lz);
    if (before === id) return false;
    chunk.set(lx, ly, lz, id);
    this.batch?.push({ x, y, z, before, after: id });
    this.markDirty(cx, cy, cz, lx, ly, lz);
    return true;
  }

  setBlockV(p: Vec3, id: BlockId): boolean {
    return this.setBlock(p.x, p.y, p.z, id);
  }

  /** Applies a recorded change list without re-recording it (used by undo/redo). */
  applyChanges(changes: readonly BlockChange[], direction: 'forward' | 'backward'): void {
    const previous = this.batch;
    this.batch = null;
    for (const c of changes) {
      this.setBlock(c.x, c.y, c.z, direction === 'forward' ? c.after : c.before);
    }
    this.batch = previous;
    this.flush();
  }

  private markDirty(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number): void {
    this.dirty.add(chunkKey(cx, cy, cz));
    // Neighbouring chunks need remeshing when a boundary block changes.
    if (lx === 0) this.dirty.add(chunkKey(cx - 1, cy, cz));
    if (lx === CHUNK_SIZE - 1) this.dirty.add(chunkKey(cx + 1, cy, cz));
    if (ly === 0) this.dirty.add(chunkKey(cx, cy - 1, cz));
    if (ly === CHUNK_SIZE - 1) this.dirty.add(chunkKey(cx, cy + 1, cz));
    if (lz === 0) this.dirty.add(chunkKey(cx, cy, cz - 1));
    if (lz === CHUNK_SIZE - 1) this.dirty.add(chunkKey(cx, cy, cz + 1));
  }

  // ---------------------------------------------------------------- batching

  beginBatch(): void {
    this.batch = [];
  }

  endBatch(): BlockChange[] {
    const changes = this.batch ?? [];
    this.batch = null;
    this.flush();
    return changes;
  }

  /** Notifies listeners (the renderer) about every chunk touched so far. */
  flush(): void {
    if (this.dirty.size === 0) return;
    for (const key of this.dirty) {
      const chunk = this.chunks.get(key);
      if (!chunk || chunk.isEmpty) {
        if (chunk && chunk.isEmpty) this.chunks.delete(key);
        this.events.emit('chunk:removed', { key });
      } else {
        this.events.emit('chunk:dirty', { key, chunk });
      }
    }
    this.dirty.clear();
  }

  clear(): void {
    this.chunks.clear();
    this.dirty.clear();
    this.events.emit('world:reset', undefined);
  }

  // ---------------------------------------------------------------- queries

  /** Highest non-air block at (x, z), or `minY - 1` when the column is empty. */
  heightAt(x: number, z: number): number {
    for (let y = this.bounds.maxY; y >= this.bounds.minY; y--) {
      if (this.getBlock(x, y, z) !== AIR) return y;
    }
    return this.bounds.minY - 1;
  }

  /** Highest *solid* (non-liquid) block at (x, z). */
  surfaceAt(x: number, z: number): number {
    for (let y = this.bounds.maxY; y >= this.bounds.minY; y--) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && this.registry.isSolid(id)) return y;
    }
    return this.bounds.minY - 1;
  }

  /** Bounding region of all non-empty chunks, or null for an empty world. */
  computeBounds(): Region | null {
    if (this.chunks.size === 0) return null;
    const min = vec3(Infinity, Infinity, Infinity);
    const max = vec3(-Infinity, -Infinity, -Infinity);
    for (const c of this.chunks.values()) {
      if (c.isEmpty) continue;
      min.x = Math.min(min.x, c.cx * CHUNK_SIZE);
      min.y = Math.min(min.y, c.cy * CHUNK_SIZE);
      min.z = Math.min(min.z, c.cz * CHUNK_SIZE);
      max.x = Math.max(max.x, c.cx * CHUNK_SIZE + CHUNK_SIZE - 1);
      max.y = Math.max(max.y, c.cy * CHUNK_SIZE + CHUNK_SIZE - 1);
      max.z = Math.max(max.z, c.cz * CHUNK_SIZE + CHUNK_SIZE - 1);
    }
    return Number.isFinite(min.x) ? { min, max } : null;
  }

  /**
   * Amanatides & Woo voxel traversal. Returns the first non-air block hit,
   * along with the empty neighbour on the entry face.
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance = 256): RaycastHit | null {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = Math.sign(direction.x) || 0;
    const stepY = Math.sign(direction.y) || 0;
    const stepZ = Math.sign(direction.z) || 0;

    const tDeltaX = stepX !== 0 ? Math.abs(1 / direction.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / direction.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / direction.z) : Infinity;

    const boundary = (o: number, i: number, step: number) => (step > 0 ? i + 1 - o : o - i);
    let tMaxX = stepX !== 0 ? boundary(origin.x, x, stepX) * tDeltaX : Infinity;
    let tMaxY = stepY !== 0 ? boundary(origin.y, y, stepY) * tDeltaY : Infinity;
    let tMaxZ = stepZ !== 0 ? boundary(origin.z, z, stepZ) * tDeltaZ : Infinity;

    let normal = vec3();
    let t = 0;

    while (t <= maxDistance) {
      if (this.getBlock(x, y, z) !== AIR) {
        return {
          block: vec3(x, y, z),
          adjacent: vec3(x + normal.x, y + normal.y, z + normal.z),
          normal,
          distance: t,
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX;
        t = tMaxX;
        tMaxX += tDeltaX;
        normal = vec3(-stepX, 0, 0);
      } else if (tMaxY < tMaxZ) {
        y += stepY;
        t = tMaxY;
        tMaxY += tDeltaY;
        normal = vec3(0, -stepY, 0);
      } else {
        z += stepZ;
        t = tMaxZ;
        tMaxZ += tDeltaZ;
        normal = vec3(0, 0, -stepZ);
      }
    }
    return null;
  }
}
