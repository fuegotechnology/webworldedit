/**
 * WebWorld verification suite.
 *
 * Covers every headless-testable layer: voxel ops, greedy meshing, world
 * generation, structure generators, the AI prompt compiler, NBT/schematic IO,
 * project serialization, and the DOM-dependent UI layer (via jsdom).
 *
 * The GPU render path itself requires a real browser and is not covered here.
 *
 *   npm test
 */

import { JSDOM } from 'jsdom';

// ---------------------------------------------------------------- DOM shim
const dom = new JSDOM('<!doctype html><html><body><div id="ui-root"></div></body></html>', {
  pretendToBeVisual: true,
});
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.HTMLCanvasElement = dom.window.HTMLCanvasElement;
g.Image = dom.window.Image;
g.requestAnimationFrame = (f: () => void) => setTimeout(f, 16);
g.localStorage = {
  _d: {} as Record<string, string>,
  getItem(k: string) { return this._d[k] ?? null; },
  setItem(k: string, v: string) { this._d[k] = v; },
  removeItem(k: string) { delete this._d[k]; },
};
dom.window.HTMLCanvasElement.prototype.getContext = function () {
  return { fillRect() {}, fillStyle: '', imageSmoothingEnabled: false, drawImage() {} };
} as never;
dom.window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AA';
g.fetch = async () => ({ ok: false });

// ------------------------------------------------------------------ harness
let passed = 0;
let failed = 0;
let suite = '';

const group = (name: string) => { suite = name; console.log(`\n\x1b[1m${name}\x1b[0m`); };
const ok = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { failed++; console.log(`  \x1b[31m✗ ${msg}\x1b[0m  (${suite})`); }
};

async function main() {
  const { World } = await import('../src/world/world');
  const { Chunk } = await import('../src/world/chunk');
  const { blockRegistry } = await import('../src/world/blocks');
  const ops = await import('../src/edit/operations');
  const { WorldSink, fill, brush, replace, line, copyRegion, rotateClipboard, floodFill } = ops;
  const { greedyMesh, PADDED } = await import('../src/render/mesher');
  const { normalizeRegion, vec3 } = await import('../src/core/types');
  const gen = await import('../src/world/generator');
  const { parsePrompt } = await import('../src/ai/parser');
  const structures = await import('../src/ai/structures');

  const stone = blockRegistry.resolve('stone')!.id;
  const oak = blockRegistry.resolve('oak_planks')!.id;
  const glass = blockRegistry.resolve('glass')!.id;

  // ------------------------------------------------------------ voxel core
  group('World & block operations');
  const w = new World();
  const sink = new WorldSink(w);
  ok(fill(sink, normalizeRegion(vec3(0, 0, 0), vec3(31, 15, 31)), stone) === 32 * 16 * 32, 'fill writes exact volume');
  ok(w.getBlock(5, 5, 5) === stone, 'getBlock reads back written value');
  ok(w.chunkCount === 4, `sparse chunk allocation (${w.chunkCount} chunks for 32x16x32)`);
  ok(w.getBlock(999, 999, 999) === 0, 'unallocated space reads as air');

  const hit = w.raycast(vec3(5, 40, 5), vec3(0, -1, 0), 100);
  ok(hit?.block.y === 15, 'DDA raycast hits the top surface');
  ok(hit?.adjacent.y === 16, 'raycast reports the correct placement neighbour');
  ok(w.raycast(vec3(5, 40, 5), vec3(0, 1, 0), 100) === null, 'raycast into empty space misses');

  const b = brush(sink, vec3(60, 60, 60), 'sphere', 5, stone);
  ok(b > 400 && b < 800, `sphere brush r=5 writes a plausible volume (${b})`);
  ok(replace(sink, normalizeRegion(vec3(0, 0, 0), vec3(9, 9, 9)), stone, blockRegistry.resolve('mossy_cobblestone')!.id) === 1000, 'replace swaps exactly the matching blocks');
  ok(line(sink, vec3(100, 70, 100), vec3(120, 70, 100), stone) === 21, 'Bresenham line length is inclusive');

  const w0 = new World();
  const s0 = new WorldSink(w0);
  fill(s0, normalizeRegion(vec3(0, 0, 0), vec3(7, 0, 7)), stone);
  ok(floodFill(s0, w0, vec3(0, 0, 0), oak) === 64, 'flood fill covers the connected region only');

  group('Chunk memory behaviour');
  const wm = new World();
  const sm = new WorldSink(wm);
  sm.set(0, 0, 0, stone);
  const chunk0 = wm.chunks.get('0,0,0')!;
  ok(chunk0.data !== null && chunk0.count === 1, 'chunk allocates lazily on first write');
  sm.set(0, 0, 0, 0);
  ok(chunk0.data === null && chunk0.count === 0, 'chunk frees its array when emptied');

  group('Undo journal');
  w.beginBatch();
  w.setBlock(200, 70, 200, stone);
  const changes = w.endBatch();
  ok(changes.length === 1 && changes[0].before === 0 && changes[0].after === stone, 'batch records before/after deltas');
  w.applyChanges(changes, 'backward');
  ok(w.getBlock(200, 70, 200) === 0, 'reverse-applying a delta restores the prior state');

  const { EditHistory } = await import('../src/edit/history');
  const wh = new World();
  const sh = new WorldSink(wh);
  const hist = new EditHistory(wh);
  hist.transaction('fill', () => fill(sh, normalizeRegion(vec3(0, 0, 0), vec3(4, 4, 4)), stone));
  ok(wh.blockCount === 125, 'transaction commits its writes');
  hist.undo();
  ok(wh.blockCount === 0, 'undo reverts the whole transaction');
  hist.redo();
  ok(wh.blockCount === 125, 'redo re-applies it');
  const depth = hist.entries.length;
  hist.transaction('outer', () => hist.transaction('inner', () => fill(sh, normalizeRegion(vec3(20, 0, 0), vec3(21, 0, 0)), stone)));
  ok(hist.entries.length === depth + 1, 'nested transactions collapse into one undo entry');

  group('Clipboard');
  const clip = copyRegion(w, normalizeRegion(vec3(0, 0, 0), vec3(9, 4, 3)));
  ok(clip.size.x === 10 && clip.size.z === 4, 'copy captures correct dimensions');
  const rot = rotateClipboard(clip, 1);
  ok(rot.size.x === 4 && rot.size.z === 10, 'rotate 90° swaps X/Z extents');
  const rot4 = rotateClipboard(clip, 4);
  ok(rot4.size.x === 10 && rot4.data.every((v, i) => v === clip.data[i]), 'rotating 4× is the identity');
  const mir = ops.mirrorClipboard(ops.mirrorClipboard(clip, 'x'), 'x');
  ok(mir.data.every((v, i) => v === clip.data[i]), 'mirroring twice is the identity');

  // --------------------------------------------------------------- mesher
  group('Greedy mesher');
  const info = {
    tiles: new Int32Array(blockRegistry.blocks.length * 6).fill(0),
    colors: new Float32Array(blockRegistry.blocks.length * 3).fill(1),
    opaque: new Uint8Array(blockRegistry.blocks.length),
    translucent: new Uint8Array(blockRegistry.blocks.length),
  };
  info.opaque[stone] = 1;
  info.translucent[glass] = 1;
  const idx = (x: number, y: number, z: number) => (y + 1) * PADDED * PADDED + (z + 1) * PADDED + (x + 1);

  const v1 = new Uint16Array(PADDED ** 3);
  v1[idx(0, 0, 0)] = stone;
  let m = greedyMesh(v1, info);
  ok(m.quadCount === 6, 'single block emits 6 quads');
  ok(m.index.length === 36, 'single block emits 36 indices (2 tris/face)');

  const v2 = new Uint16Array(PADDED ** 3);
  for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) v2[idx(x, y, z)] = stone;
  m = greedyMesh(v2, info);
  ok(m.quadCount === 6, 'solid 16³ chunk greedily merges to 6 quads');

  const v3 = new Uint16Array(PADDED ** 3);
  for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) for (let x = 0; x < 2; x++) v3[idx(x, y, z)] = stone;
  ok(greedyMesh(v3, info).quadCount === 6, '2×2×2 merges to 6 quads (interior culled)');

  const v4 = new Uint16Array(PADDED ** 3);
  v4[idx(0, 0, 0)] = stone;
  for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    if (x || y || z) v4[idx(x, y, z)] = stone;
  }
  ok(greedyMesh(v4, info).quadCount < 26 * 6, 'neighbour padding culls shared faces');

  const v5 = new Uint16Array(PADDED ** 3);
  v5[idx(0, 0, 0)] = glass;
  m = greedyMesh(v5, info);
  ok(m.index.length === 0 && m.transparent.index.length === 36, 'translucent blocks route to the transparent pass');

  // ----------------------------------------------------------- generators
  group('World generation');
  const w2 = new World();
  const s2 = new WorldSink(w2);
  ok(gen.generateTerrain(s2, normalizeRegion(vec3(-32, 0, -32), vec3(32, 90, 32)), { seed: 1, baseHeight: 64, amplitude: 12 }) > 100000, 'terrain fills a heightmapped volume');
  w2.flush();
  const surf = w2.surfaceAt(0, 0);
  ok(surf > 40 && surf < 90, `surfaceAt finds the terrain top (y=${surf})`);
  ok(gen.generateForest(s2, w2, normalizeRegion(vec3(-32, 0, -32), vec3(32, 120, 32)), { density: 0.05, seed: 2 }) > 500, 'forest plants trees on valid ground');
  ok(gen.generateMountain(s2, w2, vec3(0, 64, 0), { radius: 24, height: 40, seed: 3 }) > 5000, 'mountain raises a massif');
  w2.flush();
  ok(gen.generateRiver(s2, w2, normalizeRegion(vec3(-32, 0, -32), vec3(32, 120, 32)), { width: 5, seed: 4 }) > 500, 'river carves and fills a channel');

  group('Structure generators');
  const w3 = new World();
  const s3 = new WorldSink(w3);
  gen.generateTerrain(s3, normalizeRegion(vec3(-70, 0, -70), vec3(70, 90, 70)), { seed: 9, baseHeight: 64, amplitude: 3 });
  w3.flush();
  ok(structures.buildCastle(s3, w3, vec3(0, 65, 0), { size: 40, seed: 1 }) > 10000, 'castle builds walls, towers, keep and moat');
  w3.flush();
  ok(structures.buildHouse(s3, vec3(100, 65, 100), {}) > 200, 'house builds shell, roof and openings');
  ok(structures.buildVillage(s3, w3, vec3(-40, 65, -40), { houses: 4, radius: 30, seed: 5 }) > 1000, 'village places houses and paths');
  ok(structures.buildTower(s3, vec3(200, 65, 200), { radius: 4, height: 20 }) > 400, 'tower builds a crenellated shaft');

  // Spans must stay gap-free at any angle — the naive axis-snapped
  // perpendicular used to shred diagonals into disconnected strips.
  const deckId = blockRegistry.resolve(structures.STYLES.medieval.floor)!.id;
  const railId = blockRegistry.resolve(structures.STYLES.medieval.wall)!.id;
  const isDeck = (wb: InstanceType<typeof World>, x: number, y: number, z: number) => {
    const v = wb.getBlock(x, y, z);
    return v === deckId || v === railId;
  };
  /** Largest gap along the span's centreline, in blocks. */
  const centrelineGaps = (wb: InstanceType<typeof World>, a: typeof vec3 extends never ? never : ReturnType<typeof vec3>, bpt: ReturnType<typeof vec3>) => {
    const dist = Math.hypot(bpt.x - a.x, bpt.z - a.z);
    let gaps = 0;
    for (let s = 0; s <= Math.ceil(dist); s++) {
      const p = s / Math.ceil(dist);
      const x = Math.round(a.x + (bpt.x - a.x) * p);
      const z = Math.round(a.z + (bpt.z - a.z) * p);
      // Bridges arch, so scan the column rather than a single y.
      let found = false;
      for (let y = a.y - 2; y <= a.y + 12 && !found; y++) if (isDeck(wb, x, y, z)) found = true;
      if (!found) gaps++;
    }
    return gaps;
  };

  for (const [label, target] of [
    ['axis-aligned +X', vec3(60, 70, 0)],
    ['diagonal 45°', vec3(45, 70, 45)],
    ['shallow diagonal', vec3(60, 70, 18)],
    ['negative diagonal', vec3(-40, 70, -40)],
  ] as const) {
    const wb = new World();
    const sb = new WorldSink(wb);
    const start = vec3(0, 70, 0);
    const wrote = structures.buildBridge(sb, start, target, { width: 5, arch: false });
    wb.flush();
    const gaps = centrelineGaps(wb, start, target);
    ok(wrote > 0 && gaps === 0, `bridge ${label} is continuous (${wrote} blocks, ${gaps} gaps)`);
  }

  /**
   * Measures the deck's true walkable width *perpendicular to travel*.
   * This is the assertion that actually pins the diagonal bug: an
   * axis-snapped perpendicular yields ~2.5 blocks on a 45° span even though
   * the total block count still looks plausible.
   */
  const perpendicularWidth = (
    wb: InstanceType<typeof World>,
    a: ReturnType<typeof vec3>,
    bpt: ReturnType<typeof vec3>,
  ): number => {
    const ddx = bpt.x - a.x;
    const ddz = bpt.z - a.z;
    const dist = Math.hypot(ddx, ddz);
    const px = -(ddz / dist);
    const pz = ddx / dist;
    let worst = Infinity;
    for (let s = Math.round(dist * 0.25); s <= Math.round(dist * 0.75); s++) {
      const p = s / dist;
      const cx = a.x + ddx * p;
      const cz = a.z + ddz * p;
      let count = 0;
      for (let k = -6; k <= 6; k += 0.5) {
        if (wb.getBlock(Math.round(cx + px * k), a.y, Math.round(cz + pz * k)) !== 0) count++;
      }
      worst = Math.min(worst, count * 0.5);
    }
    return worst;
  };

  for (const [label, target] of [
    ['axis-aligned', vec3(60, 70, 0)],
    ['45° diagonal', vec3(45, 70, 45)],
    ['shallow diagonal', vec3(60, 70, 18)],
  ] as const) {
    const wb = new World();
    structures.buildBridge(new WorldSink(wb), vec3(0, 70, 0), target, { width: 5, arch: false });
    wb.flush();
    const measured = perpendicularWidth(wb, vec3(0, 70, 0), target);
    ok(measured >= 4, `bridge ${label} keeps its 5-block deck width (measured ${measured.toFixed(1)})`);
  }

  const wwall = new World();
  const swall = new WorldSink(wwall);
  gen.generateTerrain(swall, normalizeRegion(vec3(-50, 0, -50), vec3(50, 90, 50)), { seed: 4, baseHeight: 64, amplitude: 2 });
  wwall.flush();
  ok(structures.buildWallStructure(swall, wwall, vec3(-30, 65, -30), vec3(30, 65, 30), { height: 6 }) > 500, 'diagonal wall follows terrain and builds');

  // ------------------------------------------------------------ AI parser
  group('AI prompt compiler');
  const cases: Array<[string, string]> = [
    ['Build a medieval castle here', 'castle'],
    ['Create a mountain', 'mountain'],
    ['Plant a dense forest', 'forest'],
    ['Replace all stone with mossy cobblestone', 'replace'],
    ['Generate a river', 'river'],
    ['Terraform this into rolling hills', 'hills'],
    ['build a rustic village of 10 houses', 'village'],
    ['dig a large lake here', 'lake'],
    ['flatten this area', 'flatten'],
    ['build a glass dome radius 20', 'dome'],
  ];
  for (const [prompt, expected] of cases) {
    const plan = parsePrompt(prompt, { seed: 1 });
    ok(plan.operations.some((o) => o.op === expected), `"${prompt}" → ${plan.operations.map((o) => o.op).join(', ')}`);
  }
  const rp = parsePrompt('Replace all stone with mossy cobblestone', { seed: 1 }).operations[0] as { from: string; to: string };
  ok(rp.from === 'stone' && rp.to === 'mossy_cobblestone', 'replace extracts both block arguments');
  const unknown = parsePrompt('asdkjhaskdjh qwe', { seed: 1 });
  ok(unknown.operations.length === 0 && unknown.confidence === 0, 'unparseable input yields an empty plan at confidence 0');
  const big = parsePrompt('build a huge castle', { seed: 1 }).operations[0] as { size: number };
  const small = parsePrompt('build a small castle', { seed: 1 }).operations[0] as { size: number };
  ok(big.size > small.size, `size adjectives scale the result (${small.size} → ${big.size})`);

  group('AI plan validation');
  const { validatePlan } = await import('../src/ai/provider');
  ok(validatePlan({ operations: [{ op: 'fill', block: 'stone' }] })?.operations.length === 1, 'valid plan passes');
  ok(validatePlan({ operations: [{ op: 'rm -rf', block: 'x' }] }) === null, 'unknown operation is rejected');
  ok(validatePlan({ operations: [{ op: 'brush', radius: Infinity, block: 'stone', shape: 'sphere' }] })?.operations[0] !== undefined, 'non-finite numbers are stripped, not crashed on');
  ok(validatePlan('nonsense') === null, 'non-object input is rejected');

  // ------------------------------------------------------------------- IO
  group('NBT');
  const { readNbt, writeNbt, tag, TagType } = await import('../src/io/nbt');
  const root = {
    name: 'Test',
    value: {
      Byte: tag.byte(-5), Short: tag.short(300), Int: tag.int(123456),
      Long: tag.long(9007199254740993n), Str: tag.string('héllo ✦ wörld'),
      IA: tag.intArray(new Int32Array([1, -2, 3])), BA: tag.byteArray(new Int8Array([1, -1, 127])),
      L: tag.list(TagType.Int, [1, 2, 3]),
      Nested: tag.compound({ Deep: tag.string('yes') }),
    },
  };
  const bytes = await writeNbt(root, true);
  ok(bytes[0] === 0x1f && bytes[1] === 0x8b, 'output is gzip framed');
  const back = await readNbt(bytes);
  ok(back.name === 'Test', 'root name round-trips');
  ok(back.value.Byte.value === -5 && back.value.Short.value === 300 && back.value.Int.value === 123456, 'integer types round-trip');
  ok(back.value.Long.value === 9007199254740993n, 'long round-trips as bigint without precision loss');
  ok(back.value.Str.value === 'héllo ✦ wörld', 'UTF-8 strings round-trip');
  ok((back.value.IA.value as Int32Array)[1] === -2, 'int arrays round-trip');
  ok(((back.value.Nested.value as Record<string, { value: unknown }>).Deep.value) === 'yes', 'nested compounds round-trip');

  group('Sponge .schem');
  const { writeSchematic, readSchematic } = await import('../src/io/schematic');
  const ws = new World();
  const ss = new WorldSink(ws);
  fill(ss, normalizeRegion(vec3(0, 0, 0), vec3(9, 4, 7)), stone);
  fill(ss, normalizeRegion(vec3(2, 1, 2), vec3(6, 3, 5)), oak);
  ws.setBlock(0, 0, 0, glass);
  ws.flush();
  const schem = await writeSchematic(ws, normalizeRegion(vec3(0, 0, 0), vec3(9, 4, 7)), { name: 'RT' });
  const parsed = await readSchematic(schem.buffer.slice(schem.byteOffset, schem.byteOffset + schem.byteLength) as ArrayBuffer);
  ok(parsed.width === 10 && parsed.height === 5 && parsed.length === 8, 'dimensions round-trip');
  ok(parsed.unknownBlocks.length === 0, 'every exported block re-resolves on import');
  let mismatch = 0;
  let i = 0;
  for (let y = 0; y < 5; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 10; x++) {
    if (parsed.blocks[i++] !== ws.getBlock(x, y, z)) mismatch++;
  }
  ok(mismatch === 0, `all 400 blocks round-trip byte-for-byte (${mismatch} mismatches)`);

  group('Project serialization');
  const chunk = ws.chunks.values().next().value as Chunk;
  const ser = chunk.serialize(ws.registry)!;
  const de = Chunk.deserialize(ser, ws.registry);
  let cm = 0;
  for (let k = 0; k < 4096; k++) if ((de.data?.[k] ?? 0) !== (chunk.data?.[k] ?? 0)) cm++;
  ok(cm === 0, 'chunk palette+RLE round-trips exactly');
  ok(de.count === chunk.count, 'non-air count is preserved');

  const { Selection } = await import('../src/edit/selection');
  const { serializeProject, deserializeProject } = await import('../src/io/project');
  const sel = new Selection();
  sel.set(vec3(0, 0, 0), vec3(4, 4, 4));
  const fakeEditor = { selection: sel, settings: { activeBlock: stone, brushRadius: 5, brushShape: 'sphere', shapeKind: 'sphere', shapeSize: 8, biome: 'plains', gridSnap: 1, showGrid: true }, history: hist, update() {} };
  const fakeCam = { camera: { position: { toArray: () => [1, 2, 3] }, quaternion: { toArray: () => [0, 0, 0, 1] } }, mode: 'fly', moveSpeed: 22 };
  const proj = serializeProject(ws, fakeEditor as never, fakeCam as never, { name: 'T' });
  const json = JSON.parse(JSON.stringify(proj));
  ok(json.chunks.length > 0, `project serializes (${json.chunks.length} chunks, ${JSON.stringify(json).length} bytes)`);
  const wl = new World();
  const el2 = { selection: new Selection(), settings: fakeEditor.settings, history: new EditHistory(wl), update() {} };
  const cl2 = { camera: { position: { fromArray() {} }, quaternion: { fromArray() {} } }, setMode() {}, moveSpeed: 22 };
  const res = deserializeProject(json, wl, el2 as never, cl2 as never);
  ok(wl.blockCount === ws.blockCount, `project round-trips all ${ws.blockCount} blocks`);
  ok(res.warnings.length === 0, 'clean load produces no warnings');

  group('Selection');
  const sel2 = new Selection();
  sel2.set(vec3(9, 4, 9), vec3(0, 0, 0));
  ok(sel2.primary!.min.x === 0 && sel2.primary!.max.x === 9, 'selection normalizes reversed corners');
  sel2.expand(2);
  ok(sel2.primary!.min.x === -2 && sel2.primary!.max.x === 11, 'expand grows on all axes');
  sel2.pushRegion();
  ok(sel2.extra.length === 1 && sel2.primary === null, 'multi-selection banks the primary region');

  // ------------------------------------------------------------------- UI
  group('Atlas & UI');
  const { loadAtlas, buildBlockTileTable } = await import('../src/render/atlas');
  const atlas = await loadAtlas();
  ok(!atlas.authentic, 'falls back to a procedural atlas with no client.jar present');
  ok(Object.keys(atlas.manifest.tiles).length > 50, `procedural atlas covers ${Object.keys(atlas.manifest.tiles).length} textures`);
  ok(atlas.indexOf('nope___') === -1, 'unknown texture names resolve to -1');
  const table = buildBlockTileTable(atlas);
  const grass = blockRegistry.resolve('grass_block')!.id;
  ok(table[grass * 6 + 2] !== table[grass * 6 + 3], 'grass top and bottom map to different tiles');
  ok(table[grass * 6 + 0] === table[grass * 6 + 4], 'grass side faces share one tile');

  const { el, slider, segmented } = await import('../src/ui/dom');
  ok(el('div', { class: 'x', text: 'hi' }, [el('span', { text: 'y' })]).textContent === 'hiy', 'el() composes nodes');
  let sv = 0;
  const sl = slider({ label: 'R', min: 1, max: 10, value: 4, onInput: (v) => (sv = v) });
  const inp = sl.querySelector('input')!;
  inp.value = '7';
  inp.dispatchEvent(new dom.window.Event('input'));
  ok(sv === 7, 'slider reports input changes');
  let segv = '';
  const sg = segmented({ value: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], onChange: (v) => (segv = v) });
  sg.querySelectorAll('button')[1].dispatchEvent(new dom.window.MouseEvent('click'));
  ok(segv === 'b', 'segmented control reports selection');

  const { BlockPalette } = await import('../src/ui/palette');
  let picked: { name: string } | null = null;
  const pal = new BlockPalette({ atlas, onPick: (bl) => (picked = bl) });
  ok(pal.root.querySelectorAll('.block-swatch').length > 50, `palette renders ${pal.root.querySelectorAll('.block-swatch').length} swatches`);
  (pal.root.querySelector('.block-swatch') as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click'));
  ok(picked !== null, 'clicking a swatch fires onPick');
  const search = pal.root.querySelector('input')!;
  search.value = 'mossy';
  search.dispatchEvent(new dom.window.Event('input'));
  const labels = [...pal.root.querySelectorAll('.block-swatch .label')].map((n) => n.textContent!);
  ok(labels.length > 0 && labels.every((l) => l.toLowerCase().includes('moss')), `search filters correctly (${labels.join(', ')})`);

  group('Block registry');
  ok(blockRegistry.resolve('minecraft:oak_log')?.mc === 'oak_log', 'resolves namespaced ids');
  ok(blockRegistry.resolve('Mossy Stone Bricks')?.mc === 'mossy_stone_bricks', 'resolves display names');
  ok(blockRegistry.byMinecraftName('minecraft:stone[foo=bar]')?.mc === 'stone', 'strips block states');
  ok(blockRegistry.search('ore', 'ore').length >= 6, 'category-filtered search works');
  ok(blockRegistry.isOpaque(stone) && !blockRegistry.isOpaque(glass), 'opacity classification is correct');

  // ---------------------------------------------------------------- report
  const total = passed + failed;
  console.log(`\n${'─'.repeat(58)}`);
  if (failed === 0) console.log(`\x1b[32m\x1b[1m  ALL ${total} CHECKS PASSED\x1b[0m`);
  else console.log(`\x1b[31m\x1b[1m  ${failed} of ${total} CHECKS FAILED\x1b[0m`);
  console.log(`${'─'.repeat(58)}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\x1b[31mTest harness crashed:\x1b[0m', err);
  process.exitCode = 1;
});
