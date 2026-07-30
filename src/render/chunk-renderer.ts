/**
 * Chunk render system.
 *
 * Owns one `THREE.Mesh` pair (opaque + translucent) per non-empty chunk, a pool
 * of mesh workers, and a priority queue that remeshes chunks nearest the camera
 * first. Chunks outside the streaming radius are unloaded from the GPU but keep
 * their voxel data in the `World`.
 */

import * as THREE from 'three';
import { World } from '../world/world';
import { CHUNK_SIZE, Chunk, parseChunkKey } from '../world/chunk';
import { blockRegistry } from '../world/blocks';
import { buildBlockTileTable, type Atlas } from './atlas';
import { createVoxelMaterial } from './material';
import { PAD, PADDED, type MeshResult } from './mesher';
import MeshWorker from './mesh.worker?worker';

interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  transparent: THREE.Mesh | null;
}

interface Job {
  key: string;
  priority: number;
}

export interface RenderStats {
  chunks: number;
  visibleChunks: number;
  triangles: number;
  pendingJobs: number;
  workers: number;
}

export class ChunkRenderer {
  readonly group = new THREE.Group();
  readonly stats: RenderStats = { chunks: 0, visibleChunks: 0, triangles: 0, pendingJobs: 0, workers: 0 };

  /** Horizontal streaming radius in chunks. */
  viewDistance = 12;

  private world: World;
  private meshes = new Map<string, ChunkMeshes>();
  private opaqueMaterial: THREE.Material;
  private transparentMaterial: THREE.Material;

  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue = new Map<string, Job>();
  private inFlight = new Map<number, string>();
  private jobSeq = 0;
  private ready = false;
  private pendingBoot: string[] = [];

  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();

  constructor(world: World, atlas: Atlas, workerCount = Math.min(4, Math.max(2, (navigator.hardwareConcurrency ?? 4) - 1))) {
    this.world = world;
    this.group.name = 'chunks';
    this.group.matrixAutoUpdate = false;

    this.opaqueMaterial = createVoxelMaterial(atlas, { transparent: false });
    this.transparentMaterial = createVoxelMaterial(atlas, { transparent: true });

    const info = this.buildBlockInfo(atlas);
    for (let i = 0; i < workerCount; i++) {
      const worker = new MeshWorker();
      worker.onmessage = (e) => this.onWorkerMessage(worker, e);
      worker.postMessage({
        type: 'init',
        info: {
          tiles: info.tiles.slice(),
          colors: info.colors.slice(),
          opaque: info.opaque.slice(),
          translucent: info.translucent.slice(),
        },
      });
      this.workers.push(worker);
    }
    this.stats.workers = workerCount;

    world.events.on('chunk:dirty', ({ key }) => this.enqueue(key));
    world.events.on('chunk:removed', ({ key }) => this.disposeChunk(key));
    world.events.on('world:reset', () => this.disposeAll());
  }

  private buildBlockInfo(atlas: Atlas) {
    const n = blockRegistry.blocks.length;
    const tiles = buildBlockTileTable(atlas);
    const colors = new Float32Array(n * 3);
    const opaque = new Uint8Array(n);
    const translucent = new Uint8Array(n);
    const c = new THREE.Color();
    for (const block of blockRegistry.blocks) {
      if (!block) continue;
      c.setHex(block.color, THREE.SRGBColorSpace);
      // Real textures already carry colour; tint only in procedural mode.
      if (atlas.authentic) c.setRGB(1, 1, 1);
      colors[block.id * 3] = c.r;
      colors[block.id * 3 + 1] = c.g;
      colors[block.id * 3 + 2] = c.b;
      opaque[block.id] = blockRegistry.isOpaque(block.id) ? 1 : 0;
      translucent[block.id] = block.id !== 0 && (block.transparent || block.liquid) ? 1 : 0;
    }
    return { tiles, colors, opaque, translucent };
  }

  // ------------------------------------------------------------ scheduling

  /** Queue every currently loaded chunk (used after load/import). */
  rebuildAll(): void {
    for (const key of this.world.chunks.keys()) this.enqueue(key);
  }

  private enqueue(key: string): void {
    if (!this.ready) {
      this.pendingBoot.push(key);
      return;
    }
    if (!this.queue.has(key)) this.queue.set(key, { key, priority: 0 });
    this.pump();
  }

  private onWorkerMessage(worker: Worker, event: MessageEvent): void {
    const msg = event.data as
      | { type: 'ready' }
      | { type: 'meshed'; jobId: number; key: string; result: MeshResult };

    if (msg.type === 'ready') {
      this.idle.push(worker);
      if (!this.ready && this.idle.length === this.workers.length) {
        this.ready = true;
        const boot = this.pendingBoot;
        this.pendingBoot = [];
        for (const key of boot) this.enqueue(key);
        this.rebuildAll();
      }
      this.pump();
      return;
    }

    this.inFlight.delete(msg.jobId);
    this.idle.push(worker);
    this.applyMesh(msg.key, msg.result);
    this.pump();
  }

  private pump(): void {
    while (this.idle.length > 0 && this.queue.size > 0) {
      const key = this.nextKey();
      if (!key) break;
      this.queue.delete(key);
      const chunk = this.world.chunks.get(key);
      if (!chunk || chunk.isEmpty) {
        this.disposeChunk(key);
        continue;
      }
      const worker = this.idle.pop()!;
      const jobId = ++this.jobSeq;
      this.inFlight.set(jobId, key);
      chunk.meshedVersion = chunk.version;
      const volume = this.extractVolume(chunk);
      worker.postMessage({ type: 'mesh', jobId, key, volume }, [volume.buffer]);
    }
    this.stats.pendingJobs = this.queue.size + this.inFlight.size;
  }

  private nextKey(): string | undefined {
    // Cheap "nearest first": pick the queued chunk closest to the camera anchor.
    let best: string | undefined;
    let bestDist = Infinity;
    for (const key of this.queue.keys()) {
      const [cx, cy, cz] = parseChunkKey(key);
      const dx = cx - this.anchor.x;
      const dy = cy - this.anchor.y;
      const dz = cz - this.anchor.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = key;
      }
    }
    return best;
  }

  private anchor = new THREE.Vector3();

  /** Builds the 18³ padded volume for a chunk (chunk + 1 block of neighbours). */
  private extractVolume(chunk: Chunk): Uint16Array {
    const volume = new Uint16Array(PADDED * PADDED * PADDED);
    const ox = chunk.cx * CHUNK_SIZE;
    const oy = chunk.cy * CHUNK_SIZE;
    const oz = chunk.cz * CHUNK_SIZE;

    // Interior: copy straight out of the chunk's dense array.
    if (chunk.data) {
      for (let y = 0; y < CHUNK_SIZE; y++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
          const src = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE;
          const dst = (y + PAD) * PADDED * PADDED + (z + PAD) * PADDED + PAD;
          volume.set(chunk.data.subarray(src, src + CHUNK_SIZE), dst);
        }
      }
    }

    // Shell: 6 faces sampled from the world (cheap — 6 × 16² lookups).
    const put = (x: number, y: number, z: number) => {
      volume[(y + PAD) * PADDED * PADDED + (z + PAD) * PADDED + (x + PAD)] =
        this.world.getBlock(ox + x, oy + y, oz + z);
    };
    for (let a = -1; a <= CHUNK_SIZE; a++) {
      for (let b = -1; b <= CHUNK_SIZE; b++) {
        put(-1, a, b);
        put(CHUNK_SIZE, a, b);
        put(a, -1, b);
        put(a, CHUNK_SIZE, b);
        put(a, b, -1);
        put(a, b, CHUNK_SIZE);
      }
    }
    return volume;
  }

  // ------------------------------------------------------------ geometry

  private applyMesh(key: string, result: MeshResult): void {
    const chunk = this.world.chunks.get(key);
    if (!chunk) {
      this.disposeChunk(key);
      return;
    }
    const [cx, cy, cz] = parseChunkKey(key);
    let entry = this.meshes.get(key);
    if (!entry) {
      entry = { opaque: null, transparent: null };
      this.meshes.set(key, entry);
    }

    entry.opaque = this.updateMesh(entry.opaque, result, this.opaqueMaterial, cx, cy, cz, false);
    entry.transparent = this.updateMesh(
      entry.transparent,
      result.transparent,
      this.transparentMaterial,
      cx,
      cy,
      cz,
      true,
    );

    if (!entry.opaque && !entry.transparent) this.meshes.delete(key);
    this.stats.chunks = this.meshes.size;

    // The chunk changed again while we were meshing — requeue.
    if (chunk.version !== chunk.meshedVersion) this.enqueue(key);
  }

  private updateMesh(
    mesh: THREE.Mesh | null,
    data: { position: Float32Array; normal: Float32Array; uv: Float32Array; tile: Float32Array; color: Float32Array; ao: Float32Array; index: Uint32Array },
    material: THREE.Material,
    cx: number,
    cy: number,
    cz: number,
    transparent: boolean,
  ): THREE.Mesh | null {
    if (data.index.length === 0) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
      }
      return null;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    geometry.setAttribute('tile', new THREE.BufferAttribute(data.tile, 1));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.color, 3));
    geometry.setAttribute('ao', new THREE.BufferAttribute(data.ao, 1));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK_SIZE / 2, CHUNK_SIZE / 2, CHUNK_SIZE / 2),
      CHUNK_SIZE * 0.87,
    );
    geometry.boundingBox = new THREE.Box3(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE),
    );

    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      return mesh;
    }

    const next = new THREE.Mesh(geometry, material);
    next.name = `chunk:${cx},${cy},${cz}:${transparent ? 'T' : 'O'}`;
    next.position.set(cx * CHUNK_SIZE, cy * CHUNK_SIZE, cz * CHUNK_SIZE);
    next.renderOrder = transparent ? 1 : 0;
    next.matrixAutoUpdate = false;
    next.updateMatrix();
    next.frustumCulled = true;
    this.group.add(next);
    return next;
  }

  private disposeChunk(key: string): void {
    const entry = this.meshes.get(key);
    if (!entry) return;
    for (const mesh of [entry.opaque, entry.transparent]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.delete(key);
    this.stats.chunks = this.meshes.size;
  }

  private disposeAll(): void {
    for (const key of [...this.meshes.keys()]) this.disposeChunk(key);
    this.queue.clear();
  }

  // ------------------------------------------------------------ per-frame

  update(camera: THREE.Camera): void {
    this.anchor.set(
      Math.floor(camera.position.x / CHUNK_SIZE),
      Math.floor(camera.position.y / CHUNK_SIZE),
      Math.floor(camera.position.z / CHUNK_SIZE),
    );

    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    const maxDistSq = (this.viewDistance + 1) ** 2;
    let visible = 0;
    let triangles = 0;

    for (const [key, entry] of this.meshes) {
      const [cx, cy, cz] = parseChunkKey(key);
      const dx = cx - this.anchor.x;
      const dz = cz - this.anchor.z;
      const inRange = dx * dx + dz * dz <= maxDistSq;
      for (const mesh of [entry.opaque, entry.transparent]) {
        if (!mesh) continue;
        mesh.visible = inRange;
        if (inRange) {
          visible++;
          triangles += mesh.geometry.index!.count / 3;
        }
      }
      void cy;
    }

    this.stats.visibleChunks = visible;
    this.stats.triangles = triangles;
    this.stats.pendingJobs = this.queue.size + this.inFlight.size;
    this.pump();
  }

  dispose(): void {
    this.disposeAll();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
    this.opaqueMaterial.dispose();
    this.transparentMaterial.dispose();
  }
}
