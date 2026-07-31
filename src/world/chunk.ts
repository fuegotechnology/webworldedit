/**
 * Chunk storage.
 *
 * The world is divided into 16×16×16 sections addressed by integer chunk
 * coordinates. Sections are sparse: a section allocates its 4096-entry
 * `Uint16Array` lazily on first write and drops it again when it becomes empty,
 * so an "infinite" world costs nothing until you build in it.
 */

import { AIR, type BlockRegistry } from './blocks';
import type { BlockId } from '../core/types';

export const CHUNK_SIZE = 16;
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_SIZE;

/** Default vertical extent (in blocks) — matches the 256-tall requirement. */
export const WORLD_MIN_Y = 0;
export const WORLD_MAX_Y = 255;
export const WORLD_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y + 1;

export const chunkKey = (cx: number, cy: number, cz: number): string => `${cx},${cy},${cz}`;

export function parseChunkKey(key: string): [number, number, number] {
  const [x, y, z] = key.split(',');
  return [Number(x), Number(y), Number(z)];
}

export const toChunkCoord = (v: number): number => Math.floor(v / CHUNK_SIZE);
export const toLocalCoord = (v: number): number => ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
export const localIndex = (x: number, y: number, z: number): number =>
  y * CHUNK_AREA + z * CHUNK_SIZE + x;

export class Chunk {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: string;

  /** Lazily allocated dense block array; `null` means fully air. */
  data: Uint16Array | null = null;
  /** Number of non-air blocks — lets us free the array and skip meshing. */
  count = 0;
  /** Bumped on every mutation; the mesher stores the version it consumed. */
  version = 0;
  meshedVersion = -1;

  constructor(cx: number, cy: number, cz: number) {
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.key = chunkKey(cx, cy, cz);
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  get(x: number, y: number, z: number): BlockId {
    return this.data ? this.data[localIndex(x, y, z)] : AIR;
  }

  set(x: number, y: number, z: number, id: BlockId): BlockId {
    const i = localIndex(x, y, z);
    if (!this.data) {
      if (id === AIR) return AIR;
      this.data = new Uint16Array(CHUNK_VOLUME);
    }
    const prev = this.data[i];
    if (prev === id) return prev;
    this.data[i] = id;
    if (prev === AIR && id !== AIR) this.count++;
    else if (prev !== AIR && id === AIR) this.count--;
    this.version++;
    if (this.count === 0) this.data = null;
    return prev;
  }

  fillAll(id: BlockId): void {
    if (id === AIR) {
      this.data = null;
      this.count = 0;
    } else {
      this.data ??= new Uint16Array(CHUNK_VOLUME);
      this.data.fill(id);
      this.count = CHUNK_VOLUME;
    }
    this.version++;
  }

  clone(): Chunk {
    const c = new Chunk(this.cx, this.cy, this.cz);
    c.data = this.data ? new Uint16Array(this.data) : null;
    c.count = this.count;
    c.version = this.version;
    return c;
  }

  /** Palette-compressed serialization used by the JSON project format. */
  serialize(registry: BlockRegistry): { key: string; palette: string[]; rle: number[] } | null {
    if (!this.data) return null;
    const palette: string[] = [];
    const index = new Map<number, number>();
    const rle: number[] = [];
    let run = -1;
    let runLength = 0;
    for (let i = 0; i < CHUNK_VOLUME; i++) {
      const id = this.data[i];
      let p = index.get(id);
      if (p === undefined) {
        p = palette.length;
        index.set(id, p);
        palette.push(registry.get(id).mc);
      }
      if (p === run) runLength++;
      else {
        if (run >= 0) rle.push(run, runLength);
        run = p;
        runLength = 1;
      }
    }
    if (run >= 0) rle.push(run, runLength);
    return { key: this.key, palette, rle };
  }

  static deserialize(
    payload: { key: string; palette: string[]; rle: number[] },
    registry: BlockRegistry,
  ): Chunk {
    const [cx, cy, cz] = parseChunkKey(payload.key);
    const chunk = new Chunk(cx, cy, cz);
    const ids = payload.palette.map((mc) => registry.byMinecraftName(mc)?.id ?? AIR);
    const data = new Uint16Array(CHUNK_VOLUME);
    let i = 0;
    let count = 0;
    for (let r = 0; r < payload.rle.length; r += 2) {
      const id = ids[payload.rle[r]] ?? AIR;
      const len = payload.rle[r + 1];
      if (id !== AIR) {
        data.fill(id, i, i + len);
        count += len;
      }
      i += len;
    }
    chunk.data = count > 0 ? data : null;
    chunk.count = count;
    return chunk;
  }
}
