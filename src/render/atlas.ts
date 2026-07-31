/**
 * Texture atlas loader.
 *
 * Consumes `public/assets/atlas.{png,json}` produced by `scripts/fetch-assets.mjs`
 * from the official Minecraft client.jar. When the atlas is missing (a fresh
 * clone that hasn't run `npm run assets`) we synthesise a procedural fallback
 * atlas from each block's palette colour so the editor is still fully usable.
 */

import * as THREE from 'three';
import { blockRegistry } from '../world/blocks';

export interface AtlasManifest {
  version: string;
  tile: number;
  columns: number;
  width: number;
  height: number;
  tiles: Record<string, number>;
}

export interface Atlas {
  texture: THREE.Texture;
  manifest: AtlasManifest;
  /** True when real Minecraft textures were loaded. */
  authentic: boolean;
  indexOf(textureName: string | undefined): number;
}

const ATLAS_JSON = 'assets/atlas.json';
const ATLAS_PNG = 'assets/atlas.png';

function makeTexture(image: HTMLImageElement | HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.Texture(image);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/** Builds a flat-colour atlas, one tile per registered block texture name. */
function buildFallback(): { canvas: HTMLCanvasElement; manifest: AtlasManifest } {
  const names = new Set<string>();
  const colorFor = new Map<string, number>();
  for (const block of blockRegistry.blocks) {
    if (!block) continue;
    for (const key of ['all', 'top', 'bottom', 'side'] as const) {
      const t = block.textures[key];
      if (t) {
        names.add(t);
        if (!colorFor.has(t)) colorFor.set(t, block.color);
      }
    }
  }
  const list = [...names].sort();
  const tile = 16;
  const columns = Math.max(1, Math.ceil(Math.sqrt(list.length)));
  const rows = Math.ceil(list.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = columns * tile;
  canvas.height = rows * tile;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tiles: Record<string, number> = {};
  list.forEach((name, i) => {
    const x = (i % columns) * tile;
    const y = Math.floor(i / columns) * tile;
    const base = colorFor.get(name) ?? 0x888888;
    ctx.fillStyle = `#${base.toString(16).padStart(6, '0')}`;
    ctx.fillRect(x, y, tile, tile);
    // Cheap deterministic noise so surfaces read as textured, not flat plastic.
    let seed = 0;
    for (let c = 0; c < name.length; c++) seed = (seed * 31 + name.charCodeAt(c)) >>> 0;
    for (let py = 0; py < tile; py++) {
      for (let px = 0; px < tile; px++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const n = ((seed >>> 16) & 0xff) / 255;
        if (n > 0.72) {
          ctx.fillStyle = `rgba(255,255,255,${(n - 0.72) * 0.35})`;
          ctx.fillRect(x + px, y + py, 1, 1);
        } else if (n < 0.16) {
          ctx.fillStyle = `rgba(0,0,0,${(0.16 - n) * 0.6})`;
          ctx.fillRect(x + px, y + py, 1, 1);
        }
      }
    }
    tiles[name] = i;
  });

  return {
    canvas,
    manifest: { version: 'procedural', tile, columns, width: canvas.width, height: canvas.height, tiles },
  };
}

export async function loadAtlas(): Promise<Atlas> {
  let manifest: AtlasManifest | null = null;
  let texture: THREE.Texture | null = null;
  let authentic = false;

  try {
    const res = await fetch(ATLAS_JSON, { cache: 'no-cache' });
    if (res.ok) {
      manifest = (await res.json()) as AtlasManifest;
      texture = makeTexture(await loadImage(ATLAS_PNG));
      authentic = true;
      console.info(`[atlas] loaded Minecraft ${manifest.version} textures (${Object.keys(manifest.tiles).length} tiles)`);
    }
  } catch {
    /* fall through to procedural atlas */
  }

  if (!manifest || !texture) {
    const fallback = buildFallback();
    manifest = fallback.manifest;
    texture = makeTexture(fallback.canvas);
    console.warn('[atlas] no client.jar atlas found — using procedural colours. Run `npm run assets` for real textures.');
  }

  const tiles = manifest.tiles;
  return {
    texture,
    manifest,
    authentic,
    indexOf: (name) => (name && tiles[name] !== undefined ? tiles[name] : -1),
  };
}

/** Per-block, per-face atlas indices in the layout the mesher expects. */
export function buildBlockTileTable(atlas: Atlas): Int32Array {
  const table = new Int32Array(blockRegistry.blocks.length * 6).fill(-1);
  for (const block of blockRegistry.blocks) {
    if (!block) continue;
    const t = block.textures;
    const side = atlas.indexOf(t.side ?? t.all);
    const top = atlas.indexOf(t.top ?? t.all ?? t.side);
    const bottom = atlas.indexOf(t.bottom ?? t.all ?? t.side);
    const base = block.id * 6;
    table[base + 0] = side; // +x
    table[base + 1] = side; // -x
    table[base + 2] = top; // +y
    table[base + 3] = bottom; // -y
    table[base + 4] = side; // +z
    table[base + 5] = side; // -z
  }
  return table;
}
