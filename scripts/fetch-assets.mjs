#!/usr/bin/env node
/**
 * WebWorld asset pipeline.
 *
 * Downloads the official Minecraft client.jar for a chosen version straight from
 * Mojang's piston metadata service, extracts `assets/minecraft/textures/block/*.png`,
 * and packs them into a single power-of-two texture atlas consumed by the renderer.
 *
 *   npm run assets            # interactive: pick from latest releases
 *   npm run assets -- 1.21.1  # explicit version
 *   npm run assets -- --list  # list available versions
 *   npm run assets -- --latest[-snapshot]
 *
 * Output:
 *   public/assets/atlas.png   packed RGBA atlas
 *   public/assets/atlas.json  { version, tile, size, columns, tiles: { name: index } }
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import * as yauzl from 'yauzl-promise';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'assets');
const CACHE = path.join(ROOT, '.cache');
const TILE = 16; // Minecraft block textures are 16x16 (higher-res packs are downsampled)

const log = (...a) => console.log('[assets]', ...a);

async function getManifest() {
  const res = await fetch(MANIFEST);
  if (!res.ok) throw new Error(`version manifest: HTTP ${res.status}`);
  return res.json();
}

async function pickVersion(manifest, argv) {
  if (argv.includes('--latest')) return manifest.latest.release;
  if (argv.includes('--latest-snapshot')) return manifest.latest.snapshot;
  const explicit = argv.find((a) => !a.startsWith('-'));
  if (explicit) return explicit;

  const releases = manifest.versions.filter((v) => v.type === 'release').slice(0, 15);
  console.log('\nRecent Minecraft releases:');
  releases.forEach((v, i) => console.log(`  ${String(i + 1).padStart(2)}. ${v.id}`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nVersion [${manifest.latest.release}]: `)).trim();
  rl.close();
  if (!answer) return manifest.latest.release;
  const asIndex = Number(answer);
  if (Number.isInteger(asIndex) && releases[asIndex - 1]) return releases[asIndex - 1].id;
  return answer;
}

async function download(url, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    const stat = await fs.stat(dest);
    if (stat.size > 0) return dest;
  } catch {}
  log('downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const out = createWriteStream(dest);
  await new Promise((resolve, reject) => {
    res.body.pipeTo(new WritableStream({
      write: (chunk) => new Promise((r) => out.write(chunk, r)),
      close: () => out.end(resolve),
      abort: reject,
    })).catch(reject);
  });
  return dest;
}

/** Nearest-neighbour downsample / crop to TILE x TILE, taking the first animation frame. */
function normalize(png) {
  const src = png;
  const frameH = Math.min(src.height, src.width); // animated textures are vertical strips
  const out = new PNG({ width: TILE, height: TILE });
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / TILE));
      const sy = Math.min(frameH - 1, Math.floor((y * frameH) / TILE));
      const si = (sy * src.width + sx) << 2;
      const di = (y * TILE + x) << 2;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

async function extractBlockTextures(jarPath) {
  const zip = await yauzl.open(jarPath);
  const textures = new Map();
  try {
    for await (const entry of zip) {
      const m = /^assets\/minecraft\/textures\/block\/([a-z0-9_]+)\.png$/.exec(entry.filename);
      if (!m) continue;
      const stream = await entry.openReadStream();
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      try {
        textures.set(m[1], normalize(PNG.sync.read(Buffer.concat(chunks))));
      } catch {
        /* skip malformed / unsupported png */
      }
    }
  } finally {
    await zip.close();
  }
  return textures;
}

function pack(textures) {
  const names = [...textures.keys()].sort();
  const columns = Math.ceil(Math.sqrt(names.length));
  const rows = Math.ceil(names.length / columns);
  const size = { w: columns * TILE, h: rows * TILE };
  const atlas = new PNG({ width: size.w, height: size.h, fill: true });
  const tiles = {};
  names.forEach((name, index) => {
    const cx = (index % columns) * TILE;
    const cy = Math.floor(index / columns) * TILE;
    const src = textures.get(name);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const si = (y * TILE + x) << 2;
        const di = ((cy + y) * size.w + (cx + x)) << 2;
        atlas.data[di] = src.data[si];
        atlas.data[di + 1] = src.data[si + 1];
        atlas.data[di + 2] = src.data[si + 2];
        atlas.data[di + 3] = src.data[si + 3];
      }
    }
    tiles[name] = index;
  });
  return { atlas, tiles, columns, rows, size };
}

async function main() {
  const argv = process.argv.slice(2);
  const manifest = await getManifest();
  if (argv.includes('--list')) {
    manifest.versions.slice(0, 60).forEach((v) => console.log(`${v.type.padEnd(9)} ${v.id}`));
    return;
  }

  const version = await pickVersion(manifest, argv);
  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`unknown Minecraft version "${version}" (try --list)`);

  log('version', version);
  const meta = await (await fetch(entry.url)).json();
  const client = meta.downloads?.client;
  if (!client) throw new Error('this version has no client.jar download');

  const jar = await download(client.url, path.join(CACHE, `client-${version}.jar`));
  log('extracting block textures…');
  const textures = await extractBlockTextures(jar);
  log(`extracted ${textures.size} textures`);
  if (textures.size === 0) throw new Error('no block textures found in jar');

  const { atlas, tiles, columns, size } = pack(textures);
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, 'atlas.png'), PNG.sync.write(atlas));
  await fs.writeFile(
    path.join(OUT, 'atlas.json'),
    JSON.stringify({ version, tile: TILE, columns, width: size.w, height: size.h, tiles }, null, 0),
  );
  log(`wrote public/assets/atlas.png (${size.w}x${size.h}) and atlas.json`);
  log('done — restart the dev server to pick up new textures.');
}

main().catch((err) => {
  console.error('[assets] ' + err.message);
  process.exit(1);
});
