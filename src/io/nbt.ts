/**
 * Minimal NBT reader/writer (Java edition, big-endian), with gzip support via
 * the browser's native `CompressionStream`/`DecompressionStream`.
 *
 * Only what `.schem`/`.schematic` interop needs — but complete enough to round-
 * trip arbitrary tags, including nested compounds and every array type.
 */

export const enum TagType {
  End = 0,
  Byte = 1,
  Short = 2,
  Int = 3,
  Long = 4,
  Float = 5,
  Double = 6,
  ByteArray = 7,
  String = 8,
  List = 9,
  Compound = 10,
  IntArray = 11,
  LongArray = 12,
}

export type NbtValue =
  | number
  | bigint
  | string
  | Int8Array
  | Int32Array
  | BigInt64Array
  | NbtList
  | NbtCompound;

export interface NbtCompound {
  [key: string]: NbtTag;
}

export interface NbtList {
  type: TagType;
  values: NbtValue[];
}

export interface NbtTag {
  type: TagType;
  value: NbtValue;
}

// ------------------------------------------------------------------ reading

class Reader {
  private view: DataView;
  private offset = 0;

  constructor(private buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  byte(): number { return this.view.getInt8(this.offset++); }
  ubyte(): number { return this.view.getUint8(this.offset++); }
  short(): number { const v = this.view.getInt16(this.offset); this.offset += 2; return v; }
  ushort(): number { const v = this.view.getUint16(this.offset); this.offset += 2; return v; }
  int(): number { const v = this.view.getInt32(this.offset); this.offset += 4; return v; }
  long(): bigint { const v = this.view.getBigInt64(this.offset); this.offset += 8; return v; }
  float(): number { const v = this.view.getFloat32(this.offset); this.offset += 4; return v; }
  double(): number { const v = this.view.getFloat64(this.offset); this.offset += 8; return v; }

  string(): string {
    const length = this.ushort();
    const bytes = new Uint8Array(this.buffer, this.offset, length);
    this.offset += length;
    return new TextDecoder('utf-8').decode(bytes);
  }

  byteArray(): Int8Array {
    const length = this.int();
    const out = new Int8Array(this.buffer.slice(this.offset, this.offset + length));
    this.offset += length;
    return out;
  }

  intArray(): Int32Array {
    const length = this.int();
    const out = new Int32Array(length);
    for (let i = 0; i < length; i++) out[i] = this.int();
    return out;
  }

  longArray(): BigInt64Array {
    const length = this.int();
    const out = new BigInt64Array(length);
    for (let i = 0; i < length; i++) out[i] = this.long();
    return out;
  }

  payload(type: TagType): NbtValue {
    switch (type) {
      case TagType.Byte: return this.byte();
      case TagType.Short: return this.short();
      case TagType.Int: return this.int();
      case TagType.Long: return this.long();
      case TagType.Float: return this.float();
      case TagType.Double: return this.double();
      case TagType.ByteArray: return this.byteArray();
      case TagType.String: return this.string();
      case TagType.List: {
        const itemType = this.ubyte() as TagType;
        const length = this.int();
        const values: NbtValue[] = [];
        for (let i = 0; i < length; i++) values.push(this.payload(itemType));
        return { type: itemType, values };
      }
      case TagType.Compound: {
        const compound: NbtCompound = {};
        for (;;) {
          const tagType = this.ubyte() as TagType;
          if (tagType === TagType.End) break;
          const name = this.string();
          compound[name] = { type: tagType, value: this.payload(tagType) };
        }
        return compound;
      }
      case TagType.IntArray: return this.intArray();
      case TagType.LongArray: return this.longArray();
      default:
        throw new Error(`NBT: unsupported tag type ${type}`);
    }
  }
}

const isGzip = (data: Uint8Array): boolean => data[0] === 0x1f && data[1] === 0x8b;
const isZlib = (data: Uint8Array): boolean => data[0] === 0x78;

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const format = isGzip(data) ? 'gzip' : isZlib(data) ? 'deflate' : null;
  if (!format) return data;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress gzip data (DecompressionStream unavailable)');
  }
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function compressGzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface NbtRoot {
  name: string;
  value: NbtCompound;
}

export async function readNbt(input: Uint8Array | ArrayBuffer): Promise<NbtRoot> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  const raw = await decompress(bytes);
  // Copy into a fresh, correctly-offset buffer for DataView safety.
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const reader = new Reader(buffer);
  const type = reader.ubyte() as TagType;
  if (type !== TagType.Compound) throw new Error('NBT: root tag must be a compound');
  const name = reader.string();
  return { name, value: reader.payload(TagType.Compound) as NbtCompound };
}

// ------------------------------------------------------------------ writing

class Writer {
  private chunks: Uint8Array[] = [];
  private scratch = new DataView(new ArrayBuffer(8));

  private push(bytes: number): void {
    this.chunks.push(new Uint8Array(this.scratch.buffer.slice(0, bytes)));
  }

  byte(v: number): void { this.scratch.setInt8(0, v); this.push(1); }
  ubyte(v: number): void { this.scratch.setUint8(0, v); this.push(1); }
  short(v: number): void { this.scratch.setInt16(0, v); this.push(2); }
  ushort(v: number): void { this.scratch.setUint16(0, v); this.push(2); }
  int(v: number): void { this.scratch.setInt32(0, v); this.push(4); }
  long(v: bigint): void { this.scratch.setBigInt64(0, v); this.push(8); }
  float(v: number): void { this.scratch.setFloat32(0, v); this.push(4); }
  double(v: number): void { this.scratch.setFloat64(0, v); this.push(8); }

  raw(bytes: Uint8Array): void { this.chunks.push(bytes); }

  string(v: string): void {
    const bytes = new TextEncoder().encode(v);
    this.ushort(bytes.length);
    this.raw(bytes);
  }

  payload(type: TagType, value: NbtValue): void {
    switch (type) {
      case TagType.Byte: this.byte(value as number); break;
      case TagType.Short: this.short(value as number); break;
      case TagType.Int: this.int(value as number); break;
      case TagType.Long: this.long(value as bigint); break;
      case TagType.Float: this.float(value as number); break;
      case TagType.Double: this.double(value as number); break;
      case TagType.ByteArray: {
        const arr = value as Int8Array;
        this.int(arr.length);
        this.raw(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
        break;
      }
      case TagType.String: this.string(value as string); break;
      case TagType.List: {
        const list = value as NbtList;
        this.ubyte(list.values.length === 0 ? TagType.End : list.type);
        this.int(list.values.length);
        for (const item of list.values) this.payload(list.type, item);
        break;
      }
      case TagType.Compound: {
        const compound = value as NbtCompound;
        for (const [name, tag] of Object.entries(compound)) {
          this.ubyte(tag.type);
          this.string(name);
          this.payload(tag.type, tag.value);
        }
        this.ubyte(TagType.End);
        break;
      }
      case TagType.IntArray: {
        const arr = value as Int32Array;
        this.int(arr.length);
        for (const v of arr) this.int(v);
        break;
      }
      case TagType.LongArray: {
        const arr = value as BigInt64Array;
        this.int(arr.length);
        for (const v of arr) this.long(v);
        break;
      }
      default:
        throw new Error(`NBT: cannot write tag type ${type}`);
    }
  }

  finish(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

export async function writeNbt(root: NbtRoot, gzip = true): Promise<Uint8Array> {
  const writer = new Writer();
  writer.ubyte(TagType.Compound);
  writer.string(root.name);
  writer.payload(TagType.Compound, root.value);
  const bytes = writer.finish();
  return gzip ? compressGzip(bytes) : bytes;
}

// ------------------------------------------------------------------ helpers

export const tag = {
  byte: (value: number): NbtTag => ({ type: TagType.Byte, value }),
  short: (value: number): NbtTag => ({ type: TagType.Short, value }),
  int: (value: number): NbtTag => ({ type: TagType.Int, value }),
  long: (value: bigint): NbtTag => ({ type: TagType.Long, value }),
  string: (value: string): NbtTag => ({ type: TagType.String, value }),
  byteArray: (value: Int8Array): NbtTag => ({ type: TagType.ByteArray, value }),
  intArray: (value: Int32Array): NbtTag => ({ type: TagType.IntArray, value }),
  compound: (value: NbtCompound): NbtTag => ({ type: TagType.Compound, value }),
  list: (type: TagType, values: NbtValue[]): NbtTag => ({ type: TagType.List, value: { type, values } }),
};

/** Safe accessor: `get(root, 'Palette', 'minecraft:stone')`. */
export function get(compound: NbtCompound | undefined, ...path: string[]): NbtTag | undefined {
  let current: NbtCompound | undefined = compound;
  let found: NbtTag | undefined;
  for (const key of path) {
    if (!current) return undefined;
    found = current[key];
    if (!found) return undefined;
    current = found.type === TagType.Compound ? (found.value as NbtCompound) : undefined;
  }
  return found;
}

export const num = (tagValue: NbtTag | undefined, fallback = 0): number =>
  typeof tagValue?.value === 'number' ? tagValue.value : fallback;

export const str = (tagValue: NbtTag | undefined, fallback = ''): string =>
  typeof tagValue?.value === 'string' ? tagValue.value : fallback;
