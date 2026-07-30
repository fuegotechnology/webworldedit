/// <reference lib="webworker" />
/**
 * Mesh worker: receives padded voxel volumes and returns transferable geometry
 * buffers. A pool of these (see `ChunkRenderer`) keeps meshing off the main
 * thread so editing never drops frames.
 */

import { greedyMesh, type MesherBlockInfo, type MeshResult } from './mesher';

interface InitMessage {
  type: 'init';
  info: {
    tiles: Int32Array;
    colors: Float32Array;
    opaque: Uint8Array;
    translucent: Uint8Array;
  };
}

interface MeshMessage {
  type: 'mesh';
  jobId: number;
  key: string;
  volume: Uint16Array;
}

type Incoming = InitMessage | MeshMessage;

let info: MesherBlockInfo | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<Incoming>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    info = msg.info;
    ctx.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'mesh') {
    if (!info) throw new Error('mesh worker used before init');
    const result: MeshResult = greedyMesh(msg.volume, info);
    const transfer: ArrayBufferLike[] = [
      result.position.buffer,
      result.normal.buffer,
      result.uv.buffer,
      result.tile.buffer,
      result.color.buffer,
      result.ao.buffer,
      result.index.buffer,
      result.transparent.position.buffer,
      result.transparent.normal.buffer,
      result.transparent.uv.buffer,
      result.transparent.tile.buffer,
      result.transparent.color.buffer,
      result.transparent.ao.buffer,
      result.transparent.index.buffer,
    ];
    ctx.postMessage(
      { type: 'meshed', jobId: msg.jobId, key: msg.key, result },
      transfer as Transferable[],
    );
  }
};

export {};
