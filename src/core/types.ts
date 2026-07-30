/** Shared primitive types used across all WebWorld systems. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vAdd = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vEq = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
export const vFloor = (a: Vec3): Vec3 => vec3(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z));
export const vKey = (a: Vec3): string => `${a.x},${a.y},${a.z}`;

/** Axis-aligned integer region, min/max inclusive. */
export interface Region {
  min: Vec3;
  max: Vec3;
}

export function normalizeRegion(a: Vec3, b: Vec3): Region {
  return {
    min: vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)),
    max: vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)),
  };
}

export function regionSize(r: Region): Vec3 {
  return vec3(r.max.x - r.min.x + 1, r.max.y - r.min.y + 1, r.max.z - r.min.z + 1);
}

export function regionVolume(r: Region): number {
  const s = regionSize(r);
  return s.x * s.y * s.z;
}

export function regionContains(r: Region, p: Vec3): boolean {
  return (
    p.x >= r.min.x && p.x <= r.max.x &&
    p.y >= r.min.y && p.y <= r.max.y &&
    p.z >= r.min.z && p.z <= r.max.z
  );
}

export function* iterateRegion(r: Region): Generator<Vec3> {
  for (let y = r.min.y; y <= r.max.y; y++)
    for (let z = r.min.z; z <= r.max.z; z++)
      for (let x = r.min.x; x <= r.max.x; x++) yield vec3(x, y, z);
}

export type BlockId = number;

/** A single block mutation, the atomic unit of the undo journal. */
export interface BlockChange {
  x: number;
  y: number;
  z: number;
  before: BlockId;
  after: BlockId;
}

export type Axis = 'x' | 'y' | 'z';
export type BrushShape = 'sphere' | 'cube' | 'cylinder';

export interface RaycastHit {
  /** Block that was hit. */
  block: Vec3;
  /** Empty neighbour on the hit face — where a new block would be placed. */
  adjacent: Vec3;
  normal: Vec3;
  distance: number;
}
