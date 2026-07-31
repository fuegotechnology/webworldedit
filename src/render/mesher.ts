/**
 * Greedy mesher.
 *
 * Runs inside a Web Worker (see `mesh.worker.ts`) but is written as a pure
 * function so it can be unit-tested and reused on the main thread.
 *
 * Input is a 18×18×18 padded voxel volume (a 16³ chunk plus one block of each
 * neighbour) which lets us cull faces against adjacent chunks without any
 * cross-chunk locking. Output is a set of flat typed arrays ready to be uploaded
 * as a `THREE.BufferGeometry`.
 *
 * Algorithm: for each of the 6 face directions we sweep the 16 slices along the
 * face axis, build a mask of visible faces, then merge maximal rectangles
 * (greedy meshing). Faces only merge when block id, ambient-occlusion corners
 * and orientation all match, so lighting stays correct.
 */

export const PAD = 1;
export const PADDED = 18;

export interface MesherBlockInfo {
  /** Atlas tile index per face: [+x, -x, +y, -y, +z, -z]; -1 = untextured. */
  tiles: Int32Array;
  /** Packed sRGB colour per block id. */
  colors: Float32Array; // 3 floats per block
  /** 1 = opaque (culls neighbours), 0 = transparent. */
  opaque: Uint8Array;
  /** 1 = renders in the transparent pass. */
  translucent: Uint8Array;
}

export interface MeshResult {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  tile: Float32Array;
  color: Float32Array;
  ao: Float32Array;
  index: Uint32Array;
  /** Same layout, for translucent blocks (water, glass, leaves). */
  transparent: {
    position: Float32Array;
    normal: Float32Array;
    uv: Float32Array;
    tile: Float32Array;
    color: Float32Array;
    ao: Float32Array;
    index: Uint32Array;
  };
  quadCount: number;
}

/** face → [normal, tangent u, tangent v] in chunk space. */
const FACES: ReadonlyArray<{
  dir: readonly [number, number, number];
  u: readonly [number, number, number];
  v: readonly [number, number, number];
  /** index into MesherBlockInfo.tiles */
  slot: number;
}> = [
  { dir: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], slot: 0 },
  { dir: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], slot: 1 },
  { dir: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], slot: 2 },
  { dir: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], slot: 3 },
  { dir: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], slot: 4 },
  { dir: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], slot: 5 },
];

const SIZE = 16;

const idx = (x: number, y: number, z: number): number =>
  (y + PAD) * PADDED * PADDED + (z + PAD) * PADDED + (x + PAD);

class Buffers {
  position: number[] = [];
  normal: number[] = [];
  uv: number[] = [];
  tile: number[] = [];
  color: number[] = [];
  ao: number[] = [];
  index: number[] = [];
  vertexCount = 0;

  quad(
    corners: [number, number, number][],
    normal: readonly [number, number, number],
    w: number,
    h: number,
    tile: number,
    color: [number, number, number],
    aoCorners: [number, number, number, number],
  ): void {
    const base = this.vertexCount;
    const uvs: [number, number][] = [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ];
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      this.position.push(c[0], c[1], c[2]);
      this.normal.push(normal[0], normal[1], normal[2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
      this.tile.push(tile);
      this.color.push(color[0], color[1], color[2]);
      this.ao.push(aoCorners[i]);
    }
    this.vertexCount += 4;
    // Flip the triangulation when it would produce an AO gradient artefact.
    if (aoCorners[0] + aoCorners[2] > aoCorners[1] + aoCorners[3]) {
      this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      this.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    }
  }

  freeze() {
    return {
      position: new Float32Array(this.position),
      normal: new Float32Array(this.normal),
      uv: new Float32Array(this.uv),
      tile: new Float32Array(this.tile),
      color: new Float32Array(this.color),
      ao: new Float32Array(this.ao),
      index: new Uint32Array(this.index),
    };
  }
}

/** 0..3 occlusion level for a face corner (Minecraft-style smooth lighting). */
function vertexAO(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - (Number(side1) + Number(side2) + Number(corner));
}

export function greedyMesh(volume: Uint16Array, info: MesherBlockInfo): MeshResult {
  const solid = new Uint8Array(PADDED * PADDED * PADDED);
  for (let i = 0; i < volume.length; i++) solid[i] = info.opaque[volume[i]] ?? 0;

  const opaqueBuf = new Buffers();
  const transBuf = new Buffers();
  let quadCount = 0;

  const at = (x: number, y: number, z: number): number => volume[idx(x, y, z)];
  const isSolid = (x: number, y: number, z: number): boolean => solid[idx(x, y, z)] === 1;

  for (const face of FACES) {
    const [dx, dy, dz] = face.dir;
    // Axis along which we sweep slices.
    const axis = dx !== 0 ? 0 : dy !== 0 ? 1 : 2;
    const uAxis = face.u.findIndex((c) => c !== 0);
    const vAxis = face.v.findIndex((c) => c !== 0);
    const uSign = face.u[uAxis];
    const vSign = face.v[vAxis];

    const maskId = new Int32Array(SIZE * SIZE);
    const maskAO = new Int32Array(SIZE * SIZE);
    const maskTrans = new Uint8Array(SIZE * SIZE);

    for (let slice = 0; slice < SIZE; slice++) {
      maskId.fill(0);

      for (let vi = 0; vi < SIZE; vi++) {
        for (let ui = 0; ui < SIZE; ui++) {
          const p = [0, 0, 0];
          p[axis] = slice;
          p[uAxis] = uSign > 0 ? ui : SIZE - 1 - ui;
          p[vAxis] = vSign > 0 ? vi : SIZE - 1 - vi;
          const [x, y, z] = p;

          const id = at(x, y, z);
          if (id === 0) continue;
          const nid = at(x + dx, y + dy, z + dz);
          const translucent = info.translucent[id] === 1;
          // Cull against opaque neighbours; translucent blocks also cull against
          // an identical neighbour (water against water) but not against opaques.
          if (info.opaque[nid] === 1) continue;
          if (translucent && nid === id) continue;

          const m = vi * SIZE + ui;
          maskId[m] = id;
          maskTrans[m] = translucent ? 1 : 0;

          // Ambient occlusion for the 4 corners of this face.
          const nx = x + dx;
          const ny = y + dy;
          const nz = z + dz;
          const uu = [face.u[0], face.u[1], face.u[2]];
          const vv = [face.v[0], face.v[1], face.v[2]];
          let packed = 0;
          const signs: [number, number][] = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ];
          for (let c = 0; c < 4; c++) {
            const [su, sv] = signs[c];
            const s1 = isSolid(nx + uu[0] * su, ny + uu[1] * su, nz + uu[2] * su);
            const s2 = isSolid(nx + vv[0] * sv, ny + vv[1] * sv, nz + vv[2] * sv);
            const co = isSolid(
              nx + uu[0] * su + vv[0] * sv,
              ny + uu[1] * su + vv[1] * sv,
              nz + uu[2] * su + vv[2] * sv,
            );
            packed |= vertexAO(s1, s2, co) << (c * 2);
          }
          maskAO[m] = packed;
        }
      }

      // Merge maximal rectangles over the mask.
      for (let vi = 0; vi < SIZE; vi++) {
        for (let ui = 0; ui < SIZE; ) {
          const m = vi * SIZE + ui;
          const id = maskId[m];
          if (id === 0) {
            ui++;
            continue;
          }
          const ao = maskAO[m];
          let w = 1;
          while (
            ui + w < SIZE &&
            maskId[m + w] === id &&
            maskAO[m + w] === ao
          )
            w++;

          let h = 1;
          outer: while (vi + h < SIZE) {
            for (let k = 0; k < w; k++) {
              const n = (vi + h) * SIZE + ui + k;
              if (maskId[n] !== id || maskAO[n] !== ao) break outer;
            }
            h++;
          }

          // Emit the quad.
          const origin = [0, 0, 0];
          origin[axis] = slice + (face.dir[axis] > 0 ? 1 : 0);
          origin[uAxis] = uSign > 0 ? ui : SIZE - ui;
          origin[vAxis] = vSign > 0 ? vi : SIZE - vi;

          const du = [face.u[0] * w, face.u[1] * w, face.u[2] * w];
          const dv = [face.v[0] * h, face.v[1] * h, face.v[2] * h];

          const c0: [number, number, number] = [origin[0], origin[1], origin[2]];
          const c1: [number, number, number] = [origin[0] + du[0], origin[1] + du[1], origin[2] + du[2]];
          const c2: [number, number, number] = [
            origin[0] + du[0] + dv[0],
            origin[1] + du[1] + dv[1],
            origin[2] + du[2] + dv[2],
          ];
          const c3: [number, number, number] = [origin[0] + dv[0], origin[1] + dv[1], origin[2] + dv[2]];

          const tileIndex = info.tiles[id * 6 + face.slot];
          const color: [number, number, number] = [
            info.colors[id * 3],
            info.colors[id * 3 + 1],
            info.colors[id * 3 + 2],
          ];
          const aoCorners: [number, number, number, number] = [
            ((ao >> 0) & 3) / 3,
            ((ao >> 2) & 3) / 3,
            ((ao >> 4) & 3) / 3,
            ((ao >> 6) & 3) / 3,
          ];

          const target = maskTrans[m] === 1 ? transBuf : opaqueBuf;
          target.quad([c0, c1, c2, c3], face.dir, w, h, tileIndex, color, aoCorners);
          quadCount++;

          for (let dvi = 0; dvi < h; dvi++)
            for (let dui = 0; dui < w; dui++) maskId[(vi + dvi) * SIZE + ui + dui] = 0;

          ui += w;
        }
      }
    }
  }

  const opaque = opaqueBuf.freeze();
  return { ...opaque, transparent: transBuf.freeze(), quadCount };
}
