/**
 * Sponge Schematic (.schem) import/export, plus legacy MCEdit `.schematic`
 * import.
 *
 * Supports Sponge schematic v2 (root-level fields) and v3 (fields nested under
 * a `Schematic` compound), which between them cover WorldEdit, FAWE, Litematica
 * exports and the schematic sites people actually download from.
 */

import {
  TagType,
  get,
  num,
  readNbt,
  str,
  tag,
  writeNbt,
  type NbtCompound,
  type NbtTag,
} from './nbt';
import { AIR, blockRegistry } from '../world/blocks';
import type { World } from '../world/world';
import type { Region, Vec3 } from '../core/types';
import { regionSize, vec3 } from '../core/types';
import type { Clipboard } from '../edit/operations';

export interface SchematicData {
  width: number;
  height: number;
  length: number;
  /** Block ids in YZX order (Sponge convention). */
  blocks: Uint16Array;
  offset: Vec3;
  /** Names that had no match in our registry. */
  unknownBlocks: string[];
  dataVersion: number;
}

// ------------------------------------------------------------------ varint

/** Sponge stores block data as a varint-encoded palette index stream. */
function decodeVarintArray(data: Int8Array, expected: number): Int32Array {
  const out = new Int32Array(expected);
  let index = 0;
  let i = 0;
  while (i < data.length && index < expected) {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = data[i++] & 0xff;
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) throw new Error('schematic: varint too long');
    }
    out[index++] = value;
  }
  return out;
}

function encodeVarintArray(values: Int32Array): Int8Array {
  const bytes: number[] = [];
  for (const raw of values) {
    let value = raw >>> 0;
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (value !== 0);
  }
  const out = new Int8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] << 24 >> 24;
  return out;
}

// ------------------------------------------------------------------ import

export async function readSchematic(buffer: ArrayBuffer): Promise<SchematicData> {
  const root = await readNbt(buffer);
  let body = root.value;

  // Sponge v3 nests everything under "Schematic".
  const nested = body['Schematic'];
  if (nested && nested.type === TagType.Compound) body = nested.value as NbtCompound;

  const width = num(body['Width']);
  const height = num(body['Height']);
  const length = num(body['Length']);
  if (!width || !height || !length) throw new Error('schematic: missing dimensions');

  const dataVersion = num(body['DataVersion'], 0);
  const expected = width * height * length;
  const unknown = new Set<string>();

  // ---- Sponge v3: Blocks { Palette, Data }
  const blocksContainer = body['Blocks'];
  let paletteTag: NbtTag | undefined;
  let dataTag: NbtTag | undefined;

  if (blocksContainer && blocksContainer.type === TagType.Compound) {
    const inner = blocksContainer.value as NbtCompound;
    paletteTag = inner['Palette'];
    dataTag = inner['Data'];
  } else {
    paletteTag = body['Palette'];
    dataTag = body['BlockData'] ?? body['Blocks'] ?? body['Data'];
  }

  const blocks = new Uint16Array(expected);

  if (paletteTag && paletteTag.type === TagType.Compound && dataTag) {
    // Modern palette-based format.
    const palette = paletteTag.value as NbtCompound;
    const maxIndex = Math.max(0, ...Object.values(palette).map((t) => num(t)));
    const lookup = new Uint16Array(maxIndex + 1);
    for (const [name, indexTag] of Object.entries(palette)) {
      const index = num(indexTag);
      const clean = name.replace(/^minecraft:/, '').replace(/\[.*$/, '');
      const def = blockRegistry.byMinecraftName(clean) ?? blockRegistry.resolve(clean);
      if (!def && clean !== 'air') unknown.add(clean);
      lookup[index] = def?.id ?? AIR;
    }
    const indices = decodeVarintArray(dataTag.value as Int8Array, expected);
    for (let i = 0; i < expected; i++) blocks[i] = lookup[indices[i]] ?? AIR;
  } else {
    // ---- Legacy MCEdit: numeric block ids, no palette. Best-effort mapping.
    const legacy = (body['Blocks']?.value ?? body['BlockData']?.value) as Int8Array | undefined;
    if (!legacy) throw new Error('schematic: no block data found');
    const LEGACY: Record<number, string> = {
      1: 'stone', 2: 'grass_block', 3: 'dirt', 4: 'cobblestone', 5: 'oak_planks',
      7: 'bedrock', 8: 'water', 9: 'water', 10: 'lava', 11: 'lava', 12: 'sand',
      13: 'gravel', 14: 'gold_ore', 15: 'iron_ore', 16: 'coal_ore', 17: 'oak_log',
      18: 'oak_leaves', 20: 'glass', 24: 'sandstone', 35: 'white_wool', 41: 'gold_block',
      42: 'iron_block', 45: 'bricks', 48: 'mossy_cobblestone', 49: 'obsidian',
      57: 'diamond_block', 79: 'ice', 80: 'snow_block', 82: 'clay', 87: 'netherrack',
      89: 'glowstone', 98: 'stone_bricks', 112: 'nether_bricks', 121: 'end_stone',
      155: 'quartz_block', 159: 'terracotta', 168: 'prismarine', 174: 'packed_ice',
    };
    for (let i = 0; i < expected && i < legacy.length; i++) {
      const legacyId = legacy[i] & 0xff;
      if (legacyId === 0) continue;
      const name = LEGACY[legacyId];
      if (!name) {
        unknown.add(`legacy:${legacyId}`);
        blocks[i] = blockRegistry.resolve('stone')!.id;
      } else {
        blocks[i] = blockRegistry.resolve(name)?.id ?? AIR;
      }
    }
  }

  // Offset (v2 "Offset" int array, v3 nested).
  let offset = vec3(0, 0, 0);
  const offsetTag = body['Offset'] ?? get(body, 'Metadata', 'Offset');
  if (offsetTag && offsetTag.type === TagType.IntArray) {
    const arr = offsetTag.value as Int32Array;
    offset = vec3(arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0);
  }

  return {
    width,
    height,
    length,
    blocks,
    offset,
    unknownBlocks: [...unknown],
    dataVersion,
  };
}

/** Converts imported schematic data into an editor clipboard. */
export function schematicToClipboard(data: SchematicData): Clipboard {
  return {
    size: vec3(data.width, data.height, data.length),
    origin: vec3(0, 0, 0),
    data: data.blocks,
  };
}

/** Pastes a schematic straight into the world at `at`. */
export function schematicToWorld(
  data: SchematicData,
  world: World,
  at: Vec3,
  skipAir = true,
): number {
  let n = 0;
  let i = 0;
  for (let y = 0; y < data.height; y++) {
    for (let z = 0; z < data.length; z++) {
      for (let x = 0; x < data.width; x++) {
        const id = data.blocks[i++];
        if (id === AIR && skipAir) continue;
        if (world.setBlock(at.x + x, at.y + y, at.z + z, id)) n++;
      }
    }
  }
  world.flush();
  return n;
}

// ------------------------------------------------------------------ export

export interface ExportOptions {
  /** Data version to stamp; defaults to a recent 1.21 value. */
  dataVersion?: number;
  name?: string;
  author?: string;
}

/** Serialises a world region as a Sponge schematic v2 `.schem` (gzipped NBT). */
export async function writeSchematic(
  world: World,
  region: Region,
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const size = regionSize(region);
  if (size.x > 4096 || size.y > 4096 || size.z > 4096) {
    throw new Error('schematic: region too large to export');
  }

  const paletteIndex = new Map<string, number>();
  const paletteCompound: NbtCompound = {};
  const indices = new Int32Array(size.x * size.y * size.z);

  const indexFor = (name: string): number => {
    let index = paletteIndex.get(name);
    if (index === undefined) {
      index = paletteIndex.size;
      paletteIndex.set(name, index);
      paletteCompound[name] = tag.int(index);
    }
    return index;
  };
  indexFor('minecraft:air'); // Sponge convention: air is present in the palette.

  let i = 0;
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const id = world.getBlock(region.min.x + x, region.min.y + y, region.min.z + z);
        const def = blockRegistry.get(id);
        indices[i++] = indexFor(`minecraft:${def.mc}`);
      }
    }
  }

  const body: NbtCompound = {
    Version: tag.int(2),
    DataVersion: tag.int(options.dataVersion ?? 3953),
    Width: tag.short(size.x),
    Height: tag.short(size.y),
    Length: tag.short(size.z),
    Offset: tag.intArray(new Int32Array([region.min.x, region.min.y, region.min.z])),
    PaletteMax: tag.int(paletteIndex.size),
    Palette: tag.compound(paletteCompound),
    BlockData: tag.byteArray(encodeVarintArray(indices)),
    BlockEntities: tag.list(TagType.Compound, []),
    Metadata: tag.compound({
      Name: tag.string(options.name ?? 'WebWorld Export'),
      Author: tag.string(options.author ?? 'WebWorld'),
      Date: tag.long(BigInt(Date.now())),
      WEOffsetX: tag.int(0),
      WEOffsetY: tag.int(0),
      WEOffsetZ: tag.int(0),
    }),
  };

  return writeNbt({ name: 'Schematic', value: body }, true);
}

/** Exports the clipboard rather than a live world region. */
export async function writeClipboardSchematic(
  clip: Clipboard,
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const paletteIndex = new Map<string, number>();
  const paletteCompound: NbtCompound = {};
  const indexFor = (name: string): number => {
    let index = paletteIndex.get(name);
    if (index === undefined) {
      index = paletteIndex.size;
      paletteIndex.set(name, index);
      paletteCompound[name] = tag.int(index);
    }
    return index;
  };
  indexFor('minecraft:air');

  const indices = new Int32Array(clip.data.length);
  for (let i = 0; i < clip.data.length; i++) {
    indices[i] = indexFor(`minecraft:${blockRegistry.get(clip.data[i]).mc}`);
  }

  const body: NbtCompound = {
    Version: tag.int(2),
    DataVersion: tag.int(options.dataVersion ?? 3953),
    Width: tag.short(clip.size.x),
    Height: tag.short(clip.size.y),
    Length: tag.short(clip.size.z),
    Offset: tag.intArray(new Int32Array([0, 0, 0])),
    PaletteMax: tag.int(paletteIndex.size),
    Palette: tag.compound(paletteCompound),
    BlockData: tag.byteArray(encodeVarintArray(indices)),
    BlockEntities: tag.list(TagType.Compound, []),
    Metadata: tag.compound({
      Name: tag.string(options.name ?? 'WebWorld Clipboard'),
      Author: tag.string(options.author ?? 'WebWorld'),
      Date: tag.long(BigInt(Date.now())),
    }),
  };

  return writeNbt({ name: 'Schematic', value: body }, true);
}

/** Reads any supported schematic and reports which format was detected. */
export async function detectAndRead(
  file: File,
): Promise<{ data: SchematicData; format: string }> {
  const buffer = await file.arrayBuffer();
  const data = await readSchematic(buffer);
  const format = file.name.endsWith('.schem')
    ? `Sponge schematic (DataVersion ${data.dataVersion || 'unknown'})`
    : 'Legacy MCEdit schematic';
  void str;
  return { data, format };
}
